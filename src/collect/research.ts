import { decomposeQuery } from "./query-decompose";
import { collectSearchHits, type SearchHit } from "./search-scraper";
import { splitText, deriveTitle } from "./text-split";
import { classifyBatch } from "./classify-batch";
import { ingest } from "../ingest/engine";
import { parseStoreInput } from "../ingest/validate";
import { logger } from "../observability/logger";
import type { Progress } from "../a2a/dispatcher";

const NOOP_PROGRESS: Progress = { emit: () => {} };
const TITLE_MAX = 500;
const MAX_CHUNKS_PER_URL = 5;
const MAX_TOTAL_CHUNKS = 100;

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
const MIN_TOPIC_COVERAGE = 0.25;

/**
 * LangSearch-only research pipeline:
 *   1. Decompose topic into sub-queries (1 LLM call)
 *   2. LangSearch web search → rich hits
 *   3. Drop hits below topic coverage gate
 *   4. Recursive text-split each hit (code, 0 LLM)
 *   5. Batch-classify all chunks (1-5 LLM calls for domain/tags/decay/lang)
 *   6. Store as structured entries (Mode 2, 0 LLM)
 *
 * Total LLM calls: 2-6 per research (was ~50 with per-hit decompose).
 * Claim/KG extraction runs asynchronously in background workers.
 */
export async function research(
  input: ResearchInput,
  progress: Progress = NOOP_PROGRESS,
): Promise<ResearchResult> {
  const maxResults = Math.min(input.maxResults ?? 50, 200);
  const deadline = Date.now() + TIMEOUT_MS;

  logger.info({ topic: input.topic, maxResults }, "research started");

  // Step 1: Query decomposition (1 LLM call)
  progress.emit("query_decompose", { topic: input.topic });
  const subQueries = await decomposeQuery(input.topic);
  logger.info(
    { queryCount: subQueries.length, queries: subQueries.map((q) => q.main) },
    "queries decomposed",
  );
  progress.emit("query_decomposed", { queryCount: subQueries.length });

  // Step 2: LangSearch (0 LLM)
  progress.emit("langsearch_querying", { queryCount: subQueries.length });
  const hits = await collectSearchHits(subQueries, input.focusDomains);
  const limited = hits.slice(0, maxResults);
  logger.info({ hitCount: hits.length, limited: limited.length }, "hits collected");
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

  // Step 3: Topic gate + split (0 LLM)
  progress.emit("splitting");
  interface PreparedChunk {
    title: string;
    text: string;
    url: string;
    sourceType: string;
  }
  const allChunks: PreparedChunk[] = [];

  for (const hit of limited) {
    if (Date.now() > deadline) {
      result.status = "partial";
      break;
    }
    result.urlsProcessed++;

    if (!passesTopicGate(hit, topicTerms)) {
      result.entriesSkippedLowRelevance++;
      continue;
    }

    const sourceType = estimateSourceType(hit.url);
    const chunks = splitText(hit.content || hit.title);

    if (chunks.length === 0) {
      allChunks.push({
        title: hit.title.slice(0, TITLE_MAX),
        text: hit.content || hit.title,
        url: hit.url,
        sourceType,
      });
    } else {
      for (const chunk of chunks.slice(0, MAX_CHUNKS_PER_URL)) {
        allChunks.push({
          title: deriveTitle(chunk.text).slice(0, TITLE_MAX),
          text: chunk.text,
          url: hit.url,
          sourceType,
        });
      }
    }

    if (allChunks.length >= MAX_TOTAL_CHUNKS) break;
  }

  if (allChunks.length === 0) {
    logger.info({ topic: input.topic }, "no chunks to ingest");
    return result;
  }

  logger.info({ chunks: allChunks.length }, "chunks prepared");
  progress.emit("chunks_prepared", { count: allChunks.length });

  // Step 4: Batch classify (1-5 LLM calls for ALL chunks)
  progress.emit("classifying", { count: allChunks.length });
  const metas = await classifyBatch(
    allChunks.map((c) => ({ title: c.title, text: c.text })),
    input.topic,
  );
  progress.emit("classified");

  // Step 5: Mode 2 ingest (0 LLM)
  progress.emit("ingesting", { count: allChunks.length });
  const PROGRESS_STRIDE = Math.max(1, Math.floor(allChunks.length / 10));

  for (let i = 0; i < allChunks.length; i++) {
    if (Date.now() > deadline) {
      result.status = "partial";
      break;
    }

    const chunk = allChunks[i]!;
    const meta = metas[i]!;

    try {
      const storeInput = parseStoreInput({
        entries: [
          {
            title: chunk.title,
            content: chunk.text,
            domain: meta.domain,
            tags: meta.tags,
            language: meta.language,
            decayRate: meta.decayRate,
          },
        ],
        sources: [{ url: chunk.url, sourceType: chunk.sourceType }],
      });
      const ingested = await ingest(storeInput);
      for (const r of ingested) {
        result.entries.push({ entryId: r.entryId, action: r.action });
        if (r.action === "stored") result.entriesStored++;
      }
    } catch (err) {
      logger.warn({ url: chunk.url, error: (err as Error).message }, "chunk ingest failed");
    }

    if ((i + 1) % PROGRESS_STRIDE === 0 || i + 1 === allChunks.length) {
      progress.emit("ingest_progress", {
        processed: i + 1,
        total: allChunks.length,
        stored: result.entriesStored,
      });
    }
  }

  logger.info(
    {
      topic: input.topic,
      urlsProcessed: result.urlsProcessed,
      entriesStored: result.entriesStored,
      entriesSkippedLowRelevance: result.entriesSkippedLowRelevance,
      chunks: allChunks.length,
      status: result.status,
    },
    "research finished",
  );

  return result;
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
