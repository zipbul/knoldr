import { research } from "../../collect/research";
import { researchTotal } from "../../observability/metrics";

export async function handleResearch(input: Record<string, unknown>) {
  const topic = input.topic as string;
  if (!topic) throw new Error("'topic' is required for research skill");

  const result = await research({
    topic,
    domain: input.domain as string | undefined,
    maxEntries: input.maxEntries as number | undefined,
    includeYoutube: input.includeYoutube as boolean | undefined,
  });

  researchTotal.inc({ status: result.status });

  return result;
}
