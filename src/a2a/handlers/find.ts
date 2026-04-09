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

  // Enough results → return immediately
  const MIN_RESULTS = 3;
  if (firstResult.entries.length >= MIN_RESULTS || validated.cursor) {
    return formatResult(firstResult, false);
  }

  // Step 2: auto-research to collect new data
  logger.info(
    { query: queryText, found: firstResult.entries.length, minResults: MIN_RESULTS },
    "find: insufficient results, starting auto-research",
  );

  const researchResult = await research({
    topic: queryText,
    domain: validated.domain,
  });

  logger.info(
    { stored: researchResult.entries.filter((e) => e.action === "stored").length, urlsCrawled: researchResult.urlsCrawled },
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
    urlsCrawled: researchResult.urlsCrawled,
    entriesStored: researchResult.entries.filter((e) => e.action === "stored").length,
  });
}

function formatResult(
  result: SearchResult,
  researched: boolean,
  researchStats?: { urlsCrawled: number; entriesStored: number },
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
