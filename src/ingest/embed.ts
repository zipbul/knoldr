import { logger } from "../observability/logger";

const MAX_TOKENS = 8000;

function getEmbeddingConfig() {
  return {
    baseUrl: process.env.KNOLDR_EMBEDDING_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: process.env.KNOLDR_EMBEDDING_API_KEY,
    model: process.env.KNOLDR_EMBEDDING_MODEL ?? "text-embedding-3-small",
  };
}

// Rough token estimate: 1 token ≈ 4 bytes (conservative for mixed content)
function estimateTokens(text: string): number {
  return Math.ceil(new TextEncoder().encode(text).length / 4);
}

function truncateToTokenLimit(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;

  // Truncate at sentence boundaries
  const sentences = text.split(/(?<=[.!?])\s+/);
  let result = "";
  for (const sentence of sentences) {
    const candidate = result ? `${result} ${sentence}` : sentence;
    if (estimateTokens(candidate) > maxTokens) break;
    result = candidate;
  }
  return result || text.slice(0, maxTokens * 4); // fallback: rough byte cut
}

export function buildEmbeddingInput(title: string, content: string): string {
  const combined = `${title}\n\n${content}`;
  return truncateToTokenLimit(combined, MAX_TOKENS);
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const { apiKey, baseUrl, model } = getEmbeddingConfig();
  if (!apiKey) {
    throw new Error("KNOLDR_EMBEDDING_API_KEY environment variable is required");
  }

  const url = `${baseUrl}/embeddings`;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: text,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Embedding API error ${res.status}: ${body}`);
      }

      const json = (await res.json()) as {
        data: Array<{ embedding: number[] }>;
      };

      const embedding = json.data[0]?.embedding;
      if (!embedding) {
        throw new Error("Embedding API returned no data");
      }

      return embedding;
    } catch (err) {
      lastError = err as Error;
      logger.warn({ attempt, error: lastError.message }, "embedding API attempt failed");
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
  }

  throw lastError!;
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const { apiKey, baseUrl, model } = getEmbeddingConfig();
  if (!apiKey) {
    throw new Error("KNOLDR_EMBEDDING_API_KEY environment variable is required");
  }

  const url = `${baseUrl}/embeddings`;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: texts,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Embedding API error ${res.status}: ${body}`);
      }

      const json = (await res.json()) as {
        data: Array<{ embedding: number[]; index: number }>;
      };

      // Sort by index to maintain order
      return json.data
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
    } catch (err) {
      lastError = err as Error;
      logger.warn({ attempt, error: lastError.message }, "embedding batch API attempt failed");
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
  }

  throw lastError!;
}
