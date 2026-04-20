import { sql, eq, and, lt, or, isNull } from "drizzle-orm";
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
// Strategy: walk verified/disputed claims whose last_drift_check_at is
// oldest (NULLS FIRST so newly-verified claims are checked once). We
// advance the timestamp at the END of each processed claim, so a
// repeatedly-failing claim no longer monopolizes the next cycle — it
// moves to the back of the queue and something else gets a turn.
//
// When the new verdict diverges:
//  - was verified, now disputed → demote to `disputed`
//  - was verified, now unverified → demote to `unverified`, halve old certainty
//  - was disputed, now verified → promote

const DRIFT_AGE_DAYS = 14;
const REVERIFY_BATCH = 5;

export async function detectDrift(batchSize = REVERIFY_BATCH): Promise<number> {
  const cutoff = new Date(Date.now() - DRIFT_AGE_DAYS * 24 * 3600 * 1000);

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
    // Oldest drift-check-timestamp first, NULL first for claims never
    // checked. `claim.createdAt` as secondary key keeps order stable.
    .orderBy(
      sql`${claim.lastDriftCheckAt} NULLS FIRST`,
      claim.createdAt,
    )
    .limit(batchSize);

  let drifted = 0;
  for (const c of due) {
    try {
      const fresh = await verifyClaim(c.id);

      // ALWAYS stamp last_drift_check_at, even when fresh === null or
      // the verdict didn't change. This is the fix for "same 5 claims
      // forever": the timestamp moves every claim out of the front of
      // the queue regardless of outcome, and the NULLS-FIRST order
      // cycles through the rest of the verified pool.
      const nowTs = new Date();
      if (!fresh) {
        await db
          .update(claim)
          .set({ lastDriftCheckAt: nowTs })
          .where(eq(claim.id, c.id));
        continue;
      }
      if (fresh.verdict === c.verdict) {
        await db
          .update(claim)
          .set({ lastDriftCheckAt: nowTs })
          .where(eq(claim.id, c.id));
        continue;
      }

      const newCertainty =
        fresh.verdict === "unverified" ? c.certainty * 0.5 : fresh.certainty;
      await db
        .update(claim)
        .set({
          verdict: fresh.verdict,
          certainty: newCertainty,
          evidence: { ...fresh.evidence, drifted_from: c.verdict },
          lastDriftCheckAt: nowTs,
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
      // Still stamp the timestamp so a permanently-failing claim stops
      // monopolizing the batch. Retry will cycle back around naturally.
      try {
        await db
          .update(claim)
          .set({ lastDriftCheckAt: new Date() })
          .where(eq(claim.id, c.id));
      } catch { /* best-effort */ }
    }
  }

  if (drifted > 0) {
    logger.info({ drifted, batchSize }, "drift batch processed");
  }
  return drifted;
}

// Exports kept for backwards-compatibility with any imports from other
// modules.
export { or, isNull };
