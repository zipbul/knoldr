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

  // LLM: Codex CLI subprocess — check if binary exists on PATH
  let llmApiStatus = "unconfigured";
  try {
    const codexCli = process.env.KNOLDR_CODEX_CLI ?? "codex";
    const which = Bun.spawnSync(["which", codexCli]);
    llmApiStatus = which.exitCode === 0 ? "up" : "down";
  } catch {
    llmApiStatus = "down";
  }
  return {
    db: dbStatus,
    llmApi: llmApiStatus,
    embedding: "local", // @huggingface/transformers, no API key needed
    uptime: process.uptime(),
    entryCount,
    latencyMs: Date.now() - startTime,
  };
}
