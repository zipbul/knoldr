import { eq, sql, and } from 'drizzle-orm';
import { ulid } from 'ulid';

import { getDb } from '../db/connection';
import { claim, verifyQueue, entry, entryScore, entrySource } from '../db/schema';
import { checkKgContradiction, type KgContradiction } from '../kg/contradiction';
import { bespokeCheck } from '../llm/bespoke-check';
import { qaVerify } from '../llm/docqa';
import { nliScore, nliScoreLocal, type NliScores } from '../llm/nli';
import { logger } from '../observability/logger';
import { verifyVerdicts, verifyErrors, verifyStageLatency } from '../observability/metrics';
import { ClaimType, EntryScoreDimension, EvidenceSource, RelationType, Verdict, VerdictTrigger } from '../score/enums';
import { aggregate, type SourceEvidence } from './aggregator';
import { authorityFor } from './authority';
import { decomposeClaim } from './cove';
import { fingerprint, type SourceFingerprint } from './independence';
import { hasNegation, NEGATION_DAMPING } from './negation';
// Independence grouping runs via the internal union-find
// (`assignIndependenceGroups` below) over source fingerprints.
import { numericContradicts } from './numeric';
import { writeClaimEdges } from './relation-writer';
import { fetchSource, selectRelevantChunks, type FetchedSource } from './source-fetch';
import { extractClaimYear, isSourceTooOld } from './time-aware';

interface SourceCheckResult {
  url: string;
  status: FetchedSource['status'];
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
  via: EvidenceSource.KgContradiction | EvidenceSource.SourceCheck | Verdict.Unverified;
  scores?: NliScores;
}

interface VerifyResult {
  verdict: Verdict;
  certainty: number;
  evidence: {
    source: EvidenceSource;
    corroborations?: number;
    contradictions?: number;
    rationale?: string;
    sourceUrls?: string[];
    sourceChecks?: SourceCheckResult[];
    kgConflict?: KgContradiction;
    subClaims?: SubClaimResult[];
    // claim_relation edge targets discovered during verify, SCORED:
    // cross-ref edges carry the classifying NLI probability, KG-conflict
    // edges carry kgConflict.confidence. The queue committer writes
    // CONTRADICTS / SUPPORTS rows from these AFTER the verdict commits,
    // so any FK miss can't roll back the commit itself.
    contradicting?: ScoredEdgeTarget[];
    corroborating?: ScoredEdgeTarget[];
  };
}

interface ScoredEdgeTarget {
  id: string;
  score: number;
}

const SIMILARITY_THRESHOLD = 0.8;
// Fixed NLI decision thresholds (FEVER-conventional 0.7). The
// auto-calibration worker that used to tune these was removed — it
// scored thresholds against the pipeline's own verdicts (circular).
// Re-tune manually once golden-set F1 provides a real signal.
const NLI_THRESHOLDS = { support: 0.7, refute: 0.7 } as const;

const SOURCE_CHECK_MAX_URLS = 5;

/**
 * Verify a single factual claim — STRICT GROUNDING.
 *
 * `Verified` ⇔ at least one successful cited-live-source grounding
 * (source_check NLI pass, possibly via CoVe sub-claims over the same
 * cited URLs) AND no KG functional-predicate conflict. Stage order:
 *   1. db_cross_ref: embedding neighbors supply CANDIDATES for
 *      NLI-classified SUPPORTS/CONTRADICTS edge emission only — it
 *      never produces or demotes a verdict.
 *   2. KG contradiction: content-precise short-circuit → Disputed.
 *      The one and only internal-contradiction veto.
 *   3. source_check over the ingester's CITED urls (± DocQA/Bespoke
 *      escalation), then CoVe over the same urls when inconclusive.
 *   4. Sourceless claims finalize in a single pass (no-cited-sources):
 *      nothing can ever verify a claim with no cited sources.
 * knoldr uses NO external search services — verification evidence is
 * the cited sources themselves (citation checking, not web search).
 */
async function verifyClaim(claimId: string): Promise<VerifyResult | null> {
  const result = await verifyClaimInner(claimId);
  return result;
}

