/**
 * Mock external API servers for testing.
 * Mocks: OpenAI Embedding API (HTTP server).
 * LLM mocking: via KNOLDR_CODEX_CLI env pointing to mock-codex.ts script.
 */
import { join } from "path";

interface MockEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
}

/** Create a deterministic fake embedding (1536-dim, based on text hash) */
export function fakeEmbedding(text: string): number[] {
  const vec = new Array(384).fill(0);
  for (let i = 0; i < text.length && i < 384; i++) {
    vec[i] = (text.charCodeAt(i) % 100) / 100;
  }
  return vec;
}

/** Create a similar but not identical embedding (for dedup testing) */
export function similarEmbedding(base: number[], similarity: number): number[] {
  return base.map((v) => {
    const noise = (1 - similarity) * (Math.random() - 0.5) * 2;
    return Math.max(0, Math.min(1, v + noise));
  });
}

let embeddingServer: ReturnType<typeof Bun.serve> | null = null;

/** Start mock embedding API server */
export function startMockEmbeddingServer(port = 19876) {
  embeddingServer = Bun.serve({
    port,
    fetch(req) {
      if (req.method === "POST" && new URL(req.url).pathname === "/embeddings") {
        return req.json().then((body: { input: string | string[] }) => {
          const inputs = Array.isArray(body.input) ? body.input : [body.input];
          const response: MockEmbeddingResponse = {
            data: inputs.map((text, index) => ({
              embedding: fakeEmbedding(text),
              index,
            })),
          };
          return Response.json(response);
        });
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  return embeddingServer;
}

/** Stop all mock servers */
export function stopMockServers() {
  if (embeddingServer) {
    embeddingServer.stop();
    embeddingServer = null;
  }
}

/** Path to mock Codex CLI script */
export const MOCK_CODEX_CLI = `bun ${join(__dirname, "mock-codex.ts")}`;

/**
 * Set mock Codex CLI handler mode via env var.
 * Modes: "default", "multi", "empty", "fail", "bad-json", "language:XX"
 */
export function setCodexHandler(mode: string | null) {
  if (mode) {
    process.env.MOCK_CODEX_HANDLER = mode;
  } else {
    delete process.env.MOCK_CODEX_HANDLER;
  }
}
