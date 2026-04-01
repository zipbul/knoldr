import { db } from "../db/connection";
import { entry } from "../db/schema";
import { sql } from "drizzle-orm";
import { logger } from "../observability/logger";

const DISTANCE_THRESHOLD = 0.05; // cosine distance < 0.05 = similarity > 0.95

/**
 * Check if an embedding is a near-duplicate of any existing entry.
 * No domain/time restrictions — compares against ALL active entries.
 * Returns all entries within threshold for logging.
 */
export async function isDuplicate(
  embedding: number[],
): Promise<boolean> {
  const vecStr = `[${embedding.join(",")}]`;

  const duplicates = await db
    .select({
      id: entry.id,
      distance: sql<number>`${entry.embedding} <=> ${vecStr}::vector`,
    })
    .from(entry)
    .where(
      sql`${entry.embedding} <=> ${vecStr}::vector < ${DISTANCE_THRESHOLD}`,
    );

  if (duplicates.length > 0) {
    logger.debug(
      {
        count: duplicates.length,
        closest: duplicates[0]?.id,
        closestDistance: duplicates[0]?.distance,
      },
      "duplicate(s) detected",
    );
  }

  return duplicates.length > 0;
}