async function verifyClaimInner(claimId: string): Promise<VerifyResult | null> {
  const [row] = await getDb()
    .select({
      statement: claim.statement,
      entryId: claim.entryId,
      entryCreatedAt: claim.entryCreatedAt,
      embedding: claim.embedding,
    })
    .from(claim)
    .where(eq(claim.id, claimId))
    .limit(1);

  if (!row) {
    return null;
  }

  const crossRefTimer = verifyStageLatency.startTimer({ stage: EvidenceSource.DbCrossRef });
  const candidates = await dbCrossRef(claimId, row.entryId, row.embedding);
  crossRefTimer();

  // Post-processing hook: every non-null return below funnels through
  // `withCrossRef`, which NLI-CLASSIFIES the embedding-neighbor
  // candidates into scored SUPPORTS/CONTRADICTS edge targets and merges
  // them into the evidence. Edge emission ONLY — cross-ref never
  // produces, demotes, or boosts a verdict: embedding similarity plus a
  // neighbor's verdict is not a contradiction signal (negations embed
  // as similar; a Disputed neighbor means "a similar claim is
  // contested"), and letting it veto would false-demote and start a
  // transitive Disputed contagion. Classification uses the LOCAL-only
  // NLI path (no Ollama translate fallback): ≤20 candidates × 1 ONNX
  // forward, direction premise=neighbor / hypothesis=claim ("does the
  // neighbor support this claim"). KG-conflict entries already present
  // in the evidence win dedupe over cross-ref entries (content-precise
  // beats similarity+NLI).
  const MAX_CONTRADICT_EDGES = 8;
  const MAX_SUPPORT_EDGES = 5;
  const withCrossRef = async (r: VerifyResult | null): Promise<VerifyResult | null> => {
    if (!r) {
      return null;
    }
    if (candidates.length === 0) {
      return r;
    }
    // KG-wins applies ACROSS lists too: a neighbor the KG stage already
    // marked contradicting must never also receive a cross-ref SUPPORTS
    // edge, even if pairwise NLI entails it (content-precise KG beats
    // the similarity+NLI heuristic).
    const kgContradictingIds = new Set((r.evidence.contradicting ?? []).map(t => t.id));
    const corroborating: ScoredEdgeTarget[] = [];
    const contradicting: ScoredEdgeTarget[] = [];
    for (const cand of candidates) {
      try {
        const s = await nliScoreLocal(cand.statement, row.statement);
        if (s.contradiction >= NLI_THRESHOLDS.refute) {
          contradicting.push({ id: cand.id, score: s.contradiction });
        } else if (s.entailment >= NLI_THRESHOLDS.support && !kgContradictingIds.has(cand.id)) {
          corroborating.push({ id: cand.id, score: s.entailment });
        }
      } catch (err) {
        logger.debug({ candidateId: cand.id, error: (err as Error).message }, 'edge NLI classification failed — no edge');
      }
    }
    // KG-wins dedupe: entries the verdict stage already attached
    // (KG-conflict ids scored with kgConflict.confidence) take
    // precedence over cross-ref classifications of the same neighbor.
    const mergeKgFirst = (kg: ScoredEdgeTarget[] | undefined, cross: ScoredEdgeTarget[], cap: number): ScoredEdgeTarget[] => {
      const out = [...(kg ?? [])];
      const have = new Set(out.map(t => t.id));
      for (const t of cross) {
        if (!have.has(t.id)) {
          out.push(t);
          have.add(t.id);
        }
      }
      return out.slice(0, cap);
    };
    return {
      ...r,
      evidence: {
        ...r.evidence,
        contradicting: mergeKgFirst(r.evidence.contradicting, contradicting, MAX_CONTRADICT_EDGES),
        corroborating: mergeKgFirst(r.evidence.corroborating, corroborating, MAX_SUPPORT_EDGES),
      },
    };
  };

  // KG contradiction check: extract triples from the claim, see if a
  // verified claim ever asserted (subject, predicate, *different
  // object*) for a functional relation. Catches lexical traps the
  // NLI model misses (e.g. "Bun runs on V8" against KG saying
  // "Bun runs_on JSCore"). Free signal — costs one LLM extraction
  // call but skips the source fetch entirely when it fires.
  const kgTimer = verifyStageLatency.startTimer({ stage: EvidenceSource.KgContradiction });
  const kgConflict = await checkKgContradiction(row.statement);
  kgTimer();
  if (kgConflict && kgConflict.confidence >= 0.7) {
    // Flatten every supporting claim id across all conflicting
    // objects into CONTRADICTS targets, scored with the conflict
    // confidence. Cap at 8 — the same MAX_CONTRADICT_EDGES the merge
    // enforces, so KG's own targets are never silently trimmed later.
    const contradicting = Array.from(new Set(kgConflict.conflictingObjects.flatMap(co => co.claimIds)))
      .slice(0, 8)
      .map(id => ({ id, score: kgConflict.confidence }));
    return await withCrossRef({
      verdict: Verdict.Disputed,
      certainty: kgConflict.confidence,
      evidence: {
        source: EvidenceSource.KgContradiction,
        kgConflict,
        contradicting,
      },
    });
  }

  const sources = await getDb()
    .select({ url: entrySource.url })
    .from(entrySource)
    .where(and(eq(entrySource.entryId, row.entryId), eq(entrySource.entryCreatedAt, row.entryCreatedAt)));

  const sourceUrls = sources.map(s => s.url).slice(0, SOURCE_CHECK_MAX_URLS);

  // Sourceless claims finalize in a single pass: under strict grounding
  // nothing can ever verify a claim with no cited sources, so retrying
  // is pure waste. The concrete result (never null — null means retry)
  // flows through the normal commit path; re-ingestion with sources
  // creates new claims anyway.
  if (sourceUrls.length === 0) {
    return await withCrossRef({
      verdict: Verdict.Unverified,
      certainty: 0,
      evidence: { source: EvidenceSource.NoCitedSources, rationale: 'no cited sources' },
    });
  }

  // Source-grounded NLI: fetch each CITED source, run DeBERTa-FEVER on
  // the most relevant window. This is the verification backbone —
  // calibrated entailment probability against the actual cited source
  // (citation checking, not web search), not the LLM's prior knowledge.
  const sourceTimer = verifyStageLatency.startTimer({ stage: EvidenceSource.SourceCheck });
  const sourceCheck = await runSourceCheck(row.statement, sourceUrls);
  sourceTimer();
  if (sourceCheck) {
    return await withCrossRef(sourceCheck);
  }

  // Source check inconclusive (every chunk neutral or below
  // threshold). Try CoVe: decompose the claim into atomic sub-
  // claims and verify each separately against the same cited urls.
  // Lexical traps that fool the monolithic NLI pass usually break
  // apart into one component that clearly fails — e.g. "Bun runs on
  // V8" splits into "Bun is a JS runtime" (entailed) and "Bun's
  // engine is V8" (refuted).
  const cove = await runCoveVerification(row.statement, sourceUrls);
  if (cove) {
    return await withCrossRef(cove);
  }

  // Cited sources exist but every check was inconclusive. Return null
  // so the caller retries with backoff (sources may be transiently
  // unfetchable) and finalizes ExhaustedPipeline unverified after the
  // third attempt.
  return null;
}

