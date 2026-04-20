import { z } from "zod/v4";
import { eq, sql, and } from "drizzle-orm";
import { db } from "../db/connection";
import { claim, verifyQueue, entry, entryScore, entrySource } from "../db/schema";
import { callAllLlms, extractJson, type LlmVote } from "../llm/cli";
import { nliScore, type NliScores } from "../llm/nli";
import { fetchSource, selectRelevantChunks, type FetchedSource } from "./source-fetch";
import { checkKgContradiction, type KgContradiction } from "../kg/contradiction";
import { expandWithKgFacts } from "../kg/expand";
import { decomposeClaim } from "./cove";
import { webSearch } from "./web-search";
import { getSpecializedHits } from "./specialized-retrieval";
import { authorityFor } from "./authority";
import { extractClaimYear, isSourceTooOld } from "./time-aware";
import { getCurrentThresholds } from "./calibration";
import { aggregate, type SourceEvidence } from "./aggregator";
import { fingerprint } from "./independence";
import { numericContradicts } from "./numeric";
import { hasNegation, NEGATION_DAMPING } from "./negation";
import { counterSearch } from "./counter-search";
import { qaVerify } from "../llm/docqa";
import { bespokeCheck } from "../llm/bespoke-check";
import { logger } from "../observability/logger";

const VERDICTS = ["verified", "disputed", "unverified"] as const;
type Verdict = (typeof VERDICTS)[number];

interface SourceCheckResult {
  url: string;
  status: FetchedSource["status"];
  scores?: NliScores;
  authority?: number;
  publishedTime?: string;
  /** Exact substring of fetched.text whose NLI drove this source's verdict. */
  citation?: string;
}

interface SubClaimResult {
  statement: string;
  verdict: Verdict;
  certainty: number;
  via: "kg_contradiction" | "source_check" | "unverified";
  scores?: NliScores;
}

export interface VerifyResult {
  verdict: Verdict;
  certainty: number;
  evidence: {
    source: "db_cross_ref" | "kg_contradiction" | "source_check" | "cove" | "llm_jury";
    corroborations?: number;
    contradictions?: number;
    rationale?: string;
    sourceUrls?: string[];
    sourceChecks?: SourceCheckResult[];
    kgConflict?: KgContradiction;
    subClaims?: SubClaimResult[];
    votes?: Array<{ cli: string; verdict: Verdict; certainty: number }>;
  };
}

const judgmentSchema = z.object({
  verdict: z.enum(VERDICTS),
  certainty: z.number().min(0).max(1),
  rationale: z.string().max(1000),
});

const SIMILARITY_THRESHOLD = 0.8;
const CROSS_REF_MIN_CORROBORATIONS = 3;

// NLI thresholds. Default 0.7 (conventional FEVER cutoff) but the
// auto-calibration worker overrides these in `calibration_state`
// based on observed agreement between source_check + KG + jury.
// `getCurrentThresholds()` is cached per minute so the cost is one
// DB read per verify batch.
const SOURCE_CHECK_MAX_URLS = 5;

/**
 * Verify a single factual claim.
 *
 * Strategy (follows DESIGN.md v0.3 verification flow with simplified
 * tooling — no live Pyreez deliberation yet):
 *   1. db_cross_ref: find similar verified claims via embedding cosine
 *      distance.  >= MIN corroborations and no contradictions →
 *      verified (medium certainty).
 *   2. LLM judgment: use the multi-CLI fallback layer to adjudicate the
 *      claim using the Entry's sources as context.  Single call today;
 *      swap for Pyreez's real multi-model deliberation once the package
 *      is wired in directly (see DESIGN.md:231 "Pyreez 검증 도구").
 */
