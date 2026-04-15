import { decomposeQuery } from "./query-decompose";
import { collectSearchHits, type SearchHit } from "./search-scraper";
import { ingest } from "../ingest/engine";
import { parseStoreInput, type StoreInput } from "../ingest/validate";
import { logger } from "../observability/logger";
import type { Progress } from "../a2a/dispatcher";

const NOOP_PROGRESS: Progress = { emit: () => {} };

// Mode 2 short-circuit: LangSearch already returns a clean
// {title, content} per result, so the LLM decompose step that used to
// atomize raw web text is wasted work (and was the single biggest LLM
// quota burner). Anything that fits Mode 2's 50_000-char content cap
// is stored directly as a single structured entry; longer payloads
// fall back to the raw → LLM-decompose path so they still get
// atomized into multiple entries.
const MODE2_CONTENT_LIMIT = 49_000;
const TITLE_MAX = 500;

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
      const storeInput = buildStoreInput(hit, input);
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

/**
 * Pick the structured (Mode 2) ingest path when the LangSearch hit
 * already fits in a single entry; only fall back to the raw → decompose
 * path for very long content that genuinely needs atomization.
 */
function buildStoreInput(hit: SearchHit, input: ResearchInput): StoreInput {
  const sources = [{ url: hit.url, sourceType: estimateSourceType(hit.url) }];

  if (hit.content && hit.content.length <= MODE2_CONTENT_LIMIT) {
    return parseStoreInput({
      entries: [
        {
          title: hit.title.slice(0, TITLE_MAX),
          content: hit.content,
          domain: deriveDomains(hit, input),
          language: "en",
        },
      ],
      sources,
    });
  }

  return parseStoreInput({
    raw: buildRawText(hit).slice(0, 200_000),
    sources,
  });
}

function buildRawText(hit: SearchHit): string {
  return hit.content ? `${hit.title}\n\n${hit.content}` : hit.title;
}

function deriveDomains(hit: SearchHit, input: ResearchInput): string[] {
  const candidates: string[] = [];
  if (input.domain) candidates.push(input.domain);
  candidates.push(...input.topic.split(/\s+/).slice(0, 3));
  try {
    candidates.push(new URL(hit.url).hostname.replace(/^www\./, "").split(".")[0] ?? "");
  } catch {
    /* ignore malformed URL */
  }
  const slugs = candidates
    .map(slugify)
    .filter((s): s is string => s.length > 0 && s.length <= 50);
  const unique = Array.from(new Set(slugs)).slice(0, 5);
  return unique.length > 0 ? unique : ["web"];
}

function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[_\s.]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
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