/**
 * CoVe wrapper: decompose the claim, verify each sub-claim through
 * KG + source_check, aggregate. Aggregation rule: any disputed sub-
 * claim → parent disputed (single false component breaks the
 * conjunction). All verified → parent verified. Otherwise → null
 * so the caller can fall through to the exhausted path.
 */
async function runCoveVerification(statement: string, sourceUrls: string[]): Promise<VerifyResult | null> {
  const subclaims = await decomposeClaim(statement);
  if (subclaims.length === 0) {
    return null;
  }

  const subResults: SubClaimResult[] = [];
  for (const sc of subclaims) {
    const kg = await checkKgContradiction(sc);
    if (kg && kg.confidence >= 0.7) {
      subResults.push({
        statement: sc,
        verdict: Verdict.Disputed,
        certainty: kg.confidence,
        via: EvidenceSource.KgContradiction,
      });
      continue;
    }
    const sc_check = await runSourceCheck(sc, sourceUrls);
    if (sc_check) {
      subResults.push({
        statement: sc,
        verdict: sc_check.verdict,
        certainty: sc_check.certainty,
        via: EvidenceSource.SourceCheck,
        scores: sc_check.evidence.sourceChecks?.[0]?.scores,
      });
    } else {
      subResults.push({
        statement: sc,
        verdict: Verdict.Unverified,
        certainty: 0,
        via: Verdict.Unverified,
      });
    }
  }

  const disputed = subResults.filter(s => s.verdict === Verdict.Disputed);
  const verified = subResults.filter(s => s.verdict === Verdict.Verified);

  // Single disputed sub-claim is sufficient — the original claim's
  // truth requires every component to hold.
  if (disputed.length > 0) {
    const maxCert = Math.max(...disputed.map(d => d.certainty));
    return {
      verdict: Verdict.Disputed,
      certainty: maxCert,
      evidence: { source: EvidenceSource.Cove, subClaims: subResults, sourceUrls },
    };
  }
  // All sub-claims verified: take the lowest certainty as the parent
  // certainty (chain is only as strong as its weakest link).
  if (verified.length === subResults.length) {
    const minCert = Math.min(...verified.map(v => v.certainty));
    return {
      verdict: Verdict.Verified,
      certainty: minCert,
      evidence: { source: EvidenceSource.Cove, subClaims: subResults, sourceUrls },
    };
  }
  // Mixed verified + unverified: not enough evidence to commit.
  return null;
}

