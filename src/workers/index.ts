// Background worker fabric.
//
// These cluster-singleton workers were previously registered inside the
// A2A server's startServer(). They are NOT transport code — each only
// polls the DB and drives the pipeline — so they live here, started
// once at process boot (src/index.ts) independent of any MCP client
// session. Each tick is wrapped in withClusterLock so a busy advisory
// lock skips the tick: safe across overlapping ticks and replicas.

import { startFqaWorkers } from '../fqa/workers';
import { processRetryQueue } from '../ingest/retry-runner';
import { logger } from '../observability/logger';
import { withClusterLock } from '../observability/worker-lock';

const handles: ReturnType<typeof setInterval>[] = [];

function every(ms: number, fn: () => void | Promise<void>): void {
  handles.push(setInterval(fn, ms));
}

export function startWorkers(): void {
  // Partition rollover — daily. Creates next-year's entry partition
  // when within 30 days of the year boundary. migrate.ts only
  // pre-creates currentYear+1 at install time; without this worker
  // a 2026-12-31 production write would fail because no 2027
  // partition exists. Idempotent CREATE IF NOT EXISTS.
  every(24 * 3600 * 1000, async () => {
    await withClusterLock('partition-rollover', async () => {
      try {
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
      } catch (err) {
        logger.error({ error: (err as Error).message }, 'partition rollover failed');
      }
    });
  });

  // Batch dedup job — daily at UTC 03:00. Postgres advisory lock keeps
  // it to one replica; the >20h ingest_log recency guard keeps it to
  // one run per UTC day even though the timer checks every 10 minutes.
  every(10 * 60 * 1000, async () => {
    const now = new Date();
    if (now.getUTCHours() < 3) {
      return;
    }
    await withClusterLock('batch-dedup-daily', async () => {
      try {
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
      } catch (err) {
        logger.error({ error: (err as Error).message }, 'batch dedup failed');
      }
    });
  });

  // Retry queue processor — every 5 minutes
  every(5 * 60 * 1000, async () => {
    await withClusterLock('retry-queue', async () => {
      try {
        await processRetryQueue();
      } catch (err) {
        logger.error({ error: (err as Error).message }, 'retry queue processing failed');
      }
    });
  });

  // Reclassify worker — every 90 seconds, batch=3. Picks entries stored
  // with default metadata (0 tags) and re-runs batch classify.
  every(90 * 1000, async () => {
    await withClusterLock('reclassify-queue', async () => {
      try {
        const { processReclassifyQueue } = await import('../collect/reclassify-queue');
        await processReclassifyQueue(3);
      } catch (err) {
        logger.error({ error: (err as Error).message }, 'reclassify worker failed');
      }
    });
  });

  // Claim extraction worker — every 60 seconds, batch=3.
  every(60 * 1000, async () => {
    await withClusterLock('claim-extract', async () => {
      try {
        const { processClaimExtractionQueue } = await import('../claim/extract-queue');
        await processClaimExtractionQueue(3);
      } catch (err) {
        logger.error({ error: (err as Error).message }, 'claim extraction worker failed');
      }
    });
  });

  // KG triple extraction worker — every 120 seconds, batch=3.
  every(120 * 1000, async () => {
    await withClusterLock('kg-extract', async () => {
      try {
        const { processKgExtractionQueue } = await import('../kg/extract-queue');
        await processKgExtractionQueue(3);
      } catch (err) {
        logger.error({ error: (err as Error).message }, 'KG extraction worker failed');
      }
    });
  });

  // Claim verify queue processor — every 60 seconds, batch=6. Recomputes
  // factuality for entries touched by the batch.
  every(60 * 1000, async () => {
    await withClusterLock('verify-queue', async () => {
      try {
        const { processVerifyQueue, updateFactualityScore } = await import('../claim/verify');
        const processed = await processVerifyQueue(6);
        if (processed > 0) {
          const { getDb } = await import('../db/connection');
          const { claim } = await import('../db/schema');
          const { sql } = await import('drizzle-orm');
          const recent = await getDb()
            .selectDistinct({
              entryId: claim.entryId,
              entryCreatedAt: claim.entryCreatedAt,
            })
            .from(claim)
            .where(sql`${claim.createdAt} > NOW() - INTERVAL '1 hour'`);
          for (const r of recent) {
            await updateFactualityScore(r.entryId, r.entryCreatedAt);
          }
        }
      } catch (err) {
        logger.error({ error: (err as Error).message }, 'verify queue processing failed');
      }
    });
  });

  // Calibration worker — every 30 minutes.
  every(30 * 60 * 1000, async () => {
    await withClusterLock('calibration', async () => {
      try {
        const { calibrate } = await import('../claim/calibration');
        await calibrate();
      } catch (err) {
        logger.error({ error: (err as Error).message }, 'calibration failed');
      }
    });
  });

  // Drift detector — every 6 hours, batch=5.
  every(6 * 60 * 60 * 1000, async () => {
    await withClusterLock('drift', async () => {
      try {
        const { detectDrift } = await import('../claim/reverify');
        await detectDrift(5);
      } catch (err) {
        logger.error({ error: (err as Error).message }, 'drift detection failed');
      }
    });
  });

  // Invariant checks — every minute. Publishes Prometheus gauges.
  every(60 * 1000, async () => {
    await withClusterLock('invariants', async () => {
      try {
        const { runInvariantChecks } = await import('../observability/invariants');
        await runInvariantChecks();
      } catch (err) {
        logger.error({ error: (err as Error).message }, 'invariant checks failed');
      }
    });
  });

  // Smoke evaluation — every hour.
  every(60 * 60 * 1000, async () => {
    await withClusterLock('smoke-eval', async () => {
      try {
        const { runSmokeEval } = await import('../claim/smoke-eval');
        await runSmokeEval();
      } catch (err) {
        logger.error({ error: (err as Error).message }, 'smoke eval failed');
      }
    });
  });

  // FQA safety-net workers (audit-and-enrich + ttl-sweep). They keep
  // their own internal interval registry and honor KNOLDR_FQA_WORKERS=0.
  startFqaWorkers();

  logger.info({ workers: handles.length + 2 }, 'background workers started');
}

/** Stop the tracked interval workers on graceful shutdown. The FQA
 * timers manage their own lifecycle; the process is exiting anyway. */
export function stopWorkers(): void {
  for (const h of handles) {
    clearInterval(h);
  }
  handles.length = 0;
}
