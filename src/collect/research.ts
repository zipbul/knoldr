import { decomposeQuery } from "./query-decompose";
import { collectSearchHits, type SearchHit } from "./search-scraper";
import { ingest } from "../ingest/engine";
import { parseStoreInput } from "../ingest/validate";
import { logger } from "../observability/logger";

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
  entriesWithPublishedAt: number;
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
export async function research(input: ResearchInput): Promise<ResearchResult> {
  const maxResults = Math.min(input.maxResults ?? 50, 200);
  const deadline = Date.now() + TIMEOUT_MS;

  logger.info({ topic: input.topic, maxResults }, "LangSearch research started");

  const subQueries = await decomposeQuery(input.topic);
  logger.info(
    { queryCount: subQueries.length, queries: subQueries.map((q) => q.main) },
    "queries decomposed",
  );

  const hits = await collectSearchHits(subQueries, input.focusDomains);
  const limited = hits.slice(0, maxResults);
  logger.info({ hitCount: hits.length, limited: limited.length }, "LangSearch hits collected");

  const topicTerms = input.topic
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2);

  const result: ResearchResult = {
    entries: [],
    urlsProcessed: 0,
    entriesStored: 0,
    entriesSkippedLowRelevance: 0,
    entriesWithPublishedAt: 0,
    status: "completed",
  };

  for (const hit of limited) {
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
        sourceMetadata: {
          ...(hit.publishedAt ? { publishedAt: hit.publishedAt } : {}),
          ...(hit.siteName ? { siteName: hit.siteName } : {}),
        },
      });
      const ingested = await ingest(storeInput);
      for (const r of ingested) {
        result.entries.push({ entryId: r.entryId, action: r.action });
        if (r.action === "stored") {
          result.entriesStored++;
          if (hit.publishedAt) result.entriesWithPublishedAt++;
        }
      }
    } catch (err) {
      logger.warn({ url: hit.url, error: (err as Error).message }, "ingest failed for hit");
    }
  }

  logger.info(
    {
      topic: input.topic,
      urlsProcessed: result.urlsProcessed,
      entriesStored: result.entriesStored,
      entriesSkippedLowRelevance: result.entriesSkippedLowRelevance,
      entriesWithPublishedAt: result.entriesWithPublishedAt,
      status: result.status,
    },
    "LangSearch research finished",
  );

  return result;
}

function buildRawText(hit: SearchHit): string {
  const parts: string[] = [];
  if (hit.title) parts.push(hit.title);
  if (hit.siteName) parts.push(`(${hit.siteName})`);
  if (hit.publishedAt) parts.push(`Published: ${hit.publishedAt}`);
  if (hit.summary) parts.push("", hit.summary);
  return parts.join("\n");
}

function passesTopicGate(hit: SearchHit, topicTerms: string[]): boolean {
  if (topicTerms.length === 0) return true;
  const haystack = `${hit.title} ${hit.summary}`.toLowerCase();
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
