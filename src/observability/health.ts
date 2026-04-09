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

  // LLM: check if at least one CLI binary exists on PATH
  const codexCli = process.env.KNOLDR_CODEX_CLI ?? "codex";
  const geminiCli = process.env.KNOLDR_GEMINI_CLI ?? "gemini";
  const codexOk = Bun.spawnSync(["which", codexCli]).exitCode === 0;
  const geminiOk = Bun.spawnSync(["which", geminiCli]).exitCode === 0;
  const llmApiStatus = codexOk || geminiOk ? "up" : "down";
  return {
    db: dbStatus,
    llmApi: llmApiStatus,
    embedding: "local", // @huggingface/transformers, no API key needed
    uptime: process.uptime(),
    entryCount,
    latencyMs: Date.now() - startTime,
  };
}
