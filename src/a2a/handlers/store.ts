import { ingest } from "../../ingest/engine";
import { parseStoreInput } from "../../ingest/validate";

export async function handleStore(input: Record<string, unknown>) {
  const validated = parseStoreInput(input);
  const results = await ingest(validated);
  return { entries: results };
}