/**
 * Fetch each source URL, run NLI against the claim, return a verdict
 * if any source clearly supports or refutes. Returns null when every
 * source is neutral / unfetchable so the caller can retry or fall
 * through to the exhausted path.
 */
async function runSourceCheck(statement: string, urls: string[]): Promise<VerifyResult | null> {
  const checks: SourceCheckResult[] = [];
  const evidences: EvidenceWithFingerprint[] = [];

  const claimYear = extractClaimYear(statement);
  for (const url of urls) {
    const fetched = await fetchSource(url);
    const check: SourceCheckResult = {
      url,
      status: fetched.status,
      authority: authorityFor(url),
      publishedTime: fetched.publishedTime,
    };
    // Skip sources that predate the claim's referenced year. They
    // can't substantiate a future event but can cause false
    // contradictions when an old article describes a now-superseded
    // state of the world.
    if (isSourceTooOld(fetched.publishedTime, claimYear)) {
      checks.push({ ...check, status: 'blocked_type' });
      continue;
    }
    if (fetched.status === 'ok' && fetched.text) {
      const chunks = await selectRelevantChunks(fetched.text, statement);
      // Per-source: take the chunk with the strongest *net* signal.
      // Cross-source aggregation is handled below by the Bayesian
      // aggregator, which combines per-source NLI distributions
      // weighted by authority and damped by independence groups.
      let bestChunk: NliScores = { entailment: 0, neutral: 1, contradiction: 0 };
      let bestNet = -Infinity;
      let bestText = '';
      let numericOverride = false;
      for (const c of chunks) {
        // STRICT GROUNDING: the verdict premise is the fetched source
        // text ALONE. Prefixing internal KG facts here once let an
        // irrelevant-but-fetchable citation verify a claim because the
        // KG prefix entailed it (see docs/no-search-restructure-plan.md).
        const premise = c;
        const s = await nliScore(premise, statement);
        // Numeric override: when the claim asserts e.g. "770M" but
        // this chunk says "7B" for the same entity, the chunk is
        // refuting regardless of what NLI says about the surrounding
        // prose. Force max contradiction; preserve the chunk text
        // so the citation surface still shows the offending number.
        const effective = numericContradicts(statement, premise) ? { entailment: 0, neutral: 0, contradiction: 1 } : s;
        const net = Math.abs(effective.entailment - effective.contradiction);
        if (net > bestNet) {
          bestNet = net;
          bestChunk = effective;
          bestText = c;
          numericOverride = numericContradicts(statement, premise);
        }
      }
      check.scores = bestChunk;
      // numericOverride already forced {contradiction:1}; no separate
      // status field change is meaningful — the scores themselves carry
      // the refutation signal. Keep the branch as a documented no-op so
      // readers know numeric overrides aren't dropped silently.
      void numericOverride;
      // Store the winning chunk as citation. Trimmed to one
      // sentence when possible — that's the actual supporting /
      // refuting line worth showing to a reader.
      check.citation = pickCitationSentence(bestText, statement) ?? bestText.slice(0, 400);
      const fp = fingerprint(url, fetched.title ?? '', fetched.text);
      evidences.push({
        scores: bestChunk,
        authority: check.authority ?? 0.5,
        group: -1, // assigned by assignIndependenceGroups below
        fingerprint: fp,
      });
    }
    checks.push(check);
  }

  if (evidences.length === 0) {
    return null;
  }

  // Use independence.ts's transitive grouping (domain match / title
  // match / hamming<4 on simhash) rather than the prior strict
  // fpKey-equality clustering, which treated same-domain-different-
  // article Reuters reposts as independent. `independentCount` returns
  // the group ids implicitly via a union-find walk; we expose the
  // cluster label here so the aggregator's damping kicks in.
  assignIndependenceGroups(evidences);

  const agg = aggregate(evidences.map(e => ({ scores: e.scores, authority: e.authority, group: e.group })));

  // Negation damping. NLI flips unreliably on negated claims, so we
  // damp the aggregated certainty before threshold checks; a
  // borderline negated claim should fall through to CoVe over the
  // cited sources rather than commit on weak signal.
  let damped = agg.certainty;
  if (hasNegation(statement)) {
    damped *= NEGATION_DAMPING;
  }

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
    const topEvidence = evidences.reduce((a, b) => (a.scores.entailment > b.scores.entailment ? a : b));
    const topUrl = checks.find(c => c.scores === topEvidence.scores)?.url;
    const topText = topUrl ? (checks.find(c => c.url === topUrl)?.citation ?? '') : '';
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
          if (qa.supports === nliSupports) {
            agree++;
          }
        }
        if (bespoke) {
          votes++;
          if (bespoke.supported === nliSupports) {
            agree++;
          }
        }
        if (votes > 0) {
          const agreementRate = agree / votes;
          // 100% agree → +0.15 boost; 0% (unanimous against) → ×0.5
          if (agreementRate === 1) {
            damped = Math.min(0.95, damped + 0.15);
          } else if (agreementRate === 0) {
            damped *= 0.5;
          } else {
            damped *= 0.85;
          }
        }
      } catch (err) {
        logger.debug({ error: (err as Error).message }, 'QA/Bespoke escalation failed');
      }
    }
  }

  // Threshold floor on top of the aggregator's posterior cutoffs:
  // the aggregator decides direction + magnitude, this gate enforces
  // the minimum decisiveness.
  if (agg.verdict === Verdict.Verified && damped < NLI_THRESHOLDS.support) {
    return null;
  }
  if (agg.verdict === Verdict.Disputed && damped < NLI_THRESHOLDS.refute) {
    return null;
  }
  if (agg.verdict === Verdict.Unverified) {
    return null;
  }

  return {
    verdict: agg.verdict,
    certainty: damped,
    evidence: { source: EvidenceSource.SourceCheck, sourceChecks: checks, sourceUrls: urls },
  };
}

