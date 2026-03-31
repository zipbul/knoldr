import { explore } from "../../search/search";
import { exploreInputSchema } from "../../ingest/validate";

export async function handleExplore(input: Record<string, unknown>) {
  const validated = exploreInputSchema.parse(input);
  return await explore(validated);
}
