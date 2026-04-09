import { logger } from "../observability/logger";

const SEARCH_DELAY_MS = 2000;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 5000;
let lastSearchTime = 0;

/**
 * Scrape search results from DuckDuckGo Lite.
 * No API key, no JS rendering, no CAPTCHA.
 * Returns up to ~10 URLs per query.
 */
async function scrapeDuckDuckGoLite(query: string): Promise<string[]> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        },
        signal: AbortSignal.timeout(10000),
      });

      // 202 = rate limited, retry with backoff
      if (res.status === 202) {
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_BACKOFF_MS * (attempt + 1);
          logger.warn({ query, attempt, delay }, "DuckDuckGo rate limited (202), retrying");
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        logger.warn({ query }, "DuckDuckGo rate limited, exhausted retries");
        return [];
      }

      if (!res.ok) return [];

      const html = await res.text();

      // DDG Lite wraps result URLs in redirect links: //duckduckgo.com/l/?uddg=<encoded_url>
      const matches = [...html.matchAll(/uddg=(https?%3A%2F%2F[^&"]+)/g)];
      const urls = matches.map((m) => decodeURIComponent(m[1]!));

      logger.debug({ query, resultCount: urls.length }, "DuckDuckGo Lite search scraped");
      return urls;
    } catch (err) {
      logger.warn({ query, attempt, error: (err as Error).message }, "DuckDuckGo Lite scrape failed");
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
        continue;
      }
      return [];
    }
  }
  return [];
}

/**
 * Collect seed URLs from multiple search queries.
 * Uses DuckDuckGo Lite (plain HTTP, no JS, no API key).
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
    // Rate limit
    const elapsed = Date.now() - lastSearchTime;
    if (elapsed < SEARCH_DELAY_MS) {
      await new Promise((r) => setTimeout(r, SEARCH_DELAY_MS - elapsed));
    }
    lastSearchTime = Date.now();

    const urls = await scrapeDuckDuckGoLite(query);
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
