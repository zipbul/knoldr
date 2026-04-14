import { and, eq, desc, inArray } from "drizzle-orm";
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
 * Fetch up to MAX_CLAIMS_PER_ENTRY claims per entry, preferring factual
 * verified claims with higher certainty.
 */
export async function fetchClaimsForEntries(
  entries: Array<{ id: string; createdAt: string }>,
): Promise<Map<string, ClaimSummary[]>> {
  const byEntry = new Map<string, ClaimSummary[]>();
  if (entries.length === 0) return byEntry;

  const ids = entries.map((e) => e.id);
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
    .where(inArray(claim.entryId, ids))
    .orderBy(
      // verified first, then by certainty desc, then by id for stability
      desc(claim.certainty),
      desc(claim.createdAt),
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
