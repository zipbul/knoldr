import { db } from "../db/connection";
import { entry, entryDomain, entryTag, entrySource } from "../db/schema";
import { sql, eq, and, gte, inArray, type SQL } from "drizzle-orm";
import { rank, type RawRow, type ScoredEntry, type ScoreBreakdown } from "./rank";
import type { QueryInput, ExploreInput } from "../ingest/validate";
import { logger } from "../observability/logger";
import { searchTotal, searchLatency } from "../observability/metrics";

export interface SearchResult {
  entries: ScoredEntry[];
  scores: ScoreBreakdown[];
  trustLevels: string[];
  nextCursor?: string;
}

/**
 * Keyword search with pgroonga FTS, filters, freshness decay, authority ranking.
 */
export async function search(input: QueryInput): Promise<SearchResult> {
  const timer = searchLatency.startTimer();
  searchTotal.inc();
  const conditions: SQL[] = [eq(entry.status, "active")];

  if (input.minAuthority !== undefined) {
    conditions.push(gte(entry.authority, input.minAuthority));
  }
  if (input.language) {
    conditions.push(eq(entry.language, input.language));
  }
  if (input.minTrustLevel) {
    conditions.push(gte(entry.authority, trustLevelToMinAuthority(input.minTrustLevel)));
  }

  // pgroonga FTS — convert query words to OR matching for better recall
  // AI agents send precise queries, but AND matching is too strict when
  // entries are atomically decomposed (each covers one aspect).
  // Term-coverage filtering is applied post-rank (see below) so that weak
  // single-incidental-term matches don't pass as valid results.
  const queryTerms = input.query.trim().split(/\s+/).filter((t) => t.length > 0);
  const orQuery = queryTerms.join(" OR ");
  conditions.push(
    sql`(${entry.title} &@~ ${orQuery} OR ${entry.content} &@~ ${orQuery})`,
  );

  // Domain filter
  if (input.domain) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM entry_domain ed WHERE ed.entry_id = ${entry.id} AND ed.entry_created_at = ${entry.createdAt} AND ed.domain = ${input.domain})`,
    );
  }

  // Tag filter
  if (input.tags && input.tags.length > 0) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM entry_tag et WHERE et.entry_id = ${entry.id} AND et.entry_created_at = ${entry.createdAt} AND et.tag = ANY(${input.tags}))`,
    );
  }

  // Fetch top 50 candidates (over-fetch for re-ranking, then cut to limit)
  const fetchLimit = 50;

  const rows = await db
    .select({
      id: entry.id,
      title: entry.title,
      content: entry.content,
      language: entry.language,
      metadata: entry.metadata,
      authority: entry.authority,
      decayRate: entry.decayRate,
      status: entry.status,
      createdAt: entry.createdAt,
      pgroongaScore: sql<number>`pgroonga_score(tableoid, ctid)`,
    })
    .from(entry)
    .where(and(...conditions))
    .orderBy(sql`pgroonga_score(tableoid, ctid) DESC`)
    .limit(fetchLimit);

  // Enrich with domains, tags, sources
  const enriched = await enrichRows(rows);

  // Rank by final score (and compute termCoverage against the query)
  const ranked = rank(enriched, "query", queryTerms);

  // Apply cursor + limit
  const limit = Math.min(input.limit, 50);
  let startIdx = 0;
  if (input.cursor) {
    const decoded = decodeCursor(input.cursor);
    if (decoded) {
      startIdx = ranked.entries.findIndex(
        (e, i) =>
          ranked.scores[i]!.final < decoded.score ||
          (ranked.scores[i]!.final === decoded.score && e.id < decoded.id),
      );
      if (startIdx === -1) startIdx = ranked.entries.length;
    }
  }

  const sliced = {
    entries: ranked.entries.slice(startIdx, startIdx + limit),
    scores: ranked.scores.slice(startIdx, startIdx + limit),
    trustLevels: ranked.trustLevels.slice(startIdx, startIdx + limit),
  };

  const hasMore = startIdx + limit < ranked.entries.length;
  const lastIdx = sliced.entries.length - 1;
  const nextCursor =
    hasMore && lastIdx >= 0
      ? encodeCursor(sliced.scores[lastIdx]!.final, sliced.entries[lastIdx]!.id)
      : undefined;

  timer();
  logger.info({ query: input.query, resultCount: sliced.entries.length }, "search completed");

  return { ...sliced, nextCursor };
}

/**
 * Filter-only browsing (empty query). No pgroonga FTS.
 */
