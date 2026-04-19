import { sql, eq, and, lt } from "drizzle-orm";
import { db } from "../db/connection";
import { claim } from "../db/schema";
import { verifyClaim } from "./verify";
import { logger } from "../observability/logger";

// Drift detector. A claim verified with confidence today can become
// disputed tomorrow if the underlying source changes (page edited,
// stronger NLI model loaded, KG accumulated a contradicting triple).
// Without periodic re-verification a stale `verified` lingers
// forever and the trust score `factuality` overstates reality.
//
// Strategy: walk the oldest verified claims in small batches and
// re-run the full pipeline. When the new verdict diverges:
//  - was verified, now disputed → demote to `disputed`, certainty
//    becomes the new (lower-certainty) value.
//  - was verified, now unverified → demote to `unverified`,
//    halve the original certainty (we no longer have grounding but
//    haven't refuted either).
//  - was disputed, now verified → promote to `verified` (rare; a
//    new corroborating source appeared).

const DRIFT_AGE_DAYS = 14;
const REVERIFY_BATCH = 5;

export async function detectDrift(batchSize = REVERIFY_BATCH): Promise<number> {
  const cutoff = new Date(Date.now() - DRIFT_AGE_DAYS * 24 * 3600 * 1000);
  // Pull stale verified/disputed claims, oldest first by created_at.
  const due = await db
    .select({
      id: claim.id,
      verdict: claim.verdict,
      certainty: claim.certainty,
      statement: claim.statement,
    })
    .from(claim)
    .where(
      and(
        sql`${claim.verdict} IN ('verified', 'disputed')`,
        lt(claim.createdAt, cutoff),
      ),
    )
    .orderBy(claim.createdAt)
    .limit(batchSize);

  let drifted = 0;
  for (const c of due) {
    try {
      const fresh = await verifyClaim(c.id);
      if (!fresh) continue;
      if (fresh.verdict === c.verdict) continue;

      const newCertainty =
        fresh.verdict === "unverified" ? c.certainty * 0.5 : fresh.certainty;
      await db
        .update(claim)
        .set({
          verdict: fresh.verdict,
          certainty: newCertainty,
          evidence: { ...fresh.evidence, drifted_from: c.verdict },
        })
        .where(eq(claim.id, c.id));
      drifted++;
      logger.info(
        {
          claimId: c.id,
          old: c.verdict,
          new: fresh.verdict,
          newCertainty,
          statement: c.statement.slice(0, 80),
        },
        "claim drift detected",
      );
    } catch (err) {
      logger.warn(
        { claimId: c.id, error: (err as Error).message },
        "drift reverify failed",
      );
    }
  }

  if (drifted > 0) {
    logger.info({ drifted, batchSize }, "drift batch processed");
  }
  return drifted;
}
