import { logger } from "../observability/logger";

const LANGSEARCH_ENDPOINT = "https://api.langsearch.com/v1/web-search";
const SEARCH_DELAY_MS = 500;
let lastSearchTime = 0;

interface LangSearchResponse {
  data?: {
    webPages?: {
      value?: Array<{ url?: string }>;
    };
  };
}

/**
 * Query LangSearch web search API.
 * Returns up to 10 high-quality URLs per query.
 */
async function queryLangSearch(query: string): Promise<string[]> {
  const apiKey = process.env.LANGSEARCH_API_KEY;
  if (!apiKey) {
    logger.error("LANGSEARCH_API_KEY not configured");
    return [];
  }

  try {
    const res = await fetch(LANGSEARCH_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, count: 10 }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      logger.warn({ query, status: res.status }, "LangSearch returned non-OK");
      return [];
    }

    const json = (await res.json()) as LangSearchResponse;
    const urls = (json.data?.webPages?.value ?? [])
      .map((p) => p.url ?? "")
      .filter((u) => u.startsWith("http"));

    logger.debug({ query, count: urls.length }, "LangSearch returned results");
    return urls;
  } catch (err) {
    logger.warn({ query, error: (err as Error).message }, "LangSearch request failed");
    return [];
  }
}

/**
 * Collect seed URLs from multiple search queries via LangSearch.
 */
export async function collectSeedUrls(
  subQueries: Array<{ main: string; expansions: string[] }>,
  focusDomains?: string[],
): Promise<string[]> {
  const allUrls = new Set<string>();

  const queries: string[] = [];
  for (const sq of subQueries) {
    queries.push(sq.main);
    for (const exp of sq.expansions) {
      queries.push(exp);
    }
  }

  for (const query of queries) {
    const elapsed = Date.now() - lastSearchTime;
    if (elapsed < SEARCH_DELAY_MS) {
      await new Promise((r) => setTimeout(r, SEARCH_DELAY_MS - elapsed));
    }
    lastSearchTime = Date.now();

    const urls = await queryLangSearch(query);
    for (const url of urls) {
      allUrls.add(url);
    }
  }

  // Prioritize focus domains
  if (focusDomains && focusDomains.length > 0) {
    const focused: string[] = [];
    const rest: string[] = [];
    for (const url of allUrls) {
      try {
        const hostname = new URL(url).hostname;
        if (focusDomains.some((d) => hostname === d || hostname.endsWith(`.${d}`))) {
          focused.push(url);
        } else {
          rest.push(url);
        }
      } catch {
        rest.push(url);
      }
    }
    return [...focused, ...rest];
  }

  return [...allUrls];
}
