import { search } from "../../search/search";
import { queryInputSchema } from "../../ingest/validate";

export async function handleQuery(input: Record<string, unknown>) {
  const validated = queryInputSchema.parse(input);
  return await search(validated);
}
