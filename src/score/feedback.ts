import { ulid } from "ulid";
import { db } from "../db/connection";
import { entry, feedbackLog } from "../db/schema";
import { sql, eq, and, gt, count } from "drizzle-orm";
import { decodeUlidTimestamp } from "../lib/ulid-utils";
import { logger } from "../observability/logger";
import { feedbackTotal } from "../observability/metrics";

interface FeedbackResult {
  entryId: string;
  newAuthority: number;
}

/**
 * Process feedback signal on an entry.
 * Rate limits: same agent+entry max 1 per hour, max 10 per hour per entry.
 */
export async function processFeedback(
  entryId: string,
  signal: "positive" | "negative",
  reason: string | undefined,
  agentId: string,
): Promise<FeedbackResult> {
  // Extract created_at from ULID for partition routing
  const entryCreatedAt = new Date(decodeUlidTimestamp(entryId));
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  // Rate limit: same agent + entry, 1 per hour
  const agentRecent = await db
    .select({ cnt: count() })
    .from(feedbackLog)
    .where(
      and(
        eq(feedbackLog.agentId, agentId),
        eq(feedbackLog.entryId, entryId),
        gt(feedbackLog.createdAt, oneHourAgo),
      ),
    );

  if ((agentRecent[0]?.cnt ?? 0) > 0) {
    throw new RateLimitError("same agent+entry feedback limited to 1 per hour");
  }

  // Rate limit: entry total, 10 per hour
  const entryRecent = await db
    .select({ cnt: count() })
    .from(feedbackLog)
    .where(
      and(
        eq(feedbackLog.entryId, entryId),
        gt(feedbackLog.createdAt, oneHourAgo),
      ),
    );

  if ((entryRecent[0]?.cnt ?? 0) >= 10) {
    throw new RateLimitError("entry feedback limited to 10 per hour");
  }

  // Atomic authority update
  const authorityUpdate =
    signal === "negative"
      ? sql`GREATEST(0.05, ${entry.authority} * 0.8)`
      : sql`LEAST(1.0, ${entry.authority} * 1.1)`;

  const updated = await db
    .update(entry)
    .set({ authority: authorityUpdate })
    .where(and(eq(entry.id, entryId), eq(entry.createdAt, entryCreatedAt)))
    .returning({ authority: entry.authority });

  if (updated.length === 0) {
    throw new Error(`Entry not found: ${entryId}`);
  }

  const newAuthority = updated[0]!.authority;

  // Log feedback
  await db.insert(feedbackLog).values({
    id: ulid(),
    entryId,
    entryCreatedAt,
    signal,
    reason,
    agentId,
  });

  feedbackTotal.inc({ signal });
  logger.info({ entryId, signal, newAuthority, agentId }, "feedback processed");

  return { entryId, newAuthority };
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}
