import { z } from "zod/v4";
import { eq, sql, desc, and, lte, lt } from "drizzle-orm";
import { db } from "../db/connection";
import { claim, verifyQueue, entry, entryScore, entrySource } from "../db/schema";
import { callAllLlms, extractJson, type LlmVote } from "../llm/cli";
import { logger } from "../observability/logger";

const VERDICTS = ["verified", "disputed", "unverified"] as const;
type Verdict = (typeof VERDICTS)[number];

export interface VerifyResult {
  verdict: Verdict;
  certainty: number;
  evidence: {
    source: "db_cross_ref" | "llm_jury";
    corroborations?: number;
    contradictions?: number;
    rationale?: string;
    sourceUrls?: string[];
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

  const sources = await db
    .select({ url: entrySource.url })
    .from(entrySource)
    .where(
      and(
        eq(entrySource.entryId, row.entryId),
        eq(entrySource.entryCreatedAt, row.entryCreatedAt),
      ),
    );

  const jury = await llmJury(row.statement, sources.map((s) => s.url));
  if (!jury) return null;
  return jury;
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

/** Process up to `batchSize` claims from the verify queue. */
export async function processVerifyQueue(batchSize = 5): Promise<number> {
  const now = new Date();
  const due = await db
    .select({
      claimId: verifyQueue.claimId,
      attempts: verifyQueue.attempts,
    })
    .from(verifyQueue)
    .where(
      and(
        lte(verifyQueue.nextAttemptAt, now),
        lt(verifyQueue.attempts, 3),
      ),
    )
    .orderBy(desc(verifyQueue.priority), verifyQueue.nextAttemptAt)
    .limit(batchSize);

  let processed = 0;
  for (const item of due) {
    try {
      const result = await verifyClaim(item.claimId);
      if (!result) {
        await bumpAttempt(item.claimId);
        continue;
      }
      await db.transaction(async (tx) => {
        await tx
          .update(claim)
          .set({
            verdict: result.verdict,
            certainty: result.certainty,
            evidence: result.evidence,
          })
          .where(eq(claim.id, item.claimId));
        await tx.delete(verifyQueue).where(eq(verifyQueue.claimId, item.claimId));
      });
      processed++;
    } catch (err) {
      logger.warn(
        { claimId: item.claimId, error: (err as Error).message },
        "verify failed, rescheduling",
      );
      await bumpAttempt(item.claimId);
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

