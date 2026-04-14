import { z } from "zod/v4";
import { eq, sql, desc, and, lte, lt } from "drizzle-orm";
import { db } from "../db/connection";
import { claim, verifyQueue, entry, entryScore, entrySource } from "../db/schema";
import { callLlm, extractJson } from "../llm/cli";
import { logger } from "../observability/logger";

const VERDICTS = ["verified", "disputed", "unverified"] as const;
type Verdict = (typeof VERDICTS)[number];

export interface VerifyResult {
  verdict: Verdict;
  certainty: number;
  evidence: {
    source: "db_cross_ref" | "llm_judgment";
    corroborations?: number;
    contradictions?: number;
    rationale?: string;
    sourceUrls?: string[];
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

  const judgment = await llmJudgment(row.statement, sources.map((s) => s.url));
  if (!judgment) return null;

  return {
    verdict: judgment.verdict,
    certainty: judgment.certainty,
    evidence: {
      source: "llm_judgment",
      rationale: judgment.rationale,
      sourceUrls: sources.map((s) => s.url),
    },
  };
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

async function llmJudgment(
  statement: string,
  sourceUrls: string[],
): Promise<z.infer<typeof judgmentSchema> | null> {
  const prompt = `You are a fact-verification judge.

Claim: "${statement}"

Sources available (${sourceUrls.length}): ${sourceUrls.join(", ") || "none"}

Assess the claim. Respond with JSON only:
{"verdict":"verified|disputed|unverified","certainty":0.0-1.0,"rationale":"<=200 chars"}

Rules:
- verified: strong evidence supports it
- disputed: evidence contradicts it
- unverified: insufficient evidence either way
- certainty reflects confidence in the verdict, not in the claim being true`;

  try {
    const output = await callLlm(prompt);
    const raw = extractJson(output);
    return judgmentSchema.parse(raw);
  } catch (err) {
    logger.warn({ error: (err as Error).message }, "LLM claim judgment failed");
    return null;
  }
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

