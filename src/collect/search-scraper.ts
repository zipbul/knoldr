import { logger } from "../observability/logger";

/**
 * Scrape Google search results via Playwright.
 * No API key needed. Returns up to ~10 URLs per query.
 * Rate limited: 3 second delay between requests to avoid bot detection.
 */
export async function scrapeGoogleSearch(query: string): Promise<string[]> {
  try {
    const { chromium } = await import("playwright");

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "en-US",
    });
    const page = await context.newPage();

    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=10&hl=en`;
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 15000 });

    // Extract search result links
    const links = await page.evaluate(`
      Array.from(document.querySelectorAll("a[href]"))
        .map(a => a.href)
        .filter(href =>
          href.startsWith("http") &&
          !href.includes("google.com") &&
          !href.includes("googleapis.com") &&
          !href.includes("gstatic.com") &&
          !href.includes("youtube.com/results") &&
          !href.includes("accounts.google")
        )
    `) as string[];

    await browser.close();

    // Deduplicate and return
    const unique = [...new Set(links)];
    logger.debug({ query, resultCount: unique.length }, "Google search scraped");
    return unique;
  } catch (err) {
    logger.warn({ query, error: (err as Error).message }, "Google search scrape failed, trying DuckDuckGo");
    return scrapeDuckDuckGo(query);
  }
}

/**
 * Fallback: scrape DuckDuckGo search results.
 * Less aggressive bot detection than Google.
 */
async function scrapeDuckDuckGo(query: string): Promise<string[]> {
  try {
    const { chromium } = await import("playwright");

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000); // Wait for JS rendering

    const links = await page.evaluate(`
      Array.from(document.querySelectorAll("a[href]"))
        .map(a => a.href)
        .filter(href =>
          href.startsWith("http") &&
          !href.includes("duckduckgo.com") &&
          !href.includes("duck.co") &&
          !href.includes("about:") &&
          !href.includes("spread.duckduckgo")
        )
    `) as string[];

    await browser.close();

    const unique = [...new Set(links)];
    logger.debug({ query, resultCount: unique.length }, "DuckDuckGo search scraped");
    return unique;
  } catch (err) {
    logger.warn({ query, error: (err as Error).message }, "DuckDuckGo search scrape also failed");
    return [];
  }
}

const SEARCH_DELAY_MS = 3000; // 3 seconds between searches to avoid detection
let lastSearchTime = 0;

/**
 * Collect seed URLs from multiple search queries.
 * Rate limited, with Google → DuckDuckGo fallback.
 */
export async function collectSeedUrls(
  subQueries: Array<{ main: string; expansions: string[] }>,
  focusDomains?: string[],
): Promise<string[]> {
  const allUrls = new Set<string>();

  // Flatten: main + expansions
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

    const urls = await scrapeGoogleSearch(query);
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
