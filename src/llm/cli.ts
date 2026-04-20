import { logger } from "../observability/logger";

/**
 * Structured prompt: SYSTEM instructions (authored by us, trusted) and
 * USER content (sourced from crawled web / agent inputs, untrusted).
 *
 * Ollama's `/api/chat` takes a messages array with `role: "system" |
 * "user"`; routing user content through the USER role is the model's
 * own defense against prompt injection and is stronger than any
 * regex-based scrub of the prompt body.
 */
export interface StructuredPrompt {
  system: string;
  user: string;
}

type PromptInput = string | StructuredPrompt;

function asStructured(p: PromptInput): StructuredPrompt {
  if (typeof p === "string") return { system: "", user: p };
  return p;
}

interface LlmTarget {
  name: string;
  model: string;
}

// Env is read at call time (not module load) so tests / hot-reload
// paths can redirect OLLAMA_HOST without re-importing.
const ollamaHost = () => process.env.OLLAMA_HOST ?? "http://localhost:11434";
const fastModel = () => process.env.KNOLDR_OLLAMA_FAST_MODEL ?? "gemma4:e4b";
const juryModels = () =>
  (process.env.KNOLDR_OLLAMA_JURY_MODELS ?? "gemma4:e4b,qwen2.5:14b")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const ollamaTimeoutMs = () =>
  Number(process.env.KNOLDR_OLLAMA_TIMEOUT_MS ?? 120_000);

function getFastTargets(): LlmTarget[] {
  return [{ name: `ollama:${fastModel()}`, model: fastModel() }];
}

function getJuryTargets(): LlmTarget[] {
  return juryModels().map((m) => ({ name: `ollama:${m}`, model: m }));
}

// ---- Health circuit breaker ----
// Skip a model for a cooldown window after repeated failures so a
// single broken model doesn't stall the whole verify queue. Ollama
// surfaces "model not found" / connection failures that we don't
// want to retry on every tick.
const CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;
const unhealthyUntil = new Map<string, number>();

function isHealthy(name: string): boolean {
  const until = unhealthyUntil.get(name);
  if (!until) return true;
  if (Date.now() >= until) {
    unhealthyUntil.delete(name);
    return true;
  }
  return false;
}

function markUnhealthy(name: string): void {
  unhealthyUntil.set(name, Date.now() + CIRCUIT_COOLDOWN_MS);
  logger.warn({ model: name, cooldownMs: CIRCUIT_COOLDOWN_MS }, "model marked unhealthy");
}

/**
 * Call the primary fast-path LLM. Uses KNOLDR_OLLAMA_FAST_MODEL.
 * Throws if the model is unhealthy or the call fails — caller must
 * handle the failure gracefully (no silent fallback).
 */
export async function callLlm(prompt: PromptInput): Promise<string> {
  const structured = asStructured(prompt);
  const targets = getFastTargets();
  let lastError: Error | null = null;

  for (const t of targets) {
    if (!isHealthy(t.name)) continue;
    try {
      return await callOllama(t.model, structured);
    } catch (err) {
      lastError = err as Error;
      markUnhealthy(t.name);
      logger.warn({ model: t.name, error: lastError.message }, "LLM call failed");
    }
  }

  throw lastError ?? new Error("No healthy LLM target available");
}

export interface LlmVote {
  cli: string;
  output: string;
}

/**
 * Fan out to every healthy jury model in parallel. Used by claim
 * verification to collect diverse votes from KNOLDR_OLLAMA_JURY_MODELS
 * (expected 2+ distinct local models for architectural diversity).
 */
export async function callAllLlms(prompt: PromptInput): Promise<LlmVote[]> {
  const targets = getJuryTargets().filter((t) => isHealthy(t.name));
  if (targets.length === 0) return [];

  const structured = asStructured(prompt);
  const settled = await Promise.allSettled(
    targets.map(async (t) => {
      const output = await callOllama(t.model, structured);
      return { cli: t.name, output };
    }),
  );

  const votes: LlmVote[] = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i]!;
    if (result.status === "fulfilled") {
      votes.push(result.value);
    } else {
      const err = result.reason as Error;
      markUnhealthy(targets[i]!.name);
      logger.warn(
        { model: targets[i]!.name, error: err.message },
        "jury model failed",
      );
    }
  }
  return votes;
}

async function callOllama(model: string, prompt: StructuredPrompt): Promise<string> {
  // /api/chat returns a message per exchange; we use stream:false and
  // format:"json" to force strict JSON output. Role separation
  // (system vs user) routes untrusted text through the model's own
  // instruction-isolation path — stronger than regex sanitization.
  const messages = prompt.system
    ? [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ]
    : [{ role: "user", content: prompt.user }];
  const res = await fetch(`${ollamaHost()}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      format: "json",
      options: { temperature: 0.1, num_ctx: 8192 },
    }),
    signal: AbortSignal.timeout(ollamaTimeoutMs()),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ollama ${model} HTTP ${res.status}: ${body.slice(0, 500)}`);
  }
  const json = (await res.json()) as {
    message?: { content?: string };
    error?: string;
  };
  if (json.error) throw new Error(`ollama ${model} error: ${json.error}`);
  const content = json.message?.content;
  if (!content) throw new Error(`ollama ${model} empty response`);
  return content;
}

/**
 * Extract JSON from model output. Ollama with format:"json" emits
 * clean JSON, but we keep the fence + substring extractors as a
 * safety net for models that occasionally append a trailing
 * explanation or wrap their answer in a prose preamble.
 */
export function extractJson(text: string): unknown {
  try { return JSON.parse(text); } catch { /* ignore */ }

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1]!.trim()); } catch { /* ignore */ }
  }

  const candidates: Array<[string, string]> = [
    ["{", "}"],
    ["[", "]"],
  ];
  for (const [open, close] of candidates) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start !== -1 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch { /* ignore */ }
    }
  }

  throw new Error(`Could not extract JSON from model output: ${text.slice(0, 500)}`);
}