interface EvidenceWithFingerprint extends SourceEvidence {
  fingerprint: SourceFingerprint;
}

/**
 * Assign independence-group ids to each evidence using the same
 * criteria as independence.ts (domain match / normalized title match /
 * simhash hamming < 4). Walks union-find so A~B~C all land in the
 * same group even when A and C aren't directly similar.
 */
function assignIndependenceGroups(evidences: EvidenceWithFingerprint[]): void {
  const parent = Array.from({ length: evidences.length }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      parent[ra] = rb;
    }
  };
  const hamming = (a: bigint, b: bigint): number => {
    let x = a ^ b;
    let n = 0;
    while (x !== 0n) {
      x &= x - 1n;
      n++;
    }
    return n;
  };
  for (let i = 0; i < evidences.length; i++) {
    for (let j = i + 1; j < evidences.length; j++) {
      const fi = evidences[i]!.fingerprint;
      const fj = evidences[j]!.fingerprint;
      const same =
        (fi.domain && fi.domain === fj.domain) ||
        (fi.titleNorm.length > 4 && fi.titleNorm === fj.titleNorm) ||
        hamming(fi.simhash, fj.simhash) < 4;
      if (same) {
        union(i, j);
      }
    }
  }
  // Re-label roots to a dense [0..k-1] range.
  const dense = new Map<number, number>();
  for (let i = 0; i < evidences.length; i++) {
    const r = find(i);
    if (!dense.has(r)) {
      dense.set(r, dense.size);
    }
    evidences[i]!.group = dense.get(r)!;
  }
}

