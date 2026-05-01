import { z } from "zod";
import { processFeedback, RateLimitError } from "../../score/feedback";
import { InvalidUlidError } from "../../lib/ulid-utils";
import { logger } from "../../observability/logger";
import { routeFeedbackAction } from "../../score/feedback-router";

// Structured reason taxonomy. The category drives downstream actions
// (re-verify on `wrong`, re-research on `outdated`, gap log on
// `missing`). Free-text comments are still allowed in `note` for
// debugging / audit but never drive routing — categories are the only
// machine-readable signal.
export const FEEDBACK_REASONS = [
  "used",
  "helpful",
  "wrong",
  "outdated",
  "missing",
  "irrelevant",
  "other",
] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number];

const feedbackInputSchema = z.object({
  entryId: z.string().min(1).max(200),
  signal: z.enum(["positive", "negative"]),
  reason: z.enum(FEEDBACK_REASONS).optional(),
  note: z.string().max(1000).optional(),
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

  // Persist as `<reason>:<note>` so the existing free-text column keeps
  // both the structured category and any agent-supplied detail. Empty
  // when neither is provided.
  const reasonStored =
    validated.reason && validated.note
      ? `${validated.reason}:${validated.note}`
      : validated.reason ?? validated.note;

  try {
    const { entryId, newAuthority } = await processFeedback(
      validated.entryId,
      validated.signal,
      reasonStored,
      validated.agentId,
    );
    // Route the structured reason to its downstream action (re-verify
    // queue / re-research / gap log). Best-effort — the authority
    // update already committed, so a routing failure must not surface
    // as an end-user error.
    if (validated.reason) {
      try {
        await routeFeedbackAction({
          entryId: validated.entryId,
          reason: validated.reason,
          agentId: validated.agentId,
          note: validated.note,
        });
      } catch (err) {
        logger.warn(
          { error: (err as Error).message, entryId: validated.entryId, reason: validated.reason },
          "feedback routing failed",
        );
      }
    }
    logger.info(
      { entryId, signal: validated.signal, reason: validated.reason, newAuthority },
      "feedback skill applied",
    );
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
