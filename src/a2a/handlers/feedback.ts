import { processFeedback } from "../../score/feedback";
import { feedbackInputSchema } from "../../ingest/validate";

export async function handleFeedback(input: Record<string, unknown>) {
  const validated = feedbackInputSchema.parse(input);
  return await processFeedback(
    validated.entryId,
    validated.signal,
    validated.reason,
    validated.agentId,
  );
}