/**
 * From a chunk, pick the single sentence with the highest
 * claim-keyword overlap. Returns null when nothing meaningful
 * matches (caller falls back to the chunk prefix). Cheap heuristic
 * — adequate for surfacing a quotable line, not a substitute for
 * NLI on the whole chunk.
 */
function pickCitationSentence(chunk: string, claim: string): string | null {
  const claimTerms = new Set((claim.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).slice(0, 30));
  if (claimTerms.size === 0) {
    return null;
  }
  const sentences = chunk.split(/(?<=[.!?。!?])\s+/);
  let best: { s: string; score: number } | null = null;
  for (const s of sentences) {
    const terms = s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
    let hits = 0;
    for (const t of terms) {
      if (claimTerms.has(t)) {
        hits++;
      }
    }
    const score = hits / Math.max(terms.length, 1);
    if (!best || score > best.score) {
      best = { s, score };
    }
  }
  return best && best.score > 0 ? best.s.trim() : null;
}

/**
 * Embedding-neighbor CANDIDATE scan for edge classification. Returns
 * decided (verified|disputed) neighbors only — their statements feed
 * the claim-pair NLI in `withCrossRef`, which decides SUPPORTS /
 * CONTRADICTS / no-edge. The neighbor's verdict deliberately carries
 * no meaning here: similarity+verdict is not a relation signal.
 */
