import { sql, eq, and, gte, inArray, type SQL } from 'drizzle-orm';

import type { QueryInput, ExploreInput } from '../ingest/validate';

import { getDb } from '../db/connection';
import { entry, entryDomain, entryTag, entrySource } from '../db/schema';
import { logger } from '../observability/logger';
import { searchTotal, searchLatency } from '../observability/metrics';
import { SortBy } from '../score/enums';
import { rank, type RawRow, type ScoredEntry, type ScoreBreakdown } from './rank';

interface SearchResult {
  entries: ScoredEntry[];
  scores: ScoreBreakdown[];
  trustLevels: string[];
  nextCursor?: string;
}

// Pagination cursors (opaque to callers, base64 JSON):
//  - query mode: { score: ranked final score, id, d: rows already
//    consumed }. Ranking blends FTS/authority/freshness in memory, so
//    the pool must DEEPEN as the cursor advances — `d` drives the
//    fetch window; (score, id) locates the resume point in the ranked
//    ordering.
//  - explore mode: { score: RAW sort-column value (authority or epoch
//    seconds), id }. The SQL keyset compares raw column values, so the
//    cursor must carry raw values — encoding the ranked score here once
//    made page 2 empty (created_at) or skip/dup rows (authority).
interface Cursor {
  score: number;
  id: string;
  d?: number;
}

// Drizzle's tagged template expands a JS array positionally —
// ANY(${tags}) becomes ANY(($1,$2)) which Postgres rejects. Bind a
// real text[] instead (same pattern as src/kg/expand.ts).
function sqlTextArray(values: string[]) {
  return sql`ARRAY[${sql.join(
    values.map(v => sql`${v}`),
    sql`, `,
  )}]::text[]`;
}

const MAX_LIMIT = 50;
// Per-page candidate pool. Larger than requested limit so authority +
// freshness re-ranking still sees enough candidates to reorder
// meaningfully without capping pagination depth — the `cursor` alone
// drives where we read from.
const CANDIDATE_MULTIPLIER = 3;

/**
 * Keyword search with pgroonga FTS, filters, freshness decay, authority ranking.
 */
async function search(input: QueryInput): Promise<SearchResult> {
  const timer = searchLatency.startTimer();
  searchTotal.inc();
  try {
    const conditions: SQL[] = [eq(entry.status, 'active')];

    if (input.minAuthority !== undefined) {
      conditions.push(gte(entry.authority, input.minAuthority));
    }
    if (input.language) {
      conditions.push(eq(entry.language, input.language));
    }
    if (input.minTrustLevel) {
      conditions.push(gte(entry.authority, trustLevelToMinAuthority(input.minTrustLevel)));
    }

    // pgroonga FTS — escape special chars then OR-join so a raw apostrophe /
    // brace / pipe in the user query can't corrupt pgroonga's grammar.
    const queryTerms = input.query
      .trim()
      .split(/\s+/)
      .filter(t => t.length > 0);
    const escaped = queryTerms.map(escapePgroongaTerm);
    const orQuery = escaped.length > 0 ? escaped.join(' OR ') : (escaped[0] ?? '');
    conditions.push(sql`(${entry.title} &@~ ${orQuery} OR ${entry.content} &@~ ${orQuery})`);

    // Domain filter
    if (input.domain) {
      conditions.push(
        sql`EXISTS (SELECT 1 FROM entry_domain ed WHERE ed.entry_id = ${entry.id} AND ed.entry_created_at = ${entry.createdAt} AND ed.domain = ${input.domain})`,
      );
    }

    // Tag filter
    if (input.tags && input.tags.length > 0) {
      conditions.push(
        sql`EXISTS (SELECT 1 FROM entry_tag et WHERE et.entry_id = ${entry.id} AND et.entry_created_at = ${entry.createdAt} AND et.tag = ANY(${sqlTextArray(input.tags)}))`,
      );
    }

    const limit = Math.min(input.limit, MAX_LIMIT);
    const decodedQ = input.cursor ? decodeCursor(input.cursor) : null;
    const consumed = decodedQ?.d ?? 0;
    // Candidate pool: large enough for post-rank reshuffling AND deep
    // enough to reach past everything prior pages consumed — without
    // growing the window, depth was permanently capped at the first
    // limit×3 pool.
    const fetchLimit = Math.max((consumed + limit) * CANDIDATE_MULTIPLIER, 20);

    const rows = await getDb()
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
      // Deterministic tiebreak: equal FTS scores otherwise make the
      // candidate-pool MEMBERSHIP itself vary between queries at the
      // fetchLimit boundary, silently losing rows across pages.
      .orderBy(sql`pgroonga_score(tableoid, ctid) DESC, ${entry.createdAt} DESC, ${entry.id} DESC`)
      .limit(fetchLimit);

    const enriched = await enrichRows(rows);
    const ranked = rank(enriched, 'query', queryTerms);

    return sliceQueryPage(ranked, decodedQ, limit, rows.length === fetchLimit);
  } finally {
    timer();
    logger.info({ query: input.query }, 'search completed');
  }
}

/**
 * Filter-only browsing (empty query). No pgroonga FTS.
 */
