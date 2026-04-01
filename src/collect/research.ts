import { decomposeQuery } from "./query-decompose";
import { crawl } from "./crawler";
import { searchAndExtractYoutube } from "./extract-youtube";
import { ingest } from "../ingest/engine";
import { parseStoreInput } from "../ingest/validate";
import { logger } from "../observability/logger";

export interface ResearchInput {
  topic: string;
  domain?: string;
  maxUrls?: number;
  contentTypes?: string[];
  maxDepth?: number;
  focusDomains?: string[];
}

export interface ResearchResult {
  entries: Array<{ entryId: string; action: string }>;
  urlsCrawled: number;
  status: "completed" | "partial";
}

const DEFAULT_CONTENT_TYPES = ["html", "pdf", "image", "youtube"];
const TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Deep Crawl Engine orchestrator.
 * 1. Query decomposition (Gemini CLI)
 * 2. Seed URL collection (Google CSE)
 * 3. Deep crawling (Playwright + extractors)
 * 4. YouTube search (parallel)
 */
export async function research(input: ResearchInput): Promise<ResearchResult> {
  const maxUrls = Math.min(input.maxUrls ?? 50, 200);
  const contentTypes = new Set(input.contentTypes ?? DEFAULT_CONTENT_TYPES);
  const maxDepth = Math.min(input.maxDepth ?? 2, 5);
  const deadline = Date.now() + TIMEOUT_MS;

  logger.info({ topic: input.topic, maxUrls, maxDepth, contentTypes: [...contentTypes] }, "Deep Crawl Engine started");

  // Step 1: Query Decomposition
  const subQueries = await decomposeQuery(input.topic);
  logger.info({ queryCount: subQueries.length, queries: subQueries.map((q) => q.main) }, "queries decomposed");

  // Step 2: Seed URL collection via Google CSE
  const seedUrls = await collectSeedUrls(subQueries, input.focusDomains);
  logger.info({ seedCount: seedUrls.length }, "seed URLs collected");

  if (seedUrls.length === 0) {
    return { entries: [], urlsCrawled: 0, status: "partial" };
  }

  // Step 3: Deep crawling
  const crawlResult = await crawl(seedUrls, {
    topic: input.topic,
    maxUrls,
    contentTypes,
    maxDepth,
    focusDomains: input.focusDomains ?? [],
  }, deadline);

  // Step 4: YouTube search (if enabled and budget remaining)
  if (contentTypes.has("youtube") && Date.now() < deadline) {
    const ytBudget = Math.min(2, subQueries.length);
    for (let i = 0; i < ytBudget && Date.now() < deadline; i++) {
      const query = subQueries[i]?.main;
      if (!query) break;

      const videos = await searchAndExtractYoutube(query, 3);
      for (const video of videos) {
        if (Date.now() > deadline) break;

        const raw = `${video.title}\n\n${video.text}`;
        const url = `https://www.youtube.com/watch?v=${video.videoId}`;

        try {
          const storeInput = parseStoreInput({
            raw: raw.slice(0, 200_000),
            sources: [{ url, sourceType: "community_forum" }],
          });
          const ingestResults = await ingest(storeInput);
          for (const r of ingestResults) {
            crawlResult.entries.push({ entryId: r.entryId, action: r.action });
          }
        } catch (err) {
          logger.warn({ videoId: video.videoId, error: (err as Error).message }, "YouTube ingestion failed");
        }
      }
    }
  }

  const status = Date.now() > deadline ? "partial" : "completed";
  logger.info({
    topic: input.topic,
    urlsCrawled: crawlResult.urlsCrawled,
    entriesStored: crawlResult.entries.filter((e) => e.action === "stored").length,
    status,
  }, "Deep Crawl Engine finished");

  return {
    entries: crawlResult.entries,
    urlsCrawled: crawlResult.urlsCrawled,
    status,
  };
}

async function collectSeedUrls(
  subQueries: Array<{ main: string; expansions: string[] }>,
  focusDomains?: string[],
): Promise<string[]> {
  const googleApiKey = process.env.KNOLDR_GOOGLE_API_KEY;
  const googleCseId = process.env.KNOLDR_GOOGLE_CSE_ID;
  if (!googleApiKey || !googleCseId) {
    throw new Error("KNOLDR_GOOGLE_API_KEY and KNOLDR_GOOGLE_CSE_ID required for research");
  }

  const allUrls = new Set<string>();

  // Collect all queries: main + expansions
  const queries: string[] = [];
  for (const sq of subQueries) {
    queries.push(sq.main);
    for (const exp of sq.expansions) {
      queries.push(exp);
    }
  }

  for (const query of queries) {
    try {
      const params = new URLSearchParams({
        key: googleApiKey,
        cx: googleCseId,
        q: query,
        num: "10",
      });

      const res = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;

      const json = (await res.json()) as {
        items?: Array<{ link: string }>;
      };

      for (const item of json.items ?? []) {
        allUrls.add(item.link);
      }
    } catch (err) {
      logger.warn({ query, error: (err as Error).message }, "CSE query failed");
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
