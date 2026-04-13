#!/usr/bin/env bun
/**
 * Benchmark LangSearch API vs current Playwright multi-engine scraping.
 * Compares: result count, unique domains, latency.
 */
import { collectSeedUrls } from "../src/collect/search-scraper";

const LANGSEARCH_KEY = process.env.LANGSEARCH_API_KEY ?? "";

if (!LANGSEARCH_KEY) {
  console.error("LANGSEARCH_API_KEY not set");
  process.exit(1);
}

const QUERIES = [
  "FActScore atomic factual evaluation",
  "Bun runtime performance",
  "Rust async runtime comparison",
  "xz-utils backdoor supply chain",
  "WebSocket scaling strategies",
];

interface Result {
  engine: string;
  query: string;
  urls: string[];
  latencyMs: number;
  error?: string;
}

async function queryLangSearch(query: string): Promise<Result> {
  const start = Date.now();
  try {
    const res = await fetch("https://api.langsearch.com/v1/web-search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LANGSEARCH_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, count: 10 }),
      signal: AbortSignal.timeout(30000),
    });
    const latencyMs = Date.now() - start;

    if (!res.ok) {
      return { engine: "langsearch", query, urls: [], latencyMs, error: `HTTP ${res.status}` };
    }

    const json = await res.json() as { data?: { webPages?: { value?: Array<{ url?: string }> } } };
    const urls = (json.data?.webPages?.value ?? []).map((p) => p.url ?? "").filter(Boolean);
    return { engine: "langsearch", query, urls, latencyMs };
  } catch (err) {
    return { engine: "langsearch", query, urls: [], latencyMs: Date.now() - start, error: (err as Error).message };
  }
}

async function queryPlaywright(query: string): Promise<Result> {
  const start = Date.now();
  try {
    const urls = await collectSeedUrls([{ main: query, expansions: [] }]);
    return { engine: "playwright", query, urls, latencyMs: Date.now() - start };
  } catch (err) {
    return { engine: "playwright", query, urls: [], latencyMs: Date.now() - start, error: (err as Error).message };
  }
}

function uniqueDomains(urls: string[]): string[] {
  const domains = new Set<string>();
  for (const url of urls) {
    try {
      domains.add(new URL(url).hostname.replace(/^www\./, ""));
    } catch { /* skip */ }
  }
  return [...domains];
}

async function main() {
  console.log(`\n=== Benchmark: LangSearch vs Playwright multi-engine ===\n`);
  console.log(`Queries: ${QUERIES.length}`);
  console.log();

  const results: Result[] = [];

  for (const query of QUERIES) {
    console.log(`[${query}]`);
    const [ls, pw] = await Promise.all([queryLangSearch(query), queryPlaywright(query)]);
    results.push(ls, pw);

    console.log(`  langsearch: ${ls.urls.length} urls, ${uniqueDomains(ls.urls).length} domains, ${ls.latencyMs}ms${ls.error ? ` ERR: ${ls.error}` : ""}`);
    console.log(`  playwright: ${pw.urls.length} urls, ${uniqueDomains(pw.urls).length} domains, ${pw.latencyMs}ms${pw.error ? ` ERR: ${pw.error}` : ""}`);
    console.log();
  }

  // Summary
  const lsResults = results.filter((r) => r.engine === "langsearch");
  const pwResults = results.filter((r) => r.engine === "playwright");
  const avg = (nums: number[]) => Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
  const sum = (nums: number[]) => nums.reduce((a, b) => a + b, 0);

  console.log("=== Summary ===");
  console.log(`                      LangSearch    Playwright`);
  console.log(`Total URLs:           ${String(sum(lsResults.map((r) => r.urls.length))).padEnd(14)}${sum(pwResults.map((r) => r.urls.length))}`);
  console.log(`Avg URLs/query:       ${String(avg(lsResults.map((r) => r.urls.length))).padEnd(14)}${avg(pwResults.map((r) => r.urls.length))}`);
  console.log(`Avg latency (ms):     ${String(avg(lsResults.map((r) => r.latencyMs))).padEnd(14)}${avg(pwResults.map((r) => r.latencyMs))}`);
  console.log(`Failures:             ${String(lsResults.filter((r) => r.error).length).padEnd(14)}${pwResults.filter((r) => r.error).length}`);

  // Domain overlap per query
  console.log(`\n=== Domain overlap per query ===`);
  for (const q of QUERIES) {
    const ls = lsResults.find((r) => r.query === q)!;
    const pw = pwResults.find((r) => r.query === q)!;
    const lsDom = new Set(uniqueDomains(ls.urls));
    const pwDom = new Set(uniqueDomains(pw.urls));
    const overlap = [...lsDom].filter((d) => pwDom.has(d));
    console.log(`  [${q}]`);
    console.log(`    overlap: ${overlap.length} (${overlap.slice(0, 5).join(", ")})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
