import { db } from "../db/connection";
import { entry, entryDomain } from "../db/schema";
import { sql, eq, and, gt, inArray } from "drizzle-orm";
import { logger } from "../observability/logger";

const SIMILARITY_THRESHOLD = 0.95;
const DISTANCE_THRESHOLD = 1 - SIMILARITY_THRESHOLD; // 0.05

/**
 * Check if an embedding is a near-duplicate of existing entries.
 * Compares against entries in the same domains from the last 90 days.
 * Returns true if duplicate found.
 */
export async function isDuplicate(
  embedding: number[],
  domains: string[],
): Promise<boolean> {
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  const vecStr = `[${embedding.join(",")}]`;

  // Find entries in the same domains, check cosine distance
  const results = await db
    .select({
      id: entry.id,
      distance: sql<number>`${entry.embedding} <=> ${vecStr}::vector`,
    })
    .from(entry)
    .innerJoin(
      entryDomain,
      and(
        eq(entryDomain.entryId, entry.id),
        eq(entryDomain.entryCreatedAt, entry.createdAt),
      ),
    )
    .where(
      and(
        gt(entry.createdAt, ninetyDaysAgo),
        eq(entry.status, "active"),
        inArray(entryDomain.domain, domains),
      ),
    )
    .orderBy(sql`${entry.embedding} <=> ${vecStr}::vector`)
    .limit(10);

  const hasDuplicate = results.some((r) => r.distance < DISTANCE_THRESHOLD);

  if (hasDuplicate) {
    logger.debug(
      { closestDistance: results[0]?.distance, domains },
      "duplicate detected",
    );
  }

  return hasDuplicate;
}