async function dbCrossRef(
  claimId: string,
  entryId: string,
  embedding: number[],
): Promise<Array<{ id: string; statement: string }>> {
  const vec = `[${embedding.join(',')}]`;
  // Cosine distance: 0 = identical, 2 = opposite. Convert to similarity.
  // Exclude the claim's OWN entry — other claims extracted from the
  // same source trivially rephrase each other and create a self-
  // reinforcing echo chamber in the candidate pool.
  const neighbors = await getDb().execute(sql`
    SELECT id, statement
    FROM claim
    WHERE id <> ${claimId}
      AND entry_id <> ${entryId}
      AND verdict IN (${Verdict.Verified}, ${Verdict.Disputed})
      AND 1 - (embedding <=> ${vec}::vector) >= ${SIMILARITY_THRESHOLD}
    ORDER BY embedding <=> ${vec}::vector
    LIMIT 20
  `);
  return (neighbors as unknown as Array<{ id: string; statement: string }>).map(n => ({ id: n.id, statement: n.statement }));
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
async function processVerifyQueue(batchSize = 5): Promise<number> {
  if (verifyRunning) {
    return 0;
  }
  verifyRunning = true;
  try {
    return await processVerifyQueueInner(batchSize);
  } finally {
    verifyRunning = false;
  }
}

async function processVerifyQueueInner(batchSize: number): Promise<number> {
  // FOR UPDATE SKIP LOCKED: row-level locks so overlapping ticks
  // or multi-replica deployments can't double-dispatch.
  //
  // Ordering: effective priority = static priority + age boost.
  // Static priority alone caused starvation — 12k old rows at
  // priority=10 never surfaced while new extractions kept landing
  // at priority=60+ and refilling the top of the heap every cycle.
  // Adding 2 points per hour queued means a day-old priority=10
  // row (10 + 48 = 58) starts competing with current priority=60
  // work, and a 6-day-old one (10 + 288) supersedes anything short
  // of a manual escalation.
  //
  // Use NOW() in SQL rather than binding a JS Date — drizzle's sql
  // template passes Date objects directly to postgres-js which
  // rejects them for TIMESTAMPTZ params ("must be string or Buffer").
  const due = (await getDb().execute(sql`
    SELECT claim_id, attempts
    FROM verify_queue
    WHERE next_attempt_at <= NOW()
      AND attempts < 3
    ORDER BY priority + EXTRACT(EPOCH FROM (NOW() - queued_at)) / 1800 DESC,
             queued_at ASC
    LIMIT ${batchSize}
    FOR UPDATE SKIP LOCKED
  `)) as unknown as Array<{ claim_id: string; attempts: number }>;
  const dueItems = due.map(r => ({ claimId: r.claim_id, attempts: r.attempts }));

  // Concurrent batch. Each claim's verify is dominated by network
  // waits (cited-source fetches, LLM HTTP) — `Promise.allSettled`
  // overlaps those so an N-claim batch finishes in roughly the time
  // of the slowest single claim, not their sum. NLI/reranker model
  // forward passes still serialize on the JS thread, but those are
  // microseconds compared to the seconds-each network waits.
  const results = await Promise.allSettled(
    dueItems.map(async item => {
      let result = await verifyClaim(item.claimId);
      if (!result) {
        if (item.attempts < 2) {
          await bumpAttempt(item.claimId, item.attempts);
          return { committed: false };
        }
        // Three exhaustive failures → commit explicit unverified so
        // the claim leaves the queue and the evidence trail records
        // why nothing landed. Without this the claim silently sits
        // at its initial verdict forever. `exhausted_pipeline` is a
        // distinct source label so metrics separate this from decided
        // verdicts.
        result = {
          verdict: Verdict.Unverified,
          certainty: 0,
          evidence: { source: EvidenceSource.ExhaustedPipeline, rationale: 'all verification paths returned null' },
        };
      }
      await getDb().transaction(async tx => {
        await tx
          .update(claim)
          .set({
            verdict: result!.verdict,
            certainty: result!.certainty,
            // Sync authority with the fresh certainty on first
            // commit. Subsequent feedback-driven adjustments move
            // authority independently while certainty stays put.
            authority: result!.certainty,
            evidence: result!.evidence,
          })
          .where(eq(claim.id, item.claimId));
        await tx.execute(sql`
          INSERT INTO verdict_log (id, claim_id, verdict, certainty, evidence_source, grounder_model, trigger, created_at)
          VALUES (
            ${ulid()},
            ${item.claimId},
            ${result!.verdict},
            ${result!.certainty},
            ${result!.evidence.source},
            ${process.env.KNOLDR_OLLAMA_FAST_MODEL ?? 'gemma4:e4b'},
            ${VerdictTrigger.Auto},
            NOW()
          )
        `);
        await tx.delete(verifyQueue).where(eq(verifyQueue.claimId, item.claimId));
      });
      verifyVerdicts.inc({
        source: result!.evidence.source,
        verdict: result!.verdict,
      });
      // claim_relation edge writes — outside the verdict tx so a
      // failed edge insert (FK miss, dup) can't roll back the
      // verdict commit. writeClaimEdges is ON CONFLICT DO NOTHING
      // and FK-safe; failures are logged and swallowed inside.
      const ev = result!.evidence;
      if (ev.contradicting && ev.contradicting.length > 0) {
        // CONTRADICTS: claim → neighbor, weight = the classifying NLI
        // contradiction probability (or kgConflict.confidence for
        // KG-sourced targets) — NOT the claim's verdict certainty.
        await writeClaimEdges(
          item.claimId,
          ev.contradicting.map(t => ({ id: t.id, weight: t.score })),
          RelationType.Contradicts,
          { direction: 'outgoing', createdBy: VerdictTrigger.Auto, metadata: { source: ev.source } },
        );
      }
      if (ev.corroborating && ev.corroborating.length > 0) {
        // SUPPORTS: neighbor → claim (premise=neighbor entailing this
        // claim means the NEIGHBOR supports it), weight = entailment.
        await writeClaimEdges(
          item.claimId,
          ev.corroborating.map(t => ({ id: t.id, weight: t.score })),
          RelationType.Supports,
          { direction: 'incoming', createdBy: VerdictTrigger.Auto, metadata: { source: ev.source } },
        );
      }
      return { committed: true };
    }),
  );

  let processed = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const item = dueItems[i]!;
    if (r.status === 'fulfilled' && r.value.committed) {
      processed++;
    } else if (r.status === 'rejected') {
      verifyErrors.inc({ kind: 'verify_exception' });
      logger.warn({ claimId: item.claimId, error: (r.reason as Error).message }, 'verify failed, rescheduling');
      // On a third exception, commit an explicit `unverified` and drop
      // the row from the queue instead of bumping attempts indefinitely.
      // Previously, an always-throwing verify left rows with attempts=
      // 25+ sitting in the queue forever (saw 1020 such rows in prod).
      if (item.attempts >= 2) {
        await finalizeUnverified(item.claimId, 'exception after 3 attempts');
      } else {
        await bumpAttempt(item.claimId, item.attempts);
      }
    }
  }

  if (processed > 0) {
    logger.info({ processed, batchSize }, 'verify queue batch processed');
  }
  return processed;
}

