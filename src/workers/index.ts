// Background worker fabric.
//
// These cluster-singleton workers only poll the DB and drive the pipeline —
// they are not transport code — so they live here, started once at process
// boot (src/bootstrap.ts) independent of any MCP client session. `schedule`
// folds in the advisory lock (so a busy lock skips the tick, safe across
// overlapping ticks and replicas) and a uniform error boundary, leaving each
// worker as just its cadence, name, and body.

import { startFqaWorkers } from '../fqa/workers';
import { processRetryQueue } from '../ingest/retry-runner';
import { logger } from '../observability/logger';
import { withClusterLock } from '../observability/worker-lock';

const handles: ReturnType<typeof setInterval>[] = [];

/** Run `body` every `ms`, under the named cluster lock, with a uniform
 * try/catch error boundary. */
function schedule(ms: number, name: string, body: () => Promise<void>): void {
  handles.push(
    setInterval(
      () =>
        void withClusterLock(name, async () => {
          try {
            await body();
          } catch (err) {
            logger.error({ error: (err as Error).message }, `${name} failed`);
          }
        }),
      ms,
    ),
  );
}

export function startWorkers(): void {
  // Partition rollover — daily. Creates next-year's entry partition when
  // within 30 days of the year boundary. migrate.ts only pre-creates
  // currentYear+1 at install time; without this a 2026-12-31 write would
  // fail for lack of a 2027 partition. Idempotent CREATE IF NOT EXISTS.
  schedule(24 * 3600 * 1000, 'partition-rollover', async () => {
    const now = new Date();
    const yearEnd = new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1));
    const daysUntilBoundary = (yearEnd.getTime() - now.getTime()) / (24 * 3600 * 1000);
    if (daysUntilBoundary > 30) {
      return;
    }
    const { getDb } = await import('../db/connection');
    const { sql } = await import('drizzle-orm');
    const nextYear = now.getUTCFullYear() + 1;
    const partName = `entry_${nextYear}`;
    await getDb().execute(
      sql.raw(
        `CREATE TABLE IF NOT EXISTS ${partName} PARTITION OF entry
         FOR VALUES FROM ('${nextYear}-01-01') TO ('${nextYear + 1}-01-01')`,
      ),
    );
    logger.info({ partName, daysUntilBoundary: Math.round(daysUntilBoundary) }, 'next-year partition ensured');
  });

  // Batch dedup — daily at ~UTC 03:00. The advisory lock keeps it to one
  // replica; the >20h ingest_log recency guard keeps it to one run per UTC
  // day even though the timer checks every 10 minutes.
  schedule(10 * 60 * 1000, 'batch-dedup-daily', async () => {
    if (new Date().getUTCHours() < 3) {
      return;
    }
    const { getDb } = await import('../db/connection');
    const { sql } = await import('drizzle-orm');
    const r = (await getDb().execute(sql`
      SELECT MAX(ingested_at) AS last_run
      FROM ingest_log
      WHERE action = 'duplicate'
        AND reason LIKE 'batch_dedup:%'
    `)) as unknown as Array<{ last_run: Date | null }>;
    const last = r[0]?.last_run ? new Date(r[0].last_run).getTime() : 0;
    if (Date.now() - last < 20 * 3600 * 1000) {
      return;
    }
    const { batchDedup } = await import('../collect/batch-dedup');
    await batchDedup();
  });

  // Retry queue processor — every 5 minutes.
  schedule(5 * 60 * 1000, 'retry-queue', async () => {
    await processRetryQueue();
  });

  // Reclassify worker — every 90s, batch=3. Picks entries stored with
  // default metadata (0 tags) and re-runs batch classify.
  schedule(90 * 1000, 'reclassify-queue', async () => {
    const { processReclassifyQueue } = await import('../collect/reclassify-queue');
    await processReclassifyQueue(3);
  });

  // Claim extraction worker — every 60s, batch=3.
  schedule(60 * 1000, 'claim-extract', async () => {
    const { processClaimExtractionQueue } = await import('../claim/extract-queue');
    await processClaimExtractionQueue(3);
  });

  // KG triple extraction worker — every 120s, batch=3.
  schedule(120 * 1000, 'kg-extract', async () => {
    const { processKgExtractionQueue } = await import('../kg/extract-queue');
    await processKgExtractionQueue(3);
  });

  // Claim verify queue processor — every 60s, batch=6. Recomputes
  // factuality for entries touched by the batch.
  schedule(60 * 1000, 'verify-queue', async () => {
    const { processVerifyQueue, updateFactualityScore } = await import('../claim/verify');
    const processed = await processVerifyQueue(6);
    if (processed === 0) {
      return;
    }
    const { getDb } = await import('../db/connection');
    const { claim } = await import('../db/schema');
    const { sql } = await import('drizzle-orm');
    const recent = await getDb()
      .selectDistinct({ entryId: claim.entryId, entryCreatedAt: claim.entryCreatedAt })
      .from(claim)
      .where(sql`${claim.createdAt} > NOW() - INTERVAL '1 hour'`);
    for (const r of recent) {
      await updateFactualityScore(r.entryId, r.entryCreatedAt);
    }
  });

  // Calibration worker — every 30 minutes.
  schedule(30 * 60 * 1000, 'calibration', async () => {
    const { calibrate } = await import('../claim/calibration');
    await calibrate();
  });

  // Drift detector — every 6 hours, batch=5.
  schedule(6 * 60 * 60 * 1000, 'drift', async () => {
    const { detectDrift } = await import('../claim/reverify');
    await detectDrift(5);
  });

  // Invariant checks — every minute. Publishes Prometheus gauges.
  schedule(60 * 1000, 'invariants', async () => {
    const { runInvariantChecks } = await import('../observability/invariants');
    await runInvariantChecks();
  });

  // Smoke evaluation — every hour.
  schedule(60 * 60 * 1000, 'smoke-eval', async () => {
    const { runSmokeEval } = await import('../claim/smoke-eval');
    await runSmokeEval();
  });

  // FQA safety-net workers (audit-and-enrich + ttl-sweep). They keep their
  // own internal interval registry and honor KNOLDR_FQA_WORKERS=0.
  startFqaWorkers();

  logger.info({ workers: handles.length + 2 }, 'background workers started');
}

/** Stop the tracked interval workers on graceful shutdown. The FQA timers
 * manage their own lifecycle; the process is exiting anyway. */
export function stopWorkers(): void {
  for (const h of handles) {
    clearInterval(h);
  }
  handles.length = 0;
}
