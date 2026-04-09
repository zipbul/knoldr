import { logger } from "../observability/logger";
import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

interface CliConfig {
  name: string;
  command: string[];
  mode: "codex" | "generic"; // codex uses -o file + stdin, generic uses -p + stdout
}

function getCliConfigs(): CliConfig[] {
  const codexCli = process.env.KNOLDR_CODEX_CLI ?? "codex";
  const geminiCli = process.env.KNOLDR_GEMINI_CLI ?? "gemini";

  return [
    { name: "codex", command: codexCli.split(/\s+/), mode: "codex" },
    { name: "gemini", command: geminiCli.split(/\s+/), mode: "generic" },
  ];
}

/**
 * Call an LLM CLI with a prompt. Tries primary CLI first, falls back to the other.
 * Returns the raw stdout/output text.
 */
export async function callLlm(prompt: string): Promise<string> {
  const configs = getCliConfigs();
  let lastError: Error | null = null;

  for (const cli of configs) {
    try {
      const output = await callSingleCli(cli, prompt);
      return output;
    } catch (err) {
      lastError = err as Error;
      logger.warn({ cli: cli.name, error: lastError.message }, "LLM CLI failed, trying fallback");
    }
  }

  throw lastError ?? new Error("No LLM CLI available");
}

async function callSingleCli(cli: CliConfig, prompt: string): Promise<string> {
  if (cli.mode === "codex") {
    return callCodex(cli.command, prompt);
  }
  return callGeneric(cli.command, prompt);
}

async function callCodex(command: string[], prompt: string): Promise<string> {
  const tmpDir = await mkdtemp(join(tmpdir(), "knoldr-llm-"));
  const outFile = join(tmpDir, "output.txt");

  try {
    const proc = Bun.spawn([...command, "exec", "--skip-git-repo-check", "-", "-o", outFile], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: new TextEncoder().encode(prompt),
      env: { ...process.env },
    });

    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`codex exited ${exitCode}: ${stderr.slice(0, 500)}`);
    }

    return await readFile(outFile, "utf-8");
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function callGeneric(command: string[], prompt: string): Promise<string> {
  const proc = Bun.spawn([...command, "-p", prompt], {
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
