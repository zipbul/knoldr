import { sql } from "drizzle-orm";
import { db } from "../db/connection";
import { extractTriples } from "./extract";
import { storeTriples } from "./store";
import { logger } from "../observability/logger";

/**
 * KG triple extraction worker. Processes verified factual claims that
 * have not yet produced any kg_relation rows. Serialized batching
 * (batchSize=3) prevents LLM CLI subprocess saturation.
 */
export async function processKgExtractionQueue(batchSize = 3): Promise<number> {
  const rows = await db.execute(sql`
    SELECT c.id, c.statement
    FROM claim c
    WHERE c.type = 'factual'
      AND c.verdict = 'verified'
      AND NOT EXISTS (
        SELECT 1 FROM kg_relation r WHERE r.claim_id = c.id
      )
    ORDER BY c.certainty DESC, c.created_at DESC
    LIMIT ${batchSize}
  `);

  const batch = rows as unknown as Array<{ id: string; statement: string }>;
  if (batch.length === 0) return 0;

  let processed = 0;
  for (const row of batch) {
    try {
      const triples = await extractTriples(row.statement);
      if (triples.length === 0) {
        logger.debug({ claimId: row.id }, "no triples extracted");
        continue;
      }
      await storeTriples(row.id, triples);
      processed++;
    } catch (err) {
      logger.warn(
        { claimId: row.id, error: (err as Error).message },
        "KG extraction failed",
      );
    }
  }

  if (processed > 0) {
    logger.info({ processed, batchSize }, "KG extraction batch processed");
  }
  return processed;
}
