/**
 * Mock external API servers for testing.
 * Mocks: Anthropic LLM API, OpenAI Embedding API.
 */

interface MockEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
}

/** Create a deterministic fake embedding (1536-dim, based on text hash) */
export function fakeEmbedding(text: string): number[] {
  const vec = new Array(1536).fill(0);
  for (let i = 0; i < text.length && i < 1536; i++) {
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
let llmServer: ReturnType<typeof Bun.serve> | null = null;

// Track custom handlers for per-test overrides
let llmHandler: ((body: unknown) => unknown) | null = null;

export function setLlmHandler(handler: ((body: unknown) => unknown) | null) {
  llmHandler = handler;
}

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

/** Start mock LLM API server (Anthropic Messages API) */
export function startMockLlmServer(port = 19877) {
  llmServer = Bun.serve({
    port,
    fetch(req) {
      if (req.method === "POST" && new URL(req.url).pathname === "/v1/messages") {
        return req.json().then((body: unknown) => {
          if (llmHandler) {
            return Response.json(llmHandler(body));
          }

          // Default: return a single decomposed entry
          return Response.json({
            content: [
              {
                type: "tool_use",
                id: "call_1",
                name: "store_entries",
                input: {
                  entries: [
                    {
                      title: "Test Entry",
                      content: "This is test content from LLM decomposition.",
                      domain: ["testing"],
                      tags: ["unit-test"],
                      language: "en",
                      decayRate: 0.01,
                    },
                  ],
                },
              },
            ],
            stop_reason: "tool_use",
          });
        });
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  return llmServer;
}

/** Stop all mock servers */
export function stopMockServers() {
  if (embeddingServer) {
    embeddingServer.stop();
    embeddingServer = null;
  }
  if (llmServer) {
    llmServer.stop();
    llmServer = null;
  }
  llmHandler = null;
}