async function bumpAttempt(claimId: string, currentAttempts: number): Promise<void> {
  // Exponential backoff: 5, 25, 125 min. Matches the retry_queue
  // cadence so poison-claim behavior is uniform across queues.
  const next = currentAttempts + 1;
  const backoffMs = 1000 * 60 * Math.pow(5, next);
  await getDb()
    .update(verifyQueue)
    .set({
      attempts: sql`LEAST(3, ${verifyQueue.attempts} + 1)`,
      nextAttemptAt: new Date(Date.now() + backoffMs),
    })
    .where(eq(verifyQueue.claimId, claimId));
}

async function finalizeUnverified(claimId: string, reason: string): Promise<void> {
  await getDb().transaction(async tx => {
    await tx
      .update(claim)
      .set({
        verdict: Verdict.Unverified,
        certainty: 0,
        evidence: { source: EvidenceSource.ExceptionFinalize, rationale: reason },
      })
      .where(eq(claim.id, claimId));
    await tx.execute(sql`
      INSERT INTO verdict_log (id, claim_id, verdict, certainty, evidence_source, grounder_model, trigger, created_at)
      VALUES (
        ${ulid()},
        ${claimId},
        ${Verdict.Unverified},
        0,
        ${EvidenceSource.ExceptionFinalize},
        ${process.env.KNOLDR_OLLAMA_FAST_MODEL ?? 'gemma4:e4b'},
        ${VerdictTrigger.Auto},
        NOW()
      )
    `);
    await tx.delete(verifyQueue).where(eq(verifyQueue.claimId, claimId));
  });
  verifyVerdicts.inc({ source: EvidenceSource.ExceptionFinalize, verdict: Verdict.Unverified });
}

/** Recompute factuality = verified / total factual for an entry. */
async function updateFactualityScore(entryId: string, entryCreatedAt: Date): Promise<void> {
  const [counts] = await getDb()
    .select({
      total: sql<number>`COUNT(*)::int`,
      verified: sql<number>`SUM(CASE WHEN verdict = ${Verdict.Verified} THEN 1 ELSE 0 END)::int`,
    })
    .from(claim)
    .where(and(eq(claim.entryId, entryId), eq(claim.entryCreatedAt, entryCreatedAt), eq(claim.type, ClaimType.Factual)));

  if (!counts || counts.total === 0) {
    return;
  }
  const factuality = counts.verified / counts.total;

  await getDb()
    .insert(entryScore)
    .values({
      entryId,
      entryCreatedAt,
      dimension: EntryScoreDimension.Factuality,
      value: factuality,
      scoredBy: 'system',
    })
    .onConflictDoUpdate({
      target: [entryScore.entryId, entryScore.entryCreatedAt, entryScore.dimension],
      set: {
        value: factuality,
        scoredAt: new Date(),
        scoredBy: 'system',
      },
    });
}

/** Optional helper: boost verify priority for entries with high authority. */
async function priorityForEntry(entryId: string, entryCreatedAt: Date): Promise<number> {
  const [row] = await getDb()
    .select({ authority: entry.authority })
    .from(entry)
    .where(and(eq(entry.id, entryId), eq(entry.createdAt, entryCreatedAt)))
    .limit(1);
  // Priority 0-100; higher authority = earlier verification.
  return row ? Math.round(row.authority * 100) : 0;
}

export { verifyClaim, processVerifyQueue, updateFactualityScore, priorityForEntry };
