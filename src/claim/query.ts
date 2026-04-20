import { and, eq, desc, inArray, or, sql } from "drizzle-orm";
import { db } from "../db/connection";
import { claim, entryScore } from "../db/schema";

export interface ClaimSummary {
  id: string;
  statement: string;
  type: string;
  verdict: string;
  certainty: number;
}

const MAX_CLAIMS_PER_ENTRY = 5;

/**
 * Fetch up to MAX_CLAIMS_PER_ENTRY claims per entry, preferring high-
 * certainty claims. Ordering carries `claim.id` as the final tie-
 * breaker so the results are deterministic across repeated queries
 * — the previous `ORDER BY certainty DESC, created_at DESC` without a
 * stable secondary key produced different orderings on equal-certainty
 * rows (the comment even claimed "by id for stability" but the id
 * wasn't in the ORDER BY list).
 *
 * Also threads `entry_created_at` through the WHERE clause so the
 * composite index `(entry_id, entry_created_at)` actually gets used —
 * without it Postgres only utilizes the first column.
 */
export async function fetchClaimsForEntries(
  entries: Array<{ id: string; createdAt: string }>,
): Promise<Map<string, ClaimSummary[]>> {
  const byEntry = new Map<string, ClaimSummary[]>();
  if (entries.length === 0) return byEntry;

  // Build (entry_id, entry_created_at) pair predicate. When all entries
  // share a single created_at column this produces the same plan as a
  // plain IN, but in the heterogeneous case Postgres can use the
  // composite index efficiently.
  const pairPredicates = entries.map((e) =>
    and(
      eq(claim.entryId, e.id),
      eq(claim.entryCreatedAt, new Date(e.createdAt)),
    )!,
  );

  const rows = await db
    .select({
      id: claim.id,
      entryId: claim.entryId,
      statement: claim.statement,
      type: claim.type,
      verdict: claim.verdict,
      certainty: claim.certainty,
    })
    .from(claim)
    .where(or(...pairPredicates))
    .orderBy(
      desc(claim.certainty),
      desc(claim.createdAt),
      sql`${claim.id} DESC`,
    );

  for (const r of rows) {
    const bucket = byEntry.get(r.entryId) ?? [];
    if (bucket.length >= MAX_CLAIMS_PER_ENTRY) continue;
    bucket.push({
      id: r.id,
      statement: r.statement,
      type: r.type,
      verdict: r.verdict,
      certainty: r.certainty,
    });
    byEntry.set(r.entryId, bucket);
  }

  return byEntry;
}

/**
 * Fetch factuality score (0-1) per entry when available.
 */
export async function fetchFactualityForEntries(
  entries: Array<{ id: string; createdAt: string }>,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (entries.length === 0) return result;

  const rows = await db
    .select({
      entryId: entryScore.entryId,
      value: entryScore.value,
    })
    .from(entryScore)
    .where(
      and(
        inArray(entryScore.entryId, entries.map((e) => e.id)),
        eq(entryScore.dimension, "factuality"),
      ),
    );

  for (const r of rows) {
    result.set(r.entryId, r.value);
  }
  return result;
}