async function explore(input: ExploreInput): Promise<SearchResult> {
  const conditions: SQL[] = [eq(entry.status, 'active')];

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
      sql`EXISTS (SELECT 1 FROM entry_tag et WHERE et.entry_id = ${entry.id} AND et.entry_created_at = ${entry.createdAt} AND et.tag = ANY(${sqlTextArray(input.tags)}))`,
    );
  }

  const limit = Math.min(input.limit, MAX_LIMIT);
  const fetchLimit = Math.max(limit * CANDIDATE_MULTIPLIER, 20);
  const sortColumn = input.sortBy === SortBy.CreatedAt ? entry.createdAt : entry.authority;

  // For explore we push cursor filtering into the SQL itself — the pool
  // is large and the composite (authority, id) or (created_at, id)
  // index delivers O(log N) keyset pagination.
  const decoded = input.cursor ? decodeCursor(input.cursor) : null;
  if (decoded) {
    if (input.sortBy === SortBy.CreatedAt) {
      conditions.push(sql`(EXTRACT(EPOCH FROM ${entry.createdAt}), ${entry.id}) < (${decoded.score}, ${decoded.id})`);
    } else {
      conditions.push(sql`(${entry.authority}, ${entry.id}) < (${decoded.score}, ${decoded.id})`);
    }
  }

  const rows = await getDb()
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
  // Score for display, but PRESENT in the SQL keyset order — explore's
  // contract is sortBy(authority|created_at), and re-sorting by the
  // blended rank here would break both the contract and the keyset
  // page boundaries (dup/skip across pages).
  const ranked = rank(enriched, 'explore');
  const posById = new Map(ranked.entries.map((e, i) => [e.id, i] as const));
  const page = rows.slice(0, limit);
  const entries = page.map(r => ranked.entries[posById.get(r.id)!]!);
  const scores = page.map(r => ranked.scores[posById.get(r.id)!]!);
  const trustLevels = page.map(r => ranked.trustLevels[posById.get(r.id)!]!);

  const last = page[page.length - 1];
  const nextCursor =
    page.length === limit && last
      ? encodeCursor(input.sortBy === SortBy.CreatedAt ? Math.floor(last.createdAt.getTime() / 1000) : last.authority, last.id)
      : undefined;

  return { entries, scores, trustLevels, nextCursor };
}

function sliceQueryPage(ranked: ReturnType<typeof rank>, decoded: Cursor | null, limit: number, poolFull: boolean): SearchResult {
  let startIdx = 0;
  if (decoded?.d !== undefined) {
    // Position-based resume: with a deterministic pool + ordering, the
    // consumed-count is an exact resume point AND is immune to the
    // freshness component of the rank score drifting between page
    // requests (score-matching resume skipped rows whose recomputed
    // score crossed the cursor value).
    startIdx = Math.min(decoded.d, ranked.entries.length);
  } else if (decoded) {
    // Legacy cursor without depth: score-scan fallback.
    startIdx = ranked.entries.findIndex((e, i) => {
      const s = ranked.scores[i]!.final;
      if (s < decoded.score) {
        return true;
      }
      if (s > decoded.score) {
        return false;
      }
      return e.id.localeCompare(decoded.id) < 0;
    });
    if (startIdx === -1) {
      startIdx = ranked.entries.length;
    }
  }

  const sliced = {
    entries: ranked.entries.slice(startIdx, startIdx + limit),
    scores: ranked.scores.slice(startIdx, startIdx + limit),
    trustLevels: ranked.trustLevels.slice(startIdx, startIdx + limit),
  };

  const lastIdx = sliced.entries.length - 1;
  // Emit a cursor only when there is plausibly MORE: either ranked rows
  // remain past this page, or the candidate pool hit its fetch limit
  // (deeper rows may exist in the DB). A short pool + fully-consumed
  // ranking means the matching set is exhausted — no phantom cursor.
  const moreRemains = startIdx + limit < ranked.entries.length || poolFull;
  const nextCursor =
    sliced.entries.length > 0 && lastIdx >= 0 && moreRemains
      ? encodeCursor(sliced.scores[lastIdx]!.final, sliced.entries[lastIdx]!.id, startIdx + sliced.entries.length)
      : undefined;

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
  if (rows.length === 0) {
    return [];
  }

  const ids = rows.map(r => r.id);

  // Batch fetch domains, tags, sources
  const [domains, tags, sources] = await Promise.all([
    getDb()
      .select({ entryId: entryDomain.entryId, domain: entryDomain.domain })
      .from(entryDomain)
      .where(inArray(entryDomain.entryId, ids)),
    getDb().select({ entryId: entryTag.entryId, tag: entryTag.tag }).from(entryTag).where(inArray(entryTag.entryId, ids)),
    getDb()
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

  return rows.map(r => ({
    ...r,
    domains: domainMap.get(r.id) ?? [],
    tags: tagMap.get(r.id) ?? [],
    sources: sourceMap.get(r.id) ?? [],
  }));
}

function trustLevelToMinAuthority(level: string): number {
  switch (level) {
    case 'high':
      return 0.7;
    case 'medium':
      return 0.4;
    default:
      return 0;
  }
}

/**
 * Escape pgroonga query-language metacharacters. The `&@~` operator
 * uses a Boolean grammar similar to groonga's script mode; `(`, `)`,
 * `|`, `-`, `"`, `*` and whitespace all carry special meaning. We
 * double-quote each term so it's treated as a literal phrase and
 * internal double-quotes are backslash-escaped.
 */
function escapePgroongaTerm(term: string): string {
  const escaped = term.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function encodeCursor(score: number, id: string, d?: number): string {
  return btoa(JSON.stringify(d === undefined ? { score, id } : { score, id, d }));
}

function decodeCursor(cursor: string): Cursor | null {
  try {
    const parsed = JSON.parse(atob(cursor));
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as Cursor).score === 'number' &&
      typeof (parsed as Cursor).id === 'string' &&
      ((parsed as Cursor).d === undefined || typeof (parsed as Cursor).d === 'number')
    ) {
      return parsed as Cursor;
    }
    return null;
  } catch {
    return null;
  }
}

export { search, explore };
export type { SearchResult };
