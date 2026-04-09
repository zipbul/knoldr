import { callLlm, extractJson } from "../llm/cli";
import { logger } from "../observability/logger";

const SEARCH_DELAY_MS = 2000;
const MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = 3000;
let lastSearchTime = 0;

type UrlSource = (query: string) => Promise<string[]>;

const SOURCES: { name: string; fn: UrlSource }[] = [
  { name: "llm", fn: llmSuggestUrls },
  { name: "duckduckgo", fn: scrapeDuckDuckGoLite },
  { name: "brave", fn: scrapeBrave },
];

/**
 * Run all URL sources in parallel and merge results.
 */
async function collectFromAllSources(query: string): Promise<string[]> {
  const results = await Promise.allSettled(
    SOURCES.map(async (source) => {
      try {
        const urls = await source.fn(query);
        if (urls.length > 0) {
          logger.debug({ source: source.name, query, count: urls.length }, "URL source returned results");
        }
        return urls;
      } catch (err) {
        logger.warn({ source: source.name, query, error: (err as Error).message }, "URL source failed");
        return [];
      }
    }),
  );

  const allUrls = new Set<string>();
  for (const result of results) {
    if (result.status === "fulfilled") {
      for (const url of result.value) {
        allUrls.add(url);
      }
    }
  }
  return [...allUrls];
}

/**
 * Ask LLM to suggest authoritative URLs for a topic.
 */
async function llmSuggestUrls(query: string): Promise<string[]> {
  const prompt = `List 5-10 real, authoritative URLs where I can find information about: "${query}"

Include official docs, research papers, reputable blogs, and GitHub repos.
Only include URLs you are confident actually exist.

Respond with JSON only: { "urls": ["https://...", ...] }`;

  const output = await callLlm(prompt);
  const json = extractJson(output) as { urls?: string[] };
  if (!json.urls || !Array.isArray(json.urls)) return [];

  return json.urls
    .filter((u): u is string => typeof u === "string" && u.startsWith("https://"))
    .slice(0, 10);
}

async function scrapeDuckDuckGoLite(query: string): Promise<string[]> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (res.status === 202) {
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)));
        continue;
      }
      return [];
    }

    if (!res.ok) return [];

    const html = await res.text();
    const matches = [...html.matchAll(/uddg=(https?%3A%2F%2F[^&"]+)/g)];
    return matches.map((m) => decodeURIComponent(m[1]!));
  }
  return [];
}

async function scrapeBrave(query: string): Promise<string[]> {
  const res = await fetch(`https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) return [];

  const html = await res.text();
  const urls: string[] = [];
  const seen = new Set<string>();

  for (const m of html.matchAll(/href="(https?:\/\/(?!search\.brave\.com|brave\.com)[^"]+)"/g)) {
    const url = m[1]!;
    if (!isJunkUrl(url) && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }

  return urls;
}

function isJunkUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host.includes("brave.com") || host.includes("google.com") ||
      host.includes("googleapis.com") || host.includes("gstatic.com");
  } catch {
    return true;
  }
}

/**
 * Collect seed URLs from multiple search queries.
 * Runs LLM + DuckDuckGo + Brave in parallel per query, merges all results.
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

    const urls = await collectFromAllSources(query);
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