export async function verifyClaim(claimId: string): Promise<VerifyResult | null> {
  const [row] = await db
    .select({
      statement: claim.statement,
      entryId: claim.entryId,
      entryCreatedAt: claim.entryCreatedAt,
      embedding: claim.embedding,
    })
    .from(claim)
    .where(eq(claim.id, claimId))
    .limit(1);

  if (!row) return null;

  const crossRef = await dbCrossRef(claimId, row.embedding);
  if (
    crossRef.corroborations >= CROSS_REF_MIN_CORROBORATIONS &&
    crossRef.contradictions === 0
  ) {
    return {
      verdict: "verified",
      certainty: 0.6,
      evidence: {
        source: "db_cross_ref",
        corroborations: crossRef.corroborations,
        contradictions: crossRef.contradictions,
      },
    };
  }

  // KG contradiction check: extract triples from the claim, see if a
  // verified claim ever asserted (subject, predicate, *different
  // object*) for a functional relation. Catches lexical traps the
  // NLI model misses (e.g. "Bun runs on V8" against KG saying
  // "Bun runs_on JSCore"). Free signal — costs one LLM extraction
  // call but skips both source fetch and jury when it fires.
  const kgConflict = await checkKgContradiction(row.statement);
  if (kgConflict && kgConflict.confidence >= 0.7) {
    return {
      verdict: "disputed",
      certainty: kgConflict.confidence,
      evidence: { source: "kg_contradiction", kgConflict },
    };
  }

  const sources = await db
    .select({ url: entrySource.url })
    .from(entrySource)
    .where(
      and(
        eq(entrySource.entryId, row.entryId),
        eq(entrySource.entryCreatedAt, row.entryCreatedAt),
      ),
    );

  const sourceUrls = sources.map((s) => s.url).slice(0, SOURCE_CHECK_MAX_URLS);

  // Source-grounded NLI: fetch each entry source, run DeBERTa-FEVER on
  // the most relevant window. This is the strongest signal available —
  // calibrated entailment probability against the actual cited source,
  // not the LLM's prior knowledge.
  if (sourceUrls.length > 0) {
    const sourceCheck = await runSourceCheck(row.statement, sourceUrls);
    if (sourceCheck) {
      // Counter-search guard: when a verified verdict comes back,
      // try to refute it once before committing. Echo-chamber
      // sources are real (especially for tech blog cargo-cult
      // claims) and a single authoritative contradiction here
      // saves a false positive in production.
      if (sourceCheck.verdict === "verified") {
        const counter = await counterSearch(row.statement);
        if (counter?.triggered) {
          return {
            verdict: "disputed",
            certainty: counter.contradiction,
            evidence: {
              ...sourceCheck.evidence,
              source: "source_check",
              rationale: `counter-search refuted at ${counter.url} (contradiction=${counter.contradiction.toFixed(2)})`,
            },
          };
        }
      }
      return sourceCheck;
    }

    // Source check inconclusive (every chunk neutral or below
    // threshold). Try CoVe: decompose the claim into atomic sub-
    // claims and verify each separately. Lexical traps that fool the
    // monolithic NLI pass usually break apart into one component
    // that clearly fails — e.g. "Bun runs on V8" splits into "Bun
    // is a JS runtime" (entailed) and "Bun's engine is V8" (refuted).
    const cove = await runCoveVerification(row.statement, sourceUrls);
    if (cove) return cove;
  }

  // No usable cited sources (or all inconclusive). Pull external
  // evidence: specialized retrieval (GitHub for code claims, arXiv
  // for research claims) plus SearXNG meta-search. Specialized hits
  // come first because they're directly authoritative on their
  // domain — a GitHub README beats a Medium summary of the same
  // library every time.
  const specialized = await getSpecializedHits(row.statement);
  const web = await webSearch(row.statement);
  // Wider candidate pool than entry-source path: external retrieval
  // is noisier per-source (random web pages vs cited sources), so
  // we accept more candidates to give the Bayesian aggregator
  // enough independent groups to overcome individual misses.
  const externalUrls = [...specialized, ...web]
    .map((r) => r.url)
    .filter((u, i, arr) => arr.indexOf(u) === i)
    .slice(0, 8);
  if (externalUrls.length > 0) {
    const webCheck = await runSourceCheck(row.statement, externalUrls);
    if (webCheck) return webCheck;
    const webCove = await runCoveVerification(row.statement, externalUrls);
    if (webCove) return webCove;
  }

  // Last resort: LLM jury using only URL list (no fetch). Model
  // prior knowledge — least reliable path, kept so unverified is
  // never the silent default.
  const jury = await llmJury(row.statement, sourceUrls);
  if (!jury) return null;
  return jury;
}

