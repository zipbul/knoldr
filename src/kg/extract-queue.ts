import { sql } from 'drizzle-orm';

import { getDb } from '../db/connection';
import { logger } from '../observability/logger';
import { extractTriples } from './extract';
import { storeTriples } from './store';

/**
 * KG triple extraction worker.
 *
 * Eligibility was previously verdict='verified' only — but verify is a
 * slow downstream stage and verified claims are a tiny minority of the
 * corpus (4 of 1281 in observed runs), so the KG ended up effectively
 * empty (4 entities / 2 relations) even with the worker running on
 * schedule. We now process any factual claim once it crosses a
 * minimum-certainty floor; the kg_relation weight encodes the verdict
 * so query-time consumers can filter at their preferred precision.
 *
 * Disputed claims are still skipped — the grounder said the source
 * contradicts them, and turning those into "facts" in the graph is
 * the citogenesis pattern we're trying to avoid.
 */
const MIN_KG_CERTAINTY = Number(process.env.KNOLDR_KG_MIN_CERTAINTY ?? 0.5);

// Livelock guard: claims whose extraction yielded ZERO triples were
// re-selected (and re-billed against the LLM) every tick forever —
// `kg_relation` rows are the only completion marker and none exist for
// them. Claims carry no metadata column, so the skip-list is an
// in-process bounded set: a restart retries each empty claim once,
// which is acceptable (one LLM call), while steady-state cost is zero.
const MAX_EMPTY_SKIP = 10_000;
const emptyExtractionSkip = new Set<string>();
function rememberEmpty(claimId: string): void {
  if (emptyExtractionSkip.size >= MAX_EMPTY_SKIP) {
    const first = emptyExtractionSkip.values().next().value;
    if (first !== undefined) {
      emptyExtractionSkip.delete(first);
    }
  }
  emptyExtractionSkip.add(claimId);
}

export async function processKgExtractionQueue(batchSize = 3): Promise<number> {
  const skip = Array.from(emptyExtractionSkip);
  const rows = await getDb().execute(sql`
    SELECT c.id, c.statement, c.verdict, c.certainty
    FROM claim c
    WHERE c.type = 'factual'
      AND c.verdict IN ('verified', 'unverified')
      AND c.certainty >= ${MIN_KG_CERTAINTY}
      AND NOT EXISTS (
        SELECT 1 FROM kg_relation r WHERE r.claim_id = c.id
      )
      AND NOT (c.id = ANY(${sql`ARRAY[${sql.join(skip.length > 0 ? skip.map(x => sql`${x}`) : [sql`''`], sql`, `)}]::text[]`}))
    ORDER BY
      CASE c.verdict WHEN 'verified' THEN 0 ELSE 1 END,
      c.certainty DESC,
      c.created_at DESC
    LIMIT ${batchSize}
  `);

  const batch = rows as unknown as Array<{
    id: string;
    statement: string;
    verdict: string;
    certainty: number;
  }>;
  if (batch.length === 0) {
    return 0;
  }

  let processed = 0;
  for (const row of batch) {
    try {
      const triples = await extractTriples(row.statement);
      if (triples.length === 0) {
        rememberEmpty(row.id);
        logger.debug({ claimId: row.id }, 'no triples extracted — skipped until restart');
        continue;
      }
      // Weight = certainty discounted by verdict. Verified claims keep
      // full weight; unverified claims land at half. Downstream
      // consumers (KG contradiction check, expansion) can threshold
      // on this directly.
      const verdictFactor = row.verdict === 'verified' ? 1.0 : 0.5;
      const weight = Math.max(0, Math.min(1, row.certainty * verdictFactor));
      await storeTriples(row.id, triples, weight);
      processed++;
    } catch (err) {
      logger.warn({ claimId: row.id, error: (err as Error).message }, 'KG extraction failed');
    }
  }

  if (processed > 0) {
    logger.info({ processed, batchSize }, 'KG extraction batch processed');
  }
  return processed;
}
