import { logger } from "../observability/logger";

const SEARCH_DELAY_MS = 1500;
let lastSearchTime = 0;

interface SearchEngine {
  name: string;
  url: (query: string) => string;
  /** CSS selector or regex to extract result URLs from rendered page */
  extract: (html: string) => string[];
}

const ENGINES: SearchEngine[] = [
  {
    name: "google",
    url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&num=10&hl=en`,
    extract: (html) => {
      const urls: string[] = [];
      // Google result links: /url?q=... or direct href in result containers
      for (const m of html.matchAll(/\/url\?q=(https?:\/\/[^&"]+)/g)) {
        urls.push(decodeURIComponent(m[1]!));
      }
      // Also try direct hrefs (newer Google layouts)
      for (const m of html.matchAll(/href="(https?:\/\/(?!www\.google\.|accounts\.google\.|maps\.google\.|support\.google\.|policies\.google\.)[^"]+)"/g)) {
        urls.push(m[1]!);
      }
      return urls;
    },
  },
  {
    name: "bing",
    url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=10`,
    extract: (html) => {
      const urls: string[] = [];
      // Bing organic results use <a href="..."> inside <li class="b_algo">
      for (const m of html.matchAll(/href="(https?:\/\/(?!www\.bing\.com|login\.microsoftonline|go\.microsoft\.com)[^"]+)"/g)) {
        urls.push(m[1]!);
      }
      return urls;
    },
  },
  {
    name: "duckduckgo",
    url: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
    extract: (html) => {
      const urls: string[] = [];
      // DDG result links: uddg= redirect or data-href
      for (const m of html.matchAll(/uddg=(https?%3A%2F%2F[^&"]+)/g)) {
        urls.push(decodeURIComponent(m[1]!));
      }
      for (const m of html.matchAll(/href="(https?:\/\/(?!duckduckgo\.com|duck\.com)[^"]+)"/g)) {
        urls.push(m[1]!);
      }
      return urls;
    },
  },
  {
    name: "brave",
    url: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}&source=web`,
    extract: (html) => {
      const urls: string[] = [];
      for (const m of html.matchAll(/href="(https?:\/\/(?!search\.brave\.com|brave\.com)[^"]+)"/g)) {
        urls.push(m[1]!);
      }
      return urls;
    },
  },
  {
    name: "yahoo",
    url: (q) => `https://search.yahoo.com/search?p=${encodeURIComponent(q)}&n=10`,
    extract: (html) => {
      const urls: string[] = [];
      // Yahoo wraps results in RU= redirect URLs
      for (const m of html.matchAll(/RU=(https?%3A%2F%2F[^/&"]+[^"]*)/g)) {
        urls.push(decodeURIComponent(m[1]!));
      }
      for (const m of html.matchAll(/href="(https?:\/\/(?!search\.yahoo\.com|login\.yahoo\.com|yahoo\.com\/)[^"]+)"/g)) {
        urls.push(m[1]!);
      }
      return urls;
    },
  },
  {
    name: "yandex",
    url: (q) => `https://yandex.com/search/?text=${encodeURIComponent(q)}&lr=84`,
    extract: (html) => {
      const urls: string[] = [];
      for (const m of html.matchAll(/href="(https?:\/\/(?!yandex\.|ya\.ru)[^"]+)"/g)) {
        urls.push(m[1]!);
      }
      return urls;
    },
  },
];

const JUNK_HOSTS = new Set([
  "accounts.google.com", "support.google.com", "policies.google.com",
  "maps.google.com", "play.google.com", "translate.google.com",
  "login.microsoftonline.com", "go.microsoft.com",
  "login.yahoo.com", "mail.yahoo.com",
]);

function isJunkUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (JUNK_HOSTS.has(u.hostname)) return true;
    // Skip common non-content extensions
    if (/\.(css|js|png|jpg|gif|svg|ico|woff2?)$/i.test(u.pathname)) return true;
    return false;
  } catch {
    return true;
  }
}

/**
 * Search all engines in parallel using Playwright, merge results.
 */
async function searchAllEngines(query: string): Promise<string[]> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });

  try {
    const results = await Promise.allSettled(
      ENGINES.map(async (engine) => {
        const context = await browser.newContext({
          userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        });
        const page = await context.newPage();

        try {
          await page.goto(engine.url(query), { waitUntil: "domcontentloaded", timeout: 15000 });
          // Give JS time to render results
          await page.waitForTimeout(2000);
          const html = await page.content();
          const urls = engine.extract(html).filter((u) => !isJunkUrl(u));
          if (urls.length > 0) {
            logger.debug({ engine: engine.name, query, count: urls.length }, "search engine returned results");
          }
          return urls;
        } catch (err) {
          logger.warn({ engine: engine.name, query, error: (err as Error).message }, "search engine failed");
          return [];
        } finally {
          await context.close();
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
  } finally {
    await browser.close();
  }
}

/**
 * Collect seed URLs from multiple search queries.
 * Runs Google, Bing, DuckDuckGo, Brave, Yahoo, Yandex in parallel via Playwright.
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

    const urls = await searchAllEngines(query);
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