/**
 * CoVe wrapper: decompose the claim, verify each sub-claim through
 * KG + source_check, aggregate. Aggregation rule: any disputed sub-
 * claim → parent disputed (single false component breaks the
 * conjunction). All verified → parent verified. Otherwise → null
 * so the caller can fall back to the LLM jury.
 */
async function runCoveVerification(
  statement: string,
  sourceUrls: string[],
): Promise<VerifyResult | null> {
  const subclaims = await decomposeClaim(statement);
  if (subclaims.length === 0) return null;

  const subResults: SubClaimResult[] = [];
  for (const sc of subclaims) {
    const kg = await checkKgContradiction(sc);
    if (kg && kg.confidence >= 0.7) {
      subResults.push({
        statement: sc,
        verdict: "disputed",
        certainty: kg.confidence,
        via: "kg_contradiction",
      });
      continue;
    }
    const sc_check = await runSourceCheck(sc, sourceUrls);
    if (sc_check) {
      subResults.push({
        statement: sc,
        verdict: sc_check.verdict,
        certainty: sc_check.certainty,
        via: "source_check",
        scores: sc_check.evidence.sourceChecks?.[0]?.scores,
      });
    } else {
      subResults.push({
        statement: sc,
        verdict: "unverified",
        certainty: 0,
        via: "unverified",
      });
    }
  }

  const disputed = subResults.filter((s) => s.verdict === "disputed");
  const verified = subResults.filter((s) => s.verdict === "verified");

  // Single disputed sub-claim is sufficient — the original claim's
  // truth requires every component to hold.
  if (disputed.length > 0) {
    const maxCert = Math.max(...disputed.map((d) => d.certainty));
    return {
      verdict: "disputed",
      certainty: maxCert,
      evidence: { source: "cove", subClaims: subResults, sourceUrls },
    };
  }
  // All sub-claims verified: take the lowest certainty as the parent
  // certainty (chain is only as strong as its weakest link).
  if (verified.length === subResults.length) {
    const minCert = Math.min(...verified.map((v) => v.certainty));
    return {
      verdict: "verified",
      certainty: minCert,
      evidence: { source: "cove", subClaims: subResults, sourceUrls },
    };
  }
  // Mixed verified + unverified: not enough evidence to commit.
  return null;
}

/**
 * Fetch each source URL, run NLI against the claim, return a verdict
 * if any source clearly supports or refutes. Returns null when every
 * source is neutral / unfetchable so the caller can fall back to LLM
 * jury.
 */
