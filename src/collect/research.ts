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

  // Step 5: Mode 2 ingest (0 LLM) — bounded parallelism.
  //
  // Previous implementation ran ingest sequentially on up to 100
  // chunks, which easily exhausted the 5-minute deadline because each
  // ingest does embedding (CPU) + HNSW lookup + TX. Parallelizing
  // uncapped would overwhelm Postgres and the embedding pipeline
  // itself, so we cap at CONCURRENCY simultaneous ingests — empirical
  // sweet spot on the postgres max_connections=80 pool without
  // starving other workers.
  progress.emit("ingesting", { count: allChunks.length });
  const PROGRESS_STRIDE = Math.max(1, Math.floor(allChunks.length / 10));
  const CONCURRENCY = 6;
  let nextIdx = 0;
  let completed = 0;

  async function worker() {
    while (true) {
      if (Date.now() > deadline) {
        result.status = "partial";
        return;
      }
      const i = nextIdx++;
      if (i >= allChunks.length) return;
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
          // Skip rejected rows from the exported `entries` list — they
          // have no useful id, and `action:"stored"` is the only one
          // the caller tracks. Rejections are counted separately via
          // ingestionTotal metric.
          if (r.entryId) {
            result.entries.push({ entryId: r.entryId, action: r.action });
          }
          if (r.action === "stored") result.entriesStored++;
        }
      } catch (err) {
        logger.warn({ url: chunk.url, error: (err as Error).message }, "chunk ingest failed");
      }
      completed++;
      if (completed % PROGRESS_STRIDE === 0 || completed === allChunks.length) {
        progress.emit("ingest_progress", {
          processed: completed,
          total: allChunks.length,
          stored: result.entriesStored,
        });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

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
  // Host-based matching so paths like /evil/fake-github.com/... can't
  // impersonate a trusted publisher. `hostMatches` accepts an exact
  // host or any subdomain of it.
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "unknown";
  }
  const is = (...domains: string[]) =>
    domains.some((d) => host === d || host.endsWith(`.${d}`));

  if (is("github.com")) return "github_release";
  if (is("arxiv.org")) return "research_paper";
  if (host.endsWith(".gov") || host.endsWith(".edu")) return "official_docs";
  if (is("medium.com", "dev.to")) return "established_blog";
  if (is("stackoverflow.com", "reddit.com")) return "community_forum";
  return "unknown";
}
