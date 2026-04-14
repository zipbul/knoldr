import { logger } from "../observability/logger";

const MAX_TOKENS = 256; // all-MiniLM-L6-v2 max token limit
const EMBEDDING_DIM = 384;

// If KNOLDR_EMBEDDING_BASE_URL is set, use HTTP API (for testing with mock server).
// Otherwise, use local @huggingface/transformers model.
const USE_LOCAL = !process.env.KNOLDR_EMBEDDING_BASE_URL;

let pipelineInstance: ((text: string, opts?: Record<string, unknown>) => Promise<{ tolist: () => number[][] }>) | null = null;

async function getPipeline() {
  if (!pipelineInstance) {
    const { pipeline } = await import("@huggingface/transformers");
    pipelineInstance = (await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      dtype: "q8",
    })) as unknown as typeof pipelineInstance;
    logger.info("local embedding model loaded: all-MiniLM-L6-v2 (384dim, q8)");
  }
  return pipelineInstance!;
}

function estimateTokens(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).length / 4);
}

function truncateToTokenLimit(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;

  const sentences = text.split(/(?<=[.!?])\s+/);
  let result = "";
  for (const sentence of sentences) {
    const candidate = result ? `${result} ${sentence}` : sentence;
    if (estimateTokens(candidate) > maxTokens) break;
    result = candidate;
  }
  return result || text.slice(0, maxTokens * 4);
}

export function buildEmbeddingInput(title: string, content: string): string {
  const combined = `${title}\n\n${content}`;
  return truncateToTokenLimit(combined, MAX_TOKENS);
}

export async function generateEmbedding(text: string): Promise<number[]> {
  if (USE_LOCAL) {
    const pipe = await getPipeline();
    const output = await pipe(text, { pooling: "mean", normalize: true });
    return output.tolist()[0]!;
  }
  return generateEmbeddingApi(text);
}

// --- API fallback (for testing with mock server) ---

async function generateEmbeddingApi(text: string): Promise<number[]> {
  const baseUrl = process.env.KNOLDR_EMBEDDING_BASE_URL!;
  const apiKey = process.env.KNOLDR_EMBEDDING_API_KEY ?? "test";

  const res = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: "test", input: text }),
  });

  if (!res.ok) throw new Error(`Embedding API error ${res.status}`);
  const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return json.data[0]?.embedding ?? new Array(EMBEDDING_DIM).fill(0);
}