async function runSourceCheck(
  statement: string,
  urls: string[],
): Promise<VerifyResult | null> {
  const checks: SourceCheckResult[] = [];
  const evidences: Array<SourceEvidence & { fpKey: string }> = [];

  const claimYear = extractClaimYear(statement);
  // Prefix every NLI premise with verified KG facts about the
  // claim's entities. When the chunk text only partially mentions
  // the subject this gives the model the rest of the known graph
  // as direct context. Cost: one LLM triple-extraction call per
  // verify (already done by checkKgContradiction upstream — could
  // be memoized if it becomes a hot path).
  const kgPrefix = await expandWithKgFacts(statement);
  for (const url of urls) {
    const fetched = await fetchSource(url);
    // Halve authority when the source tried prompt injection — a
    // page that attempted to manipulate the verifier is structurally
    // less trustworthy on the underlying topic too. Doesn't reject
    // outright (the surrounding factual content might still be
    // useful) but the Bayesian aggregator will discount it heavily.
    const baseAuthority = authorityFor(url);
    const check: SourceCheckResult = {
      url,
      status: fetched.status,
      authority: fetched.injected ? baseAuthority * 0.5 : baseAuthority,
      publishedTime: fetched.publishedTime,
    };
    // Skip sources that predate the claim's referenced year. They
    // can't substantiate a future event but can cause false
    // contradictions when an old article describes a now-superseded
    // state of the world.
    if (isSourceTooOld(fetched.publishedTime, claimYear)) {
      checks.push({ ...check, status: "blocked_type" });
      continue;
    }
    if (fetched.status === "ok" && fetched.text) {
      const chunks = await selectRelevantChunks(fetched.text, statement);
      // Per-source: take the chunk with the strongest *net* signal.
      // Cross-source aggregation is handled below by the Bayesian
      // aggregator, which combines per-source NLI distributions
      // weighted by authority and damped by independence groups.
      let bestChunk: NliScores = { entailment: 0, neutral: 1, contradiction: 0 };
      let bestNet = -Infinity;
      let bestText = "";
      let numericOverride = false;
      for (const c of chunks) {
        const premise = kgPrefix ? `${kgPrefix}${c}` : c;
        const s = await nliScore(premise, statement);
        // Numeric override: when the claim asserts e.g. "770M" but
        // this chunk says "7B" for the same entity, the chunk is
        // refuting regardless of what NLI says about the surrounding
        // prose. Force max contradiction; preserve the chunk text
        // so the citation surface still shows the offending number.
        const effective = numericContradicts(statement, premise)
          ? { entailment: 0, neutral: 0, contradiction: 1 }
          : s;
        const net = Math.abs(effective.entailment - effective.contradiction);
        if (net > bestNet) {
          bestNet = net;
          bestChunk = effective;
          bestText = c;
          numericOverride = numericContradicts(statement, premise);
        }
      }
      check.scores = bestChunk;
      if (numericOverride) check.status = check.status; // (status unchanged; record kept implicit via scores)
      // Store the winning chunk as citation. Trimmed to one
      // sentence when possible — that's the actual supporting /
      // refuting line worth showing to a reader.
      check.citation = pickCitationSentence(bestText, statement) ?? bestText.slice(0, 400);
      const fp = fingerprint(url, fetched.title ?? "", fetched.text);
      evidences.push({
        scores: bestChunk,
        authority: check.authority ?? 0.5,
        group: -1, // assigned after independence clustering below
        fpKey: `${fp.domain}|${fp.titleNorm}|${fp.simhash.toString()}`,
      });
    }
    checks.push(check);
  }

  if (evidences.length === 0) return null;

  // Cluster evidences into independence groups (domain / title /
  // simhash). independentCount expects SourceFingerprint shape; we
  // only need the grouping side-effect, so re-derive locally.
  const groups: string[][] = [];
  for (const e of evidences) {
    let placed = false;
    for (let i = 0; i < groups.length; i++) {
      if (groups[i]!.includes(e.fpKey)) {
        e.group = i;
        placed = true;
        break;
      }
    }
    if (!placed) {
      e.group = groups.length;
      groups.push([e.fpKey]);
    }
  }

  const agg = aggregate(evidences);

  // Negation damping. NLI flips unreliably on negated claims, so we
  // damp the aggregated certainty before threshold checks; a
  // borderline negated claim should fall through to CoVe / web
  // search rather than commit on weak signal.
  let damped = agg.certainty;
  if (hasNegation(statement)) damped *= NEGATION_DAMPING;

  // Borderline confidence (0.4-0.7) → escalate with two extra
  // verifiers and use majority signal:
  //   1. DocQA: extract answer span from source, compare to claim's
  //      asserted object.
  //   2. Bespoke-MiniCheck-7B: current SOTA on LLM-AggreFact (77.4%
  //      balanced accuracy, beats GPT-4 / Claude-3.5 Sonnet on
  //      grounded fact-checking). Different architecture from NLI
  //      models so it's an independent vote, not just confirmation.
  // When both extra signals agree with NLI we boost certainty;
  // when they split, we damp.
  if (damped >= 0.4 && damped < 0.7 && evidences.length > 0) {
    const topEvidence = evidences.reduce((a, b) =>
      a.scores.entailment > b.scores.entailment ? a : b,
    );
    const topUrl = checks.find((c) => c.scores === topEvidence.scores)?.url;
    const topText = topUrl
      ? checks.find((c) => c.url === topUrl)?.citation ?? ""
      : "";
    if (topText) {
      try {
        const [qa, bespoke] = await Promise.all([
          qaVerify(statement, topText).catch(() => null),
          bespokeCheck(topText, statement).catch(() => null),
        ]);
        let agree = 0;
        let votes = 0;
        const nliSupports = topEvidence.scores.entailment > topEvidence.scores.contradiction;
        if (qa) {
          votes++;
          if (qa.supports === nliSupports) agree++;
        }
        if (bespoke) {
          votes++;
          if (bespoke.supported === nliSupports) agree++;
        }
        if (votes > 0) {
          const agreementRate = agree / votes;
          // 100% agree → +0.15 boost; 0% (unanimous against) → ×0.5
          if (agreementRate === 1) damped = Math.min(0.95, damped + 0.15);
          else if (agreementRate === 0) damped *= 0.5;
          else damped *= 0.85;
        }
      } catch (err) {
        logger.debug({ error: (err as Error).message }, "QA/Bespoke escalation failed");
      }
    }
  }

  const thresholds = await getCurrentThresholds();
  // Honor calibrated thresholds when they're stricter than the
  // posterior cutoffs baked into the aggregator. Calibration drives
  // the verdict floor; aggregator decides direction + magnitude.
  if (agg.verdict === "verified" && damped < thresholds.support) return null;
  if (agg.verdict === "disputed" && damped < thresholds.refute) return null;
  if (agg.verdict === "unverified") return null;

  return {
    verdict: agg.verdict,
    certainty: damped,
    evidence: { source: "source_check", sourceChecks: checks, sourceUrls: urls },
  };
}

