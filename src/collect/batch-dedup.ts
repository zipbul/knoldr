import { db } from "../db/connection";
import { entry, ingestLog } from "../db/schema";
import { sql, gt, and, ne } from "drizzle-orm";
import { ulid } from "ulid";
import { logger } from "../observability/logger";

const BATCH_SIZE = 100;
const MAX_DURATION_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Daily batch dedup job.
 * Compares entries from last 7 days against all entries.
 * Keeps higher authority; on tie, keeps older (first writer wins).
 * Deletes duplicates (CASCADE cleans related tables).
 */
export async function batchDedup(): Promise<number> {
  const startTime = Date.now();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  let totalDeleted = 0;
  let offset = 0;

  logger.info("batch dedup started");

  while (Date.now() - startTime < MAX_DURATION_MS) {
    // Get batch of recent entries
    const recentEntries = await db
      .select({
        id: entry.id,
        createdAt: entry.createdAt,
        authority: entry.authority,
        embedding: entry.embedding,
      })
      .from(entry)
      .where(gt(entry.createdAt, sevenDaysAgo))
      .orderBy(entry.createdAt)
      .limit(BATCH_SIZE)
      .offset(offset);

    if (recentEntries.length === 0) break;

    for (const current of recentEntries) {
      if (Date.now() - startTime > MAX_DURATION_MS) break;

      const vecStr = `[${(current.embedding as number[]).join(",")}]`;

      // Find top 5 nearest entries (excluding self)
      const neighbors = await db
        .select({
          id: entry.id,
          createdAt: entry.createdAt,
          authority: entry.authority,
          distance: sql<number>`${entry.embedding} <=> ${vecStr}::vector`,
        })
        .from(entry)
        .where(
          and(
            ne(entry.id, current.id),
            sql`${entry.embedding} <=> ${vecStr}::vector < 0.05`,
          ),
        )
        .orderBy(sql`${entry.embedding} <=> ${vecStr}::vector`)
        .limit(5);

      for (const neighbor of neighbors) {
        // Determine which to keep
        let deleteId: string;
        let deleteCreatedAt: Date;
        let keepId: string;

        if (neighbor.authority > current.authority) {
          // Neighbor has higher authority → delete current
          deleteId = current.id;
          deleteCreatedAt = current.createdAt;
          keepId = neighbor.id;
        } else if (neighbor.authority < current.authority) {
          // Current has higher authority → delete neighbor
          deleteId = neighbor.id;
          deleteCreatedAt = neighbor.createdAt;
          keepId = current.id;
        } else {
          // Same authority → keep older (smaller ULID = earlier timestamp)
          if (current.id < neighbor.id) {
            deleteId = neighbor.id;
            deleteCreatedAt = neighbor.createdAt;
            keepId = current.id;
          } else {
            deleteId = current.id;
            deleteCreatedAt = current.createdAt;
            keepId = neighbor.id;
          }
        }

        // Delete duplicate
        await db
          .delete(entry)
          .where(
            and(
              sql`${entry.id} = ${deleteId}`,
              sql`${entry.createdAt} = ${deleteCreatedAt}`,
            ),
          );

        // Log
        await db.insert(ingestLog).values({
          id: ulid(),
          entryId: deleteId,
          entryCreatedAt: deleteCreatedAt,
          action: "duplicate",
          reason: `batch_dedup: similar_to=${keepId}`,
        });

        totalDeleted++;
        logger.debug({ deleted: deleteId, kept: keepId }, "batch dedup: removed duplicate");

        // If current was deleted, skip remaining neighbors
        if (deleteId === current.id) break;
      }
    }

    offset += BATCH_SIZE;
  }

  logger.info({ totalDeleted, durationMs: Date.now() - startTime }, "batch dedup completed");
  return totalDeleted;
}
