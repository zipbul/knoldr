import { extractHtml } from "./extract-html";
import { extractPdf } from "./extract-pdf";
import { extractImage } from "./extract-image";
import { extractYoutubeByUrl } from "./extract-youtube";
import { getDomainPolicy, isPathAllowed, checkRateLimit, recordRequest, updateDomainStats } from "./domain-policy";
import { preFilterLinks, llmSelectLinks } from "./link-filter";
import { ingest } from "../ingest/engine";
import { parseStoreInput } from "../ingest/validate";
import { logger } from "../observability/logger";

export interface CrawlOptions {
  topic: string;
  maxUrls: number;
  contentTypes: Set<string>;
  maxDepth: number;
  focusDomains: string[];
}

export interface CrawlResult {
  entries: Array<{ entryId: string; action: string }>;
  urlsCrawled: number;
}

interface QueueItem {
  url: string;
  depth: number;
}

const YOUTUBE_PATTERN = /(?:youtube\.com\/watch|youtu\.be\/)/;

/**
 * Deep crawl loop: visit URLs, extract content, follow links.
 */
export async function crawl(seedUrls: string[], options: CrawlOptions, deadline: number): Promise<CrawlResult> {
  const visited = new Set<string>();
  const queue: QueueItem[] = seedUrls.map((url) => ({ url, depth: 0 }));
  const results: CrawlResult = { entries: [], urlsCrawled: 0 };

  while (queue.length > 0 && results.urlsCrawled < options.maxUrls && Date.now() < deadline) {
    const item = queue.shift()!;
    if (visited.has(item.url)) continue;
    visited.add(item.url);

    try {
      const extracted = await visitUrl(item.url, options, visited);
      results.urlsCrawled++;

      if (!extracted) continue;

      // Ingest extracted content
      if (extracted.text) {
        try {
          const storeInput = parseStoreInput({
            raw: extracted.text.slice(0, 200_000),
            sources: [{ url: item.url, sourceType: extracted.sourceType }],
          });
          const ingestResults = await ingest(storeInput);
          for (const r of ingestResults) {
            results.entries.push({ entryId: r.entryId, action: r.action });
          }
        } catch (err) {
          logger.warn({ url: item.url, error: (err as Error).message }, "ingestion failed during crawl");
        }
      }

      // Collect and filter links for deeper crawling
      if (extracted.links && item.depth < options.maxDepth && results.urlsCrawled < options.maxUrls) {
        const domain = new URL(item.url).hostname;
        const { sameDomain, external } = preFilterLinks(extracted.links, visited, domain);

        // Budget remaining for link following
        const remainingBudget = options.maxUrls - results.urlsCrawled - queue.length;
        if (remainingBudget > 0) {
          // Same-domain links get priority
          const sameDomainSelected = sameDomain.slice(0, Math.ceil(remainingBudget * 0.7));

          // External links: LLM selection if many
          const externalBudget = Math.max(1, Math.floor(remainingBudget * 0.3));
          const externalSelected = external.length > externalBudget
            ? await llmSelectLinks(external, options.topic, externalBudget)
            : external.slice(0, externalBudget);

          for (const url of [...sameDomainSelected, ...externalSelected]) {
            if (!visited.has(url)) {
              queue.push({ url, depth: item.depth + 1 });
            }
          }
        }
      }
    } catch (err) {
      logger.debug({ url: item.url, error: (err as Error).message }, "crawl visit failed");
    }
  }

  return results;
}

interface ExtractResult {
  text: string | null;
  sourceType: string;
  links: string[] | null;
}

async function visitUrl(
  url: string,
  options: CrawlOptions,
  visited: Set<string>,
): Promise<ExtractResult | null> {
  // YouTube special handling
  if (YOUTUBE_PATTERN.test(url) && options.contentTypes.has("youtube")) {
    const text = await extractYoutubeByUrl(url);
    return text ? { text, sourceType: "community_forum", links: null } : null;
  }

  const parsedUrl = new URL(url);
  const domain = parsedUrl.hostname;

  // Domain policy check
  const policy = await getDomainPolicy(domain);

  if (policy.blocked) {
    logger.debug({ domain, reason: policy.blockReason }, "domain blocked, skipping");
    return null;
  }

  if (!isPathAllowed(policy.robotsTxt, parsedUrl.pathname)) {
    logger.debug({ url }, "robots.txt disallows path, skipping");
    return null;
  }

  // Rate limit
  const rl = checkRateLimit(domain, policy.rateLimitMs);
  if (rl.shouldWait) {
    await new Promise((resolve) => setTimeout(resolve, rl.waitMs));
  }
  recordRequest(domain);

  // Determine content type via HEAD request
  let contentType = "text/html";
  try {
    const headRes = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
    contentType = headRes.headers.get("content-type")?.split(";")[0]?.trim() ?? "text/html";
  } catch {
    // Assume HTML if HEAD fails
  }

  let text: string | null = null;
  let links: string[] | null = null;
  let sourceType = policy.sourceType !== "unknown" ? policy.sourceType : estimateSourceType(url);

  // Dispatch by content type
  if (contentType.startsWith("text/html") && options.contentTypes.has("html")) {
    text = await extractHtml(url);
    // Extract links from page (re-fetch is avoided by extractHtml using Playwright)
    links = await extractLinksFromPage(url);
  } else if (contentType === "application/pdf" && options.contentTypes.has("pdf")) {
    text = await extractPdf(url);
  } else if (contentType.startsWith("image/") && options.contentTypes.has("image")) {
    text = await extractImage(url);
  } else {
    // Unsupported content type
    await updateDomainStats(domain, false);
    return null;
  }

  const success = text !== null && text.length >= 100;
  await updateDomainStats(domain, success);

  if (!success) return null;

  return { text, sourceType, links };
}

async function extractLinksFromPage(url: string): Promise<string[]> {
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });

    const links = await page.evaluate(`
      Array.from(document.querySelectorAll("a[href]"))
        .map(a => a.href)
        .filter(href => href.startsWith("http"))
    `) as string[];

    await browser.close();
    return [...new Set(links)];
  } catch {
    return [];
  }
}

function estimateSourceType(url: string): string {
  if (url.includes("github.com")) return "github_release";
  if (url.includes("arxiv.org")) return "research_paper";
  if (url.includes(".gov") || url.includes(".edu")) return "official_docs";
  if (url.includes("medium.com") || url.includes("dev.to")) return "established_blog";
  if (url.includes("stackoverflow.com") || url.includes("reddit.com")) return "community_forum";
  return "unknown";
}
