import { decomposeQuery } from "./query-decompose";
import { collectSearchHits, type SearchHit } from "./search-scraper";
import { ingest } from "../ingest/engine";
import { parseStoreInput } from "../ingest/validate";
import { logger } from "../observability/logger";
import type { Progress } from "../a2a/dispatcher";

const NOOP_PROGRESS: Progress = { emit: () => {} };

export interface ResearchInput {
  topic: string;
  domain?: string;
  maxResults?: number;
  focusDomains?: string[];
}

export interface ResearchResult {
  entries: Array<{ entryId: string; action: string }>;
  urlsProcessed: number;
  entriesStored: number;
  entriesSkippedLowRelevance: number;
  status: "completed" | "partial";
}

const TIMEOUT_MS = 5 * 60 * 1000;
// Minimum fraction of topic terms that must appear in a hit's title+summary
// before ingesting. Prevents LangSearch from feeding unrelated pages into the
// store when the query shares only an incidental term.
const MIN_TOPIC_COVERAGE = 0.25;

/**
 * LangSearch-only research.
 * 1. Decompose topic into sub-queries (LLM)
 * 2. LangSearch web search for each sub-query → rich hits (url/title/summary/publishedAt)
 * 3. Drop hits whose title+summary covers < MIN_TOPIC_COVERAGE of topic terms
 * 4. Ingest each remaining hit with sourceMetadata carrying publishedAt/siteName
 */
export async function research(
  input: ResearchInput,
  progress: Progress = NOOP_PROGRESS,
): Promise<ResearchResult> {
  const maxResults = Math.min(input.maxResults ?? 50, 200);
  const deadline = Date.now() + TIMEOUT_MS;

  logger.info({ topic: input.topic, maxResults }, "LangSearch research started");

  progress.emit("query_decompose", { topic: input.topic });
  const subQueries = await decomposeQuery(input.topic);
  logger.info(
    { queryCount: subQueries.length, queries: subQueries.map((q) => q.main) },
    "queries decomposed",
  );
  progress.emit("query_decomposed", { queryCount: subQueries.length });

  progress.emit("langsearch_querying", { queryCount: subQueries.length });
  const hits = await collectSearchHits(subQueries, input.focusDomains);
  const limited = hits.slice(0, maxResults);
  logger.info({ hitCount: hits.length, limited: limited.length }, "LangSearch hits collected");
  progress.emit("langsearch_collected", { hits: hits.length, toProcess: limited.length });

  const topicTerms = input.topic
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2);

  const result: ResearchResult = {
    entries: [],
    urlsProcessed: 0,
    entriesStored: 0,
    entriesSkippedLowRelevance: 0,
    status: "completed",
  };

  // Report ingest progress every N hits so streaming clients can tell
  // the worker is still alive during minutes-long research flows.
  const PROGRESS_STRIDE = Math.max(1, Math.floor(limited.length / 10));

  for (const [idx, hit] of limited.entries()) {
    if (Date.now() > deadline) {
      result.status = "partial";
      break;
    }
    result.urlsProcessed++;

    if (!passesTopicGate(hit, topicTerms)) {
      result.entriesSkippedLowRelevance++;
      logger.debug({ url: hit.url, topic: input.topic }, "hit skipped: low topic coverage");
      continue;
    }

    try {
      const storeInput = parseStoreInput({
        raw: buildRawText(hit).slice(0, 200_000),
        sources: [{ url: hit.url, sourceType: estimateSourceType(hit.url) }],
      });
      const ingested = await ingest(storeInput);
      for (const r of ingested) {
        result.entries.push({ entryId: r.entryId, action: r.action });
        if (r.action === "stored") result.entriesStored++;
      }
    } catch (err) {
      logger.warn({ url: hit.url, error: (err as Error).message }, "ingest failed for hit");
    }

    if ((idx + 1) % PROGRESS_STRIDE === 0 || idx + 1 === limited.length) {
      progress.emit("ingest_progress", {
        processed: idx + 1,
        total: limited.length,
        stored: result.entriesStored,
        skipped: result.entriesSkippedLowRelevance,
      });
    }
  }

  logger.info(
    {
      topic: input.topic,
      urlsProcessed: result.urlsProcessed,
      entriesStored: result.entriesStored,
      entriesSkippedLowRelevance: result.entriesSkippedLowRelevance,
      status: result.status,
    },
    "LangSearch research finished",
  );

  return result;
}

function buildRawText(hit: SearchHit): string {
  return hit.content ? `${hit.title}\n\n${hit.content}` : hit.title;
}

function passesTopicGate(hit: SearchHit, topicTerms: string[]): boolean {
  if (topicTerms.length === 0) return true;
  const haystack = `${hit.title} ${hit.content}`.toLowerCase();
  const matched = topicTerms.filter((t) => haystack.includes(t)).length;
  return matched / topicTerms.length >= MIN_TOPIC_COVERAGE;
}

function estimateSourceType(url: string): string {
  if (url.includes("github.com")) return "github_release";
  if (url.includes("arxiv.org")) return "research_paper";
  if (url.includes(".gov") || url.includes(".edu")) return "official_docs";
  if (url.includes("medium.com") || url.includes("dev.to")) return "established_blog";
  if (url.includes("stackoverflow.com") || url.includes("reddit.com")) return "community_forum";
  return "unknown";
}
