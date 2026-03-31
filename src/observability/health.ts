import { db } from "../db/connection";
import { entry } from "../db/schema";
import { count } from "drizzle-orm";

export async function getHealthStatus() {
  const startTime = Date.now();

  let dbStatus = "down";
  let entryCount = 0;

  try {
    const result = await db.select({ cnt: count() }).from(entry);
    entryCount = result[0]?.cnt ?? 0;
    dbStatus = "up";
  } catch {
    dbStatus = "down";
  }

  // LLM/Embedding health: check if env vars are configured (actual connectivity checked lazily)
  const llmApiStatus = process.env.KNOLDR_LLM_API_KEY ? "up" : "unconfigured";
  const embeddingApiStatus = process.env.KNOLDR_EMBEDDING_API_KEY ? "up" : "unconfigured";

  return {
    db: dbStatus,
    llmApi: llmApiStatus,
    embeddingApi: embeddingApiStatus,
    uptime: process.uptime(),
    entryCount,
    latencyMs: Date.now() - startTime,
  };
}