/**
 * From a chunk, pick the single sentence with the highest
 * claim-keyword overlap. Returns null when nothing meaningful
 * matches (caller falls back to the chunk prefix). Cheap heuristic
 * — adequate for surfacing a quotable line, not a substitute for
 * NLI on the whole chunk.
 */
function pickCitationSentence(chunk: string, claim: string): string | null {
  const claimTerms = new Set(
    (claim.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).slice(0, 30),
  );
  if (claimTerms.size === 0) return null;
  const sentences = chunk.split(/(?<=[.!?。!?])\s+/);
  let best: { s: string; score: number } | null = null;
  for (const s of sentences) {
    const terms = s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
    let hits = 0;
    for (const t of terms) if (claimTerms.has(t)) hits++;
    const score = hits / Math.max(terms.length, 1);
    if (!best || score > best.score) best = { s, score };
  }
  return best && best.score > 0 ? best.s.trim() : null;
}

async function dbCrossRef(
  claimId: string,
  embedding: number[],
): Promise<{ corroborations: number; contradictions: number }> {
  const vec = `[${embedding.join(",")}]`;
  // Cosine distance: 0 = identical, 2 = opposite. Convert to similarity.
  const neighbors = await db.execute(sql`
    SELECT verdict, 1 - (embedding <=> ${vec}::vector) AS similarity
    FROM claim
    WHERE id <> ${claimId}
      AND verdict IN ('verified', 'disputed')
      AND 1 - (embedding <=> ${vec}::vector) >= ${SIMILARITY_THRESHOLD}
    LIMIT 20
  `);

  let corroborations = 0;
  let contradictions = 0;
  for (const n of neighbors as unknown as Array<{ verdict: string; similarity: number }>) {
    if (n.verdict === "verified") corroborations++;
    else if (n.verdict === "disputed") contradictions++;
  }
  return { corroborations, contradictions };
}

type Judgment = z.infer<typeof judgmentSchema>;

function buildJudgmentPrompt(statement: string, sourceUrls: string[]): string {
  return `You are a fact-verification judge.

Claim: "${statement}"

Sources available (${sourceUrls.length}): ${sourceUrls.join(", ") || "none"}

Assess the claim. Respond with JSON only:
{"verdict":"verified|disputed|unverified","certainty":0.0-1.0,"rationale":"<=200 chars"}

Rules:
- verified: strong evidence supports it
- disputed: evidence contradicts it
- unverified: insufficient evidence either way
- certainty reflects confidence in the verdict, not in the claim being true`;
}

