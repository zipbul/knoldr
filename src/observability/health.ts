import { sql } from "drizzle-orm";
import { db } from "../db/connection";

// Cache CLI existence checks: the binaries don't appear / disappear
// between runs, and `Bun.spawnSync(["which", ...])` on every /health
// hit adds two fork()s per docker healthcheck tick. Re-check once a
// minute, which is plenty for human-debug accuracy.
interface CliCache {
  codex: boolean;
  gemini: boolean;
  at: number;
}
let cliCache: CliCache | null = null;
const CLI_TTL_MS = 60_000;

function checkCli(name: string): boolean {
  try {
    return Bun.spawnSync(["which", name]).exitCode === 0;
  } catch {
    return false;
  }
}

function getCliStatus(): { codex: boolean; gemini: boolean } {
  const now = Date.now();
  if (cliCache && now - cliCache.at < CLI_TTL_MS) {
    return { codex: cliCache.codex, gemini: cliCache.gemini };
  }
  const codexCli = process.env.KNOLDR_CODEX_CLI ?? "codex";
  const geminiCli = process.env.KNOLDR_GEMINI_CLI ?? "gemini";
  cliCache = {
    codex: checkCli(codexCli),
    gemini: checkCli(geminiCli),
    at: now,
  };
  return { codex: cliCache.codex, gemini: cliCache.gemini };
}

export async function getHealthStatus() {
  const startTime = Date.now();

  let dbStatus = "down";
  try {
    // Cheap liveness probe — no row scan. The previous implementation
    // called `SELECT COUNT(*) FROM entry` which was fine at 13k rows
    // but would regress to seconds at 10M, causing docker healthcheck
    // timeouts and pointless restart loops.
    await db.execute(sql`SELECT 1`);
    dbStatus = "up";
  } catch {
    dbStatus = "down";
  }

  const cli = getCliStatus();
  const llmApiStatus = cli.codex || cli.gemini ? "up" : "down";

  return {
    db: dbStatus,
    llmApi: llmApiStatus,
    embedding: "local",
    uptime: process.uptime(),
    latencyMs: Date.now() - startTime,
  };
}
