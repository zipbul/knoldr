// claim_relation edge writer.
//
// Centralizes every place CONTRADICTS / SUPPORTS / DERIVES_FROM /
// SUPERSEDED_BY / REFINES edges land. Callers pass:
//   - pivotClaimId: the just-decided claim
//   - targets: the existing claims being linked — plain ids or
//     { id, weight } for per-edge weights (cross-ref edges carry the
//     classifying NLI probability, not the claim's verdict certainty)
//   - relationType, opts (fallback weight, createdBy, metadata, direction)
//
// direction: 'outgoing' (default) writes pivot→target rows; 'incoming'
// writes target→pivot rows — required for SUPPORTS, whose semantics are
// "the neighbor supports THIS claim" (many sources → one target), which
// the outgoing shape cannot express.
//
// All writes are idempotent — the (source, target, relation_type)
// unique index lets us issue ON CONFLICT DO NOTHING. Self-loops are
// dropped silently so callers don't have to filter their own claim id
// out of a candidate list.

import { ulid } from 'ulid';

import { getDb } from '../db/connection';
import { claimRelation } from '../db/schema';
import { logger } from '../observability/logger';

type ClaimRelationType = 'supports' | 'contradicts' | 'derives-from' | 'superseded-by' | 'refines';

interface EdgeTarget {
  id: string;
  /** Per-edge weight (e.g. the classifying NLI probability). Falls back to opts.weight. */
  weight?: number;
}

interface WriteEdgesOptions {
  weight?: number; // fallback weight, default 1.0
  createdBy?: string; // default 'auto'
  metadata?: Record<string, unknown>;
  direction?: 'outgoing' | 'incoming'; // default 'outgoing'
}

export async function writeClaimEdges(
  pivotClaimId: string,
  targets: Array<string | EdgeTarget>,
  relationType: ClaimRelationType,
  opts: WriteEdgesOptions = {},
): Promise<number> {
  if (targets.length === 0) {
    return 0;
  }
  const fallbackWeight = opts.weight ?? 1.0;
  const normalized = targets.map(t =>
    typeof t === 'string' ? { id: t, weight: fallbackWeight } : { id: t.id, weight: t.weight ?? fallbackWeight },
  );
  const seen = new Set<string>();
  const distinct = normalized.filter(t => {
    if (!t.id || t.id === pivotClaimId || seen.has(t.id)) {
      return false;
    }
    seen.add(t.id);
    return true;
  });
  if (distinct.length === 0) {
    return 0;
  }

  const createdBy = opts.createdBy ?? 'auto';
  const metadata = opts.metadata ?? null;
  const direction = opts.direction ?? 'outgoing';

  const values = distinct.map(t => ({
    id: ulid(),
    sourceClaimId: direction === 'outgoing' ? pivotClaimId : t.id,
    targetClaimId: direction === 'outgoing' ? t.id : pivotClaimId,
    relationType,
    weight: t.weight,
    createdBy,
    metadata,
  }));

  try {
    const inserted = await getDb()
      .insert(claimRelation)
      .values(values)
      .onConflictDoNothing({
        target: [claimRelation.sourceClaimId, claimRelation.targetClaimId, claimRelation.relationType],
      })
      .returning({ id: claimRelation.id });

    if (inserted.length > 0) {
      logger.info(
        {
          pivotClaimId,
          relationType,
          direction,
          attempted: distinct.length,
          inserted: inserted.length,
          createdBy,
        },
        'claim_relation edges written',
      );
    }
    return inserted.length;
  } catch (err) {
    // FK violation = one of the target claim ids didn't exist; happens
    // when KG carries claims that were deleted in between. Log and
    // swallow so the verify pipeline isn't blocked by stale references.
    logger.warn(
      {
        pivotClaimId,
        relationType,
        targets: distinct.length,
        error: (err as Error).message,
      },
      'claim_relation edge write failed (likely FK violation)',
    );
    return 0;
  }
}