function parseVote(vote: LlmVote): Judgment | null {
  try {
    return judgmentSchema.parse(extractJson(vote.output));
  } catch (err) {
    logger.warn(
      { cli: vote.cli, error: (err as Error).message },
      "jury vote unparseable",
    );
    return null;
  }
}

/**
 * Cross-provider jury: fires every configured CLI in parallel and
 * combines their verdicts. Unanimous verified → high certainty,
 * majority verified → medium certainty, disagreement → disputed,
 * all unverified or no votes → unverified.
 */
async function llmJury(
  statement: string,
  sourceUrls: string[],
): Promise<VerifyResult | null> {
  const prompt = buildJudgmentPrompt(statement, sourceUrls);
  const votes = await callAllLlms(prompt);
  if (votes.length === 0) return null;

  const parsed = votes
    .map((v) => ({ cli: v.cli, j: parseVote(v) }))
    .filter((p): p is { cli: string; j: Judgment } => p.j !== null);
  if (parsed.length === 0) return null;

  const tallies: Record<Verdict, number> = {
    verified: 0,
    disputed: 0,
    unverified: 0,
  };
  let certaintySum = 0;
  for (const p of parsed) {
    tallies[p.j.verdict]++;
    certaintySum += p.j.certainty;
  }
  const certaintyAvg = certaintySum / parsed.length;

  let verdict: Verdict;
  let certainty: number;
  if (tallies.verified === parsed.length && parsed.length >= 2) {
    // Unanimous verified across ≥2 CLIs — highest confidence.
    verdict = "verified";
    certainty = Math.min(0.95, certaintyAvg + 0.1);
  } else if (tallies.disputed === parsed.length && parsed.length >= 2) {
    verdict = "disputed";
    certainty = Math.min(0.95, certaintyAvg + 0.1);
  } else if (tallies.verified > tallies.disputed && tallies.verified > tallies.unverified) {
    verdict = "verified";
    certainty = certaintyAvg * 0.7;
  } else if (tallies.disputed > tallies.verified && tallies.disputed > tallies.unverified) {
    verdict = "disputed";
    certainty = certaintyAvg * 0.7;
  } else if (tallies.verified > 0 && tallies.disputed > 0) {
    // Jurors split on opposite verdicts — inconclusive.
    verdict = "disputed";
    certainty = certaintyAvg * 0.4;
  } else {
    verdict = "unverified";
    certainty = certaintyAvg * 0.5;
  }

  const rationale = parsed
    .map((p) => `[${p.cli}]${p.j.verdict}:${p.j.rationale.slice(0, 100)}`)
    .join(" | ")
    .slice(0, 1000);

  return {
    verdict,
    certainty,
    evidence: {
      source: "llm_jury",
      rationale,
      sourceUrls,
      votes: parsed.map((p) => ({
        cli: p.cli,
        verdict: p.j.verdict,
        certainty: p.j.certainty,
      })),
    },
  };
}

// Single-flight guard. `setInterval` fires every 60s but a full
// batch can take 2-3 minutes, so successive ticks would race on the
// same verify_queue rows — each tick's SELECT (without FOR UPDATE)
// saw rows the prior tick had already dispatched, both workers then
// raced on verifyClaim and the loser hit "claim not found" errors
// after the winner committed + deleted. This flag makes overlapping
// ticks a no-op; the live tick's concurrent batch still fans out
// via Promise.allSettled so throughput is unaffected.
let verifyRunning = false;

/** Process up to `batchSize` claims from the verify queue. */
export async function processVerifyQueue(batchSize = 5): Promise<number> {
  if (verifyRunning) return 0;
  verifyRunning = true;
  try {
    return await processVerifyQueueInner(batchSize);
  } finally {
    verifyRunning = false;
  }
}

