import { z } from "zod";
import { search, explore } from "../../search/search";
import { research } from "../../collect/research";
import { logger } from "../../observability/logger";
import type { SearchResult } from "../../search/search";

const findInputSchema = z.object({
  query: z.string().min(1).max(1000).optional(),
  topic: z.string().min(1).max(1000).optional(),
  domain: z.string().max(50).optional(),
  tags: z.array(z.string().max(50)).max(10).optional(),
  language: z.string().regex(/^[a-z]{2}$/).optional(),
  minAuthority: z.number().min(0).max(1).optional(),
  minTrustLevel: z.enum(["high", "medium", "low"]).optional(),
  limit: z.number().int().min(1).max(50).default(10),
  cursor: z.string().optional(),
});

export type FindInput = z.infer<typeof findInputSchema>;

export async function handleFind(input: Record<string, unknown>): Promise<unknown> {
  const validated = findInputSchema.parse(input);
  const queryText = validated.query ?? validated.topic;

  // No query text → explore mode (filter-only browsing)
  if (!queryText) {
    const result = await explore({
      domain: validated.domain,
      tags: validated.tags,
      minAuthority: validated.minAuthority,
      minTrustLevel: validated.minTrustLevel,
      sortBy: "authority",
      limit: validated.limit,
      cursor: validated.cursor,
    });
    return formatResult(result, false);
  }

  // Step 1: search existing data
  const firstResult = await search({
    query: queryText,
    domain: validated.domain,
    tags: validated.tags,
    language: validated.language,
    minAuthority: validated.minAuthority,
    minTrustLevel: validated.minTrustLevel,
    limit: validated.limit,
    cursor: validated.cursor,
  });

  // Enough results AND top match actually covers the query → return.
  // OR-based FTS (search.ts) can return entries that share only one
  // incidental query term (e.g. "2023"); count alone is not a quality
  // signal. termCoverage from rank.ts expresses how much of the query
  // the top entry actually covers.
  const MIN_RESULTS = 3;
  const MIN_TOP_COVERAGE = 0.4;
  const topCoverage = firstResult.scores[0]?.termCoverage ?? 0;
  const enoughResults = firstResult.entries.length >= MIN_RESULTS;
  const strongTopMatch = topCoverage >= MIN_TOP_COVERAGE;
  if (validated.cursor || (enoughResults && strongTopMatch)) {
    return formatResult(firstResult, false);
  }

  // Step 2: auto-research to collect new data
  logger.info(
    {
      query: queryText,
      found: firstResult.entries.length,
      minResults: MIN_RESULTS,
      topCoverage,
      minTopCoverage: MIN_TOP_COVERAGE,
    },
    "find: insufficient or weak results, starting auto-research",
  );

  const researchResult = await research({
    topic: queryText,
    domain: validated.domain,
  });

  logger.info(
    {
      urlsProcessed: researchResult.urlsProcessed,
      entriesStored: researchResult.entriesStored,
      entriesSkippedLowRelevance: researchResult.entriesSkippedLowRelevance,
      entriesWithPublishedAt: researchResult.entriesWithPublishedAt,
    },
    "find: auto-research completed",
  );

  // Step 3: re-search with newly ingested data
  const finalResult = await search({
    query: queryText,
    domain: validated.domain,
    tags: validated.tags,
    language: validated.language,
    minAuthority: validated.minAuthority,
    minTrustLevel: validated.minTrustLevel,
    limit: validated.limit,
  });

  return formatResult(finalResult, true, {
    urlsProcessed: researchResult.urlsProcessed,
    entriesStored: researchResult.entriesStored,
    entriesSkippedLowRelevance: researchResult.entriesSkippedLowRelevance,
    entriesWithPublishedAt: researchResult.entriesWithPublishedAt,
  });
}

interface ResearchStats {
  urlsProcessed: number;
  entriesStored: number;
  entriesSkippedLowRelevance: number;
  entriesWithPublishedAt: number;
}

function formatResult(
  result: SearchResult,
  researched: boolean,
  researchStats?: ResearchStats,
) {
  return {
    entries: result.entries,
    scores: result.scores,
    trustLevels: result.trustLevels,
    nextCursor: result.nextCursor,
    researched,
    ...(researchStats && { research: researchStats }),
  };
}