export async function explore(input: ExploreInput): Promise<SearchResult> {
  const conditions: SQL[] = [eq(entry.status, "active")];

  if (input.minAuthority !== undefined) {
    conditions.push(gte(entry.authority, input.minAuthority));
  }
  if (input.minTrustLevel) {
    conditions.push(gte(entry.authority, trustLevelToMinAuthority(input.minTrustLevel)));
  }
  if (input.domain) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM entry_domain ed WHERE ed.entry_id = ${entry.id} AND ed.entry_created_at = ${entry.createdAt} AND ed.domain = ${input.domain})`,
    );
  }
  if (input.tags && input.tags.length > 0) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM entry_tag et WHERE et.entry_id = ${entry.id} AND et.entry_created_at = ${entry.createdAt} AND et.tag = ANY(${input.tags}))`,
    );
  }

  const fetchLimit = 50;
  const sortColumn = input.sortBy === "created_at" ? entry.createdAt : entry.authority;

  const rows = await db
    .select({
      id: entry.id,
      title: entry.title,
      content: entry.content,
      language: entry.language,
      metadata: entry.metadata,
      authority: entry.authority,
      decayRate: entry.decayRate,
      status: entry.status,
      createdAt: entry.createdAt,
      pgroongaScore: sql<number>`0`,
    })
    .from(entry)
    .where(and(...conditions))
    .orderBy(sql`${sortColumn} DESC, ${entry.id} DESC`)
    .limit(fetchLimit);

  const enriched = await enrichRows(rows);
  const ranked = rank(enriched, "explore");

  // Apply cursor + limit
  const limit = Math.min(input.limit, 50);
  let startIdx = 0;
  if (input.cursor) {
    const decoded = decodeCursor(input.cursor);
    if (decoded) {
      startIdx = ranked.entries.findIndex(
        (e, i) =>
          ranked.scores[i]!.final < decoded.score ||
          (ranked.scores[i]!.final === decoded.score && e.id < decoded.id),
      );
      if (startIdx === -1) startIdx = ranked.entries.length;
    }
  }

  const sliced = {
    entries: ranked.entries.slice(startIdx, startIdx + limit),
    scores: ranked.scores.slice(startIdx, startIdx + limit),
    trustLevels: ranked.trustLevels.slice(startIdx, startIdx + limit),
  };

  const hasMore = startIdx + limit < ranked.entries.length;
  const lastIdx = sliced.entries.length - 1;
  const nextCursor =
    hasMore && lastIdx >= 0
      ? encodeCursor(sliced.scores[lastIdx]!.final, sliced.entries[lastIdx]!.id)
      : undefined;

  logger.info({ resultCount: sliced.entries.length }, "explore completed");

  return { ...sliced, nextCursor };
}

// -- Helpers

type BaseRow = {
  id: string;
  title: string;
  content: string;
  language: string;
  metadata: unknown;
  authority: number;
  decayRate: number;
  status: string;
  createdAt: Date;
  pgroongaScore: number;
};

async function enrichRows(rows: BaseRow[]): Promise<RawRow[]> {
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);

  // Batch fetch domains, tags, sources
  const [domains, tags, sources] = await Promise.all([
    db
      .select({ entryId: entryDomain.entryId, domain: entryDomain.domain })
      .from(entryDomain)
      .where(inArray(entryDomain.entryId, ids)),
    db
      .select({ entryId: entryTag.entryId, tag: entryTag.tag })
      .from(entryTag)
      .where(inArray(entryTag.entryId, ids)),
    db
      .select({
        entryId: entrySource.entryId,
        url: entrySource.url,
        sourceType: entrySource.sourceType,
        trust: entrySource.trust,
      })
      .from(entrySource)
      .where(inArray(entrySource.entryId, ids)),
  ]);

  // Group by entryId
  const domainMap = new Map<string, string[]>();
  for (const d of domains) {
    const arr = domainMap.get(d.entryId) ?? [];
    arr.push(d.domain);
    domainMap.set(d.entryId, arr);
  }

  const tagMap = new Map<string, string[]>();
  for (const t of tags) {
    const arr = tagMap.get(t.entryId) ?? [];
    arr.push(t.tag);
    tagMap.set(t.entryId, arr);
  }

  const sourceMap = new Map<string, Array<{ url: string; sourceType: string; trust: number }>>();
  for (const s of sources) {
    const arr = sourceMap.get(s.entryId) ?? [];
    arr.push({ url: s.url, sourceType: s.sourceType, trust: s.trust });
    sourceMap.set(s.entryId, arr);
  }

  return rows.map((r) => ({
    ...r,
    domains: domainMap.get(r.id) ?? [],
    tags: tagMap.get(r.id) ?? [],
    sources: sourceMap.get(r.id) ?? [],
  }));
}

function trustLevelToMinAuthority(level: string): number {
  switch (level) {
    case "high": return 0.7;
    case "medium": return 0.4;
    default: return 0;
  }
}

function encodeCursor(score: number, id: string): string {
  return btoa(JSON.stringify({ score, id }));
}

function decodeCursor(cursor: string): { score: number; id: string } | null {
  try {
    return JSON.parse(atob(cursor)) as { score: number; id: string };
  } catch {
    return null;
  }
}