async function processVerifyQueueInner(batchSize: number): Promise<number> {
  const now = new Date();
  // FOR UPDATE SKIP LOCKED: even though the single-flight guard
  // prevents overlapping ticks *within* this process, a second app
  // replica or a misbehaving cron would still race on the queue.
  // Row-level locks are cheap and make the batch pick-up atomic.
  const due = (await db.execute(sql`
    SELECT claim_id, attempts
    FROM verify_queue
    WHERE next_attempt_at <= ${now}
      AND attempts < 3
    ORDER BY priority DESC, next_attempt_at
    LIMIT ${batchSize}
    FOR UPDATE SKIP LOCKED
  `)) as unknown as Array<{ claim_id: string; attempts: number }>;
  const dueItems = due.map((r) => ({ claimId: r.claim_id, attempts: r.attempts }));

  // Concurrent batch. Each claim's verify is dominated by network
  // waits (URL fetches, LLM HTTP, SearXNG) — `Promise.allSettled`
  // overlaps those so an N-claim batch finishes in roughly the time
  // of the slowest single claim, not their sum. NLI/reranker model
  // forward passes still serialize on the JS thread, but those are
  // microseconds compared to the seconds-each network waits.
  const results = await Promise.allSettled(
    dueItems.map(async (item) => {
      let result = await verifyClaim(item.claimId);
      if (!result) {
        if (item.attempts < 2) {
          await bumpAttempt(item.claimId);
          return { committed: false };
        }
        // Three exhaustive failures → commit explicit unverified so
        // the claim leaves the queue and the evidence trail records
        // why nothing landed. Without this the claim silently sits
        // at its initial verdict forever.
        result = {
          verdict: "unverified",
          certainty: 0,
          evidence: { source: "llm_jury", rationale: "all paths exhausted" },
        };
      }
      await db.transaction(async (tx) => {
        await tx
          .update(claim)
          .set({
            verdict: result!.verdict,
            certainty: result!.certainty,
            evidence: result!.evidence,
          })
          .where(eq(claim.id, item.claimId));
        await tx.delete(verifyQueue).where(eq(verifyQueue.claimId, item.claimId));
      });
      return { committed: true };
    }),
  );

  let processed = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.status === "fulfilled" && r.value.committed) {
      processed++;
    } else if (r.status === "rejected") {
      logger.warn(
        { claimId: dueItems[i]!.claimId, error: (r.reason as Error).message },
        "verify failed, rescheduling",
      );
      await bumpAttempt(dueItems[i]!.claimId);
    }
  }

  if (processed > 0) {
    logger.info({ processed, batchSize }, "verify queue batch processed");
  }
  return processed;
}

async function bumpAttempt(claimId: string): Promise<void> {
  const backoffMs = 5 * 60 * 1000;
  await db
    .update(verifyQueue)
    .set({
      attempts: sql`${verifyQueue.attempts} + 1`,
      nextAttemptAt: new Date(Date.now() + backoffMs),
    })
    .where(eq(verifyQueue.claimId, claimId));
}

/** Recompute factuality = verified / total factual for an entry. */
export async function updateFactualityScore(
  entryId: string,
  entryCreatedAt: Date,
): Promise<void> {
  const [counts] = await db
    .select({
      total: sql<number>`COUNT(*)::int`,
      verified: sql<number>`SUM(CASE WHEN verdict = 'verified' THEN 1 ELSE 0 END)::int`,
    })
    .from(claim)
    .where(
      and(
        eq(claim.entryId, entryId),
        eq(claim.entryCreatedAt, entryCreatedAt),
        eq(claim.type, "factual"),
      ),
    );

  if (!counts || counts.total === 0) return;
  const factuality = counts.verified / counts.total;

  await db
    .insert(entryScore)
    .values({
      entryId,
      entryCreatedAt,
      dimension: "factuality",
      value: factuality,
      scoredBy: "system",
    })
    .onConflictDoUpdate({
      target: [entryScore.entryId, entryScore.entryCreatedAt, entryScore.dimension],
      set: {
        value: factuality,
        scoredAt: new Date(),
        scoredBy: "system",
      },
    });
}

/** Optional helper: boost verify priority for entries with high authority. */
export async function priorityForEntry(
  entryId: string,
  entryCreatedAt: Date,
): Promise<number> {
  const [row] = await db
    .select({ authority: entry.authority })
    .from(entry)
    .where(and(eq(entry.id, entryId), eq(entry.createdAt, entryCreatedAt)))
    .limit(1);
  // Priority 0-100; higher authority = earlier verification.
  return row ? Math.round(row.authority * 100) : 0;
}

