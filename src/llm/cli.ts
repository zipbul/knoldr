import { logger } from "../observability/logger";
import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

interface CliConfig {
  name: string;
  command: string[];
  model: string;
  mode: "codex" | "generic"; // codex uses -o file + stdin, generic uses -p + stdout
}

// Verified against OpenAI Codex docs + gemini CLI probe:
//
// - Codex on ChatGPT Plus accepts `gpt-5.4`, `gpt-5.4-mini`,
//   `gpt-5.3-codex`, `gpt-5.3-codex-spark`, `gpt-5.2`. The common
//   API-style names (`gpt-5-mini`, `gpt-4o-mini`, `o4-mini`, …) are
//   rejected because Codex uses its own Codex-tier naming. `gpt-5.4-mini`
//   is the efficient pick for knoldr's JSON-extraction workload —
//   running this on the default `gpt-5.4` burned the Plus daily cap
//   in a single research storm.
// - Gemini CLI v0.37.2 accepts `gemini-2.5-flash-lite` with its own
//   quota bucket (separate from `gemini-2.5-flash`). Right pick for
//   the same reason.
const CODEX_MODEL = "gpt-5.4-mini";
const GEMINI_MODEL = "gemini-2.5-flash-lite";

function getCliConfigs(): CliConfig[] {
  const codexCli = process.env.KNOLDR_CODEX_CLI ?? "codex";
  const geminiCli = process.env.KNOLDR_GEMINI_CLI ?? "gemini";

  return [
    { name: "codex", command: codexCli.split(/\s+/), model: CODEX_MODEL, mode: "codex" },
    { name: "gemini", command: geminiCli.split(/\s+/), model: GEMINI_MODEL, mode: "generic" },
  ];
}

// ---- Quota circuit breaker ----
// When a CLI returns "usage limit" / "QUOTA_EXHAUSTED" etc. there is no
// point retrying for hours. We remember the outage per-CLI and skip
// calls until the cooldown elapses.
const CIRCUIT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const QUOTA_SIGNALS = [
  "usage limit",
  "quota",
  "rate limit",
  "quota_exhausted",
  "terminalquotaerror",
  "resource has been exhausted",
];

const unhealthyUntil = new Map<string, number>();

function isCliHealthy(name: string): boolean {
  const until = unhealthyUntil.get(name);
  if (!until) return true;
  if (Date.now() >= until) {
    unhealthyUntil.delete(name);
    return true;
  }
  return false;
}

function markCliUnhealthy(name: string, err: Error): void {
  const msg = err.message.toLowerCase();
  if (QUOTA_SIGNALS.some((s) => msg.includes(s))) {
    unhealthyUntil.set(name, Date.now() + CIRCUIT_COOLDOWN_MS);
    logger.warn(
      { cli: name, cooldownMs: CIRCUIT_COOLDOWN_MS },
      "CLI quota-blocked — circuit opened",
    );
  }
}

/**
 * Call an LLM CLI with a prompt. Tries primary CLI first, falls back to the other.
 * Returns the raw stdout/output text.
 */
export async function callLlm(prompt: string): Promise<string> {
  const configs = getCliConfigs();
  let lastError: Error | null = null;

  for (const cli of configs) {
    if (!isCliHealthy(cli.name)) continue;
    try {
      const output = await callSingleCli(cli, prompt);
      return output;
    } catch (err) {
      lastError = err as Error;
      markCliUnhealthy(cli.name, lastError);
      logger.warn({ cli: cli.name, error: lastError.message }, "LLM CLI failed, trying fallback");
    }
  }

  throw lastError ?? new Error("No LLM CLI available");
}

export interface LlmVote {
  cli: string;
  output: string;
}

/**
 * Invoke every configured CLI concurrently and return whichever finished
 * successfully. Used by claim verification to produce a cheap
 * cross-provider "jury" without a full Pyreez deliberation engine.
 */
export async function callAllLlms(prompt: string): Promise<LlmVote[]> {
  const configs = getCliConfigs().filter((c) => isCliHealthy(c.name));
  if (configs.length === 0) return [];

  const settled = await Promise.allSettled(
    configs.map(async (cli) => {
      const output = await callSingleCli(cli, prompt);
      return { cli: cli.name, output };
    }),
  );

  const votes: LlmVote[] = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i]!;
    if (result.status === "fulfilled") {
      votes.push(result.value);
    } else {
      const err = result.reason as Error;
      markCliUnhealthy(configs[i]!.name, err);
      logger.warn(
        { cli: configs[i]!.name, error: err.message },
        "LLM CLI failed in parallel call",
      );
    }
  }
  return votes;
}

async function callSingleCli(cli: CliConfig, prompt: string): Promise<string> {
  if (cli.mode === "codex") {
    return callCodex(cli.command, cli.model, prompt);
  }
  return callGeneric(cli.command, cli.model, prompt);
}

async function callCodex(command: string[], model: string, prompt: string): Promise<string> {
  const tmpDir = await mkdtemp(join(tmpdir(), "knoldr-llm-"));
  const outFile = join(tmpDir, "output.txt");
  const modelArgs = model ? ["-m", model] : [];

  try {
    const proc = Bun.spawn([...command, "exec", "--skip-git-repo-check", ...modelArgs, "-", "-o", outFile], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: new TextEncoder().encode(prompt),
      env: { ...process.env },
    });

    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      // Codex banner alone is ~300 chars; the actual error (e.g.
      // "You've hit your usage limit") comes after. 1500 chars
      // ensures circuit breaker can match quota keywords.
      throw new Error(`codex exited ${exitCode}: ${stderr.slice(0, 1500)}`);
    }

    return await readFile(outFile, "utf-8");
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function callGeneric(command: string[], model: string, prompt: string): Promise<string> {
  const modelArgs = model ? ["-m", model] : [];
  const proc = Bun.spawn([...command, ...modelArgs, "-p", prompt], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`${command[0]} exited ${exitCode}: ${stderr.slice(0, 500)}`);
  }

  return stdout;
}

/**
 * Extract JSON from CLI output, handling markdown code fences and surrounding text.
 */
export function extractJson(text: string): unknown {
  try { return JSON.parse(text); } catch { /* ignore */ }

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1]!.trim()); } catch { /* ignore */ }
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* ignore */ }
  }

  throw new Error(`Could not extract JSON from CLI output: ${text.slice(0, 500)}`);
}
