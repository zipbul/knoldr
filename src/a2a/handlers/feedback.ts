import { z } from "zod";
import { processFeedback, RateLimitError } from "../../score/feedback";
import { InvalidUlidError } from "../../lib/ulid-utils";
import { logger } from "../../observability/logger";

const feedbackInputSchema = z.object({
  entryId: z.string().min(1).max(200),
  signal: z.enum(["positive", "negative"]),
  reason: z.string().max(1000).optional(),
  agentId: z.string().min(1).max(200),
});

export type FeedbackResult =
  | { ok: true; entryId: string; newAuthority: number }
  | { ok: false; error: "rate_limited" | "not_found" | "invalid_input"; message: string };

/**
 * Feedback skill: atomic authority adjustment based on agent signal.
 * Rate-limited inside processFeedback (1/hour/(agent,entry), 10/hour/entry).
 */
export async function handleFeedback(input: Record<string, unknown>): Promise<FeedbackResult> {
  let validated: z.infer<typeof feedbackInputSchema>;
  try {
    validated = feedbackInputSchema.parse(input);
  } catch (err) {
    return { ok: false, error: "invalid_input", message: (err as Error).message };
  }

  try {
    const { entryId, newAuthority } = await processFeedback(
      validated.entryId,
      validated.signal,
      validated.reason,
      validated.agentId,
    );
    logger.info({ entryId, signal: validated.signal, newAuthority }, "feedback skill applied");
    return { ok: true, entryId, newAuthority };
  } catch (err) {
    if (err instanceof RateLimitError) {
      return { ok: false, error: "rate_limited", message: err.message };
    }
    if (err instanceof InvalidUlidError) {
      return { ok: false, error: "invalid_input", message: err.message };
    }
    const message = (err as Error).message;
    if (message.startsWith("Entry not found")) {
      return { ok: false, error: "not_found", message };
    }
    throw err;
  }
}
