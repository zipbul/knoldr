import { ingest } from "../ingest/engine";
import { parseStoreInput } from "../ingest/validate";
import { logger } from "../observability/logger";

function getResearchConfig() {
  return {
    tavilyApiKey: process.env.KNOLDR_TAVILY_API_KEY,
    jinaApiKey: process.env.KNOLDR_JINA_API_KEY,
    llmApiKey: process.env.KNOLDR_LLM_API_KEY,
    llmBaseUrl: process.env.KNOLDR_LLM_BASE_URL ?? "https://api.anthropic.com",
    llmModel: process.env.KNOLDR_LLM_MODEL ?? "claude-haiku-4-5-20251001",
  };
}

interface ResearchInput {
  topic: string;
  domain?: string;
  maxEntries?: number;
}

interface ResearchResult {
  entries: Array<{ entryId: string; action: string }>;
  status: "completed" | "partial";
}

/** Generate search queries from topic via LLM */
async function generateQueries(topic: string): Promise<string[]> {
  const { llmApiKey, llmBaseUrl, llmModel } = getResearchConfig();
  if (!llmApiKey) throw new Error("KNOLDR_LLM_API_KEY required for research");

  const res = await fetch(`${llmBaseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": llmApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: llmModel,
      max_tokens: 512,
      tools: [
        {
          name: "search_queries",
          description: "Generate diverse search queries for research",
          input_schema: {
            type: "object",
            properties: {
              queries: {
                type: "array",
                items: { type: "string" },
                minItems: 3,
                maxItems: 5,
              },
            },
            required: ["queries"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "search_queries" },
      messages: [
        {
          role: "user",
          content: `Generate 3-5 diverse search queries to research: ${topic}`,
        },
      ],
    }),
  });

  if (!res.ok) throw new Error(`LLM API error ${res.status}: ${await res.text()}`);

  const json = (await res.json()) as {
    content: Array<{ type: string; name?: string; input?: { queries?: string[] } }>;
  };
  const toolUse = json.content.find((b) => b.type === "tool_use" && b.name === "search_queries");
  return toolUse?.input?.queries ?? [`${topic} overview`, `${topic} latest`];
}

/** Search via Tavily API */
async function tavilySearch(
  query: string,
): Promise<Array<{ url: string; title: string; rawContent?: string; score: number }>> {
  const { tavilyApiKey } = getResearchConfig();
  if (!tavilyApiKey) throw new Error("KNOLDR_TAVILY_API_KEY required for research");

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tavilyApiKey}`,
    },
    body: JSON.stringify({
      query,
      search_depth: "advanced",
      max_results: 10,
      include_raw_content: true,
    }),
  });

  if (!res.ok) throw new Error(`Tavily API error ${res.status}: ${await res.text()}`);

  const json = (await res.json()) as {
    results: Array<{ url: string; title: string; raw_content?: string; score: number }>;
  };

  return json.results.map((r) => ({
    url: r.url,
    title: r.title,
    rawContent: r.raw_content,
    score: r.score,
  }));
}

/** Fetch content via Jina Reader */
async function jinaFetch(url: string): Promise<string | null> {
  const { jinaApiKey } = getResearchConfig();
  if (!jinaApiKey) return null;

  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { Authorization: `Bearer ${jinaApiKey}`, Accept: "text/plain" },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Estimate sourceType from Tavily score */
function estimateSourceType(url: string, score: number): string {
  if (url.includes("github.com")) return "github_release";
  if (url.includes("arxiv.org")) return "research_paper";
  if (score > 0.8) return "established_blog";
  if (score > 0.5) return "community_forum";
  return "unknown";
}

/**
 * Research pipeline: LLM generates queries → Tavily search → Jina extract → Ingestion.
 * Timeout: 5 minutes. Budget: shared with v0.3 claim verification.
 */
export async function research(input: ResearchInput): Promise<ResearchResult> {
  const maxEntries = Math.min(input.maxEntries ?? 30, 50);
  const deadline = Date.now() + 5 * 60 * 1000; // 5 min timeout
  const allResults: Array<{ entryId: string; action: string }> = [];
  const seenUrls = new Set<string>();

  logger.info({ topic: input.topic, maxEntries }, "research started");

  // Step 1: Generate queries
  let queries: string[];
  try {
    queries = await generateQueries(input.topic);
  } catch (err) {
    logger.error({ error: (err as Error).message }, "failed to generate research queries");
    return { entries: [], status: "partial" };
  }

  logger.info({ queries }, "research queries generated");

  // Step 2: Search each query via Tavily
  for (const query of queries) {
    if (Date.now() > deadline || allResults.length >= maxEntries) break;

    let searchResults: Awaited<ReturnType<typeof tavilySearch>>;
    try {
      searchResults = await tavilySearch(query);
    } catch (err) {
      logger.warn({ query, error: (err as Error).message }, "tavily search failed");
      continue;
    }

    // Step 3: Fetch content and ingest
    for (const result of searchResults) {
      if (Date.now() > deadline || allResults.length >= maxEntries) break;
      if (seenUrls.has(result.url)) continue;
      seenUrls.add(result.url);

      // Use Tavily raw_content if available, otherwise Jina Reader
      let content = result.rawContent;
      if (!content || content.length < 100) {
        content = (await jinaFetch(result.url)) ?? "";
      }
      if (!content || content.length < 50) {
        logger.debug({ url: result.url }, "skipping URL, insufficient content");
        continue;
      }

      // Step 4: Ingest via Mode 1 (raw)
      const raw = `${result.title}\n\n${content}`;
      const sourceType = estimateSourceType(result.url, result.score);

      try {
        const storeInput = parseStoreInput({
          raw: raw.slice(0, 200_000),
          sources: [{ url: result.url, sourceType }],
        });
        const ingestResults = await ingest(storeInput);

        for (const r of ingestResults) {
          allResults.push({ entryId: r.entryId, action: r.action });
        }
      } catch (err) {
        logger.warn({ url: result.url, error: (err as Error).message }, "ingestion failed for research result");
      }
    }
  }

  const status = Date.now() > deadline ? "partial" : "completed";
  logger.info({ topic: input.topic, resultCount: allResults.length, status }, "research finished");

  return { entries: allResults, status };
}
