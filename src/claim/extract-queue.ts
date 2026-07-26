import { sql } from 'drizzle-orm';

import { getDb } from '../db/connection';
import { logger } from '../observability/logger';
import { extractClaims } from './extract';
import { storeClaims } from './store';
import { priorityForEntry } from './verify';

/**
 * Claim extraction runs out-of-band relative to ingest. This processor
 * picks up to `batchSize` entries that do not yet have any claims and
 * extracts them one at a time. Serialization keeps the LLM CLI spawn
 * count bounded even under bursty agent ingestion (batch submits of 20+ entries per
 * second would otherwise spawn 20 parallel CLI subprocesses).
 */
export async function processClaimExtractionQueue(batchSize = 3): Promise<number> {
  const rows = await getDb().execute(sql`
    SELECT e.id, e.title, e.content, e.created_at
    FROM entry e
    WHERE e.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM claim c
        WHERE c.entry_id = e.id AND c.entry_created_at = e.created_at
      )
      -- Livelock guard: entries whose extraction produced ZERO claims are
      -- stamped and skipped — without this they were re-selected (and
      -- re-billed against the LLM) every 60s tick forever.
      AND e.metadata->>'claim_extract_empty' IS NULL
    ORDER BY e.created_at DESC
    LIMIT ${batchSize}
  `);

  const batch = rows as unknown as Array<{
    id: string;
    title: string;
    content: string;
    // postgres driver returns TIMESTAMPTZ as Date here, but the raw
    // `execute` path surfaces strings in some driver versions. Normalize.
    created_at: Date | string;
  }>;

  if (batch.length === 0) {
    return 0;
  }

  let processed = 0;
  for (const row of batch) {
    const createdAt = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
    try {
      const extracted = await extractClaims(row.title, row.content);
      if (extracted.length === 0) {
        // Terminal empty marker (see the selection guard above). A later
        // re-ingest creates a NEW entry, so stamping is permanent-safe.
        await getDb().execute(sql`
          UPDATE entry
          SET metadata = COALESCE(metadata, '{}'::jsonb)
                         || jsonb_build_object('claim_extract_empty', NOW()::text)
          WHERE id = ${row.id} AND created_at = ${createdAt.toISOString()}::timestamptz
        `);
        logger.debug({ entryId: row.id }, 'claim extraction returned empty — stamped terminal');
        processed++;
        continue;
      }
      const priority = await priorityForEntry(row.id, createdAt);
      await storeClaims(row.id, createdAt, extracted, priority);
      processed++;
    } catch (err) {
      logger.warn({ entryId: row.id, error: (err as Error).message }, 'claim extraction failed');
    }
  }

  if (processed > 0) {
    logger.info({ processed, batchSize }, 'claim extraction batch processed');
  }
  return processed;
}
