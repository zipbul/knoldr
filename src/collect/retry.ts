import { db } from "../db/connection";
import { retryQueue } from "../db/schema";
import { ingest } from "../ingest/engine";
import { parseStoreInput } from "../ingest/validate";
import { eq, and, lte, lt } from "drizzle-orm";
import { ulid } from "ulid";
import { logger } from "../observability/logger";

/**
 * Process retry queue: pick items where next_retry_at <= now and attempts < 3.
 * Re-attempt ingestion. On failure, increment attempts + backoff.
 */
export async function processRetryQueue(): Promise<number> {
  const now = new Date();
  let processed = 0;

  const items = await db
    .select()
    .from(retryQueue)
    .where(and(lte(retryQueue.nextRetryAt, now), lt(retryQueue.attempts, 3)))
    .orderBy(retryQueue.nextRetryAt)
    .limit(10);

  for (const item of items) {
    try {
      const input = parseStoreInput({
        raw: item.rawContent,
        sources: item.sourceUrl
          ? [{ url: item.sourceUrl, sourceType: "unknown" }]
          : undefined,
      });

      // Delete-before-ingest: ingest() has its own nested transactions
      // that commit independently, so wrapping ingest + delete in an
      // outer TX doesn't actually make them atomic (the inner commits
      // are already durable before the outer TX commits). Given the
      // choice between "may lose raw content on crash between delete
      // and ingest" vs "may double-ingest on crash between ingest and
      // delete", we pick content loss — double-ingest pollutes the
      // knowledge base permanently and every retry afterwards hits
      // the same poison input anyway.
      await db.delete(retryQueue).where(eq(retryQueue.id, item.id));
      await ingest(input, { fromRetry: true });
      processed++;
      logger.info({ retryId: item.id }, "retry succeeded, removed from queue");
    } catch (err) {
      const newAttempts = item.attempts + 1;
      const backoffMs = 1000 * 60 * Math.pow(5, newAttempts); // 5min, 25min, 125min
      const nextRetry = new Date(Date.now() + backoffMs);

      // We deleted the row optimistically above. On failure, re-insert
      // with bumped attempts + fresh nextRetry so the retry loop can
      // try again. If the row is already deleted and we simply UPDATE,
      // nothing would happen — so we INSERT the row back with the
      // same id (PK conflicts resolve to no-op since we're the only
      // writer for that id).
      await db
        .insert(retryQueue)
        .values({
          id: item.id,
          rawContent: item.rawContent,
          sourceUrl: item.sourceUrl,
          errorReason: (err as Error).message,
          attempts: newAttempts,
          nextRetryAt: nextRetry,
          createdAt: item.createdAt,
        })
        .onConflictDoUpdate({
          target: retryQueue.id,
          set: {
            attempts: newAttempts,
            nextRetryAt: nextRetry,
            errorReason: (err as Error).message,
          },
        });

      logger.warn(
        { retryId: item.id, attempts: newAttempts, nextRetry: nextRetry.toISOString() },
        "retry failed, rescheduled",
      );
    }
  }

  return processed;
}

/**
 * Add a failed ingestion to the retry queue.
 */
export async function enqueueRetry(
  rawContent: string,
  sourceUrl: string | undefined,
  errorReason: string,
): Promise<void> {
  await db.insert(retryQueue).values({
    id: ulid(),
    rawContent,
    sourceUrl: sourceUrl ?? null,
    errorReason,
  });
  logger.info({ errorReason }, "added to retry queue");
}
