// FQA background workers. No A2A surface — the reporter-facing
// completion path runs through `claim_feedback` (update mode) on
// the main Knoldr A2A. This module wires two periodic jobs:
//
//   - audit-and-enrich: pulls weak-evidence feedback rows in batches
//     and LLM-infers their missing structured fields. Defaults to a
//     60s cadence + 50 rows per batch. When a sweep returns a full
//     batch, immediately drains again (no idle gap) until the queue
//     stops returning full batches — this is the actual mechanism
//     that scales to high feedback volume.
//   - ttl-sweep: every 30 min, transitions stale awaiting_pull rows
//     to expired_reporter_unavailable.
//
// Both are wrapped in a Postgres advisory lock so overlapping ticks
// and multi-replica deployments can't double-enrich.
//
// Throughput math (defaults):
//   sustained: 60s × 50 = 3,000/hour = 72,000/day
//   peak drain: continuous loop until empty; only bounded by Ollama
//   inference time (~1-5s per row).
//
// Knobs (env):
//   KNOLDR_FQA_AUDIT_INTERVAL_MS    default 60_000
//   KNOLDR_FQA_AUDIT_BATCH          default 50
//   KNOLDR_FQA_AUDIT_WINDOW_HOURS   default 24
//   KNOLDR_FQA_AUDIT_MAX_DRAIN      default 20 (cap on chained
//                                   drain cycles per tick — keeps
//                                   the worker from monopolizing the
//                                   advisory lock if the queue is
//                                   genuinely unbounded)
//   KNOLDR_FQA_PULL_TTL_HOURS       default 24
//   KNOLDR_FQA_TTL_SWEEP_INTERVAL_MS default 30 min
//   KNOLDR_FQA_WORKERS=0            disables both workers

import { logger } from "../observability/logger";
import { withClusterLock } from "../observability/worker-lock";
import { auditAndEnrich, expireStalePullTasks } from "./enrich";

export function startFqaWorkers(): void {
  // Honor opt-out for deployments that want FQA wholly disabled.
  if (process.env.KNOLDR_FQA_WORKERS === "0") {
    logger.info("FQA workers disabled by KNOLDR_FQA_WORKERS=0");
    return;
  }

  const auditMs = Number(
    process.env.KNOLDR_FQA_AUDIT_INTERVAL_MS ?? 60_000,
  );
  const batchSize = Number(process.env.KNOLDR_FQA_AUDIT_BATCH ?? 50);
  const windowHours = Number(
    process.env.KNOLDR_FQA_AUDIT_WINDOW_HOURS ?? 24,
  );
  const maxDrain = Number(process.env.KNOLDR_FQA_AUDIT_MAX_DRAIN ?? 20);

  // Continuous-drain sweep:
  // - Acquire the lock once per tick.
  // - Pull a batch. If scanned === batchSize the queue may have
  //   more; pull again immediately. Repeat up to maxDrain times.
  // - Release the lock between ticks so a co-located finetune cycle
  //   or a sibling replica can take a turn.
  const runDrainCycle = async (): Promise<void> => {
    await withClusterLock("fqa-audit", async () => {
      let drainPasses = 0;
      let totalScanned = 0;
      let totalEnriched = 0;
      const skippedAgg = new Map<string, number>();
      try {
        for (let i = 0; i < maxDrain; i++) {
          const report = await auditAndEnrich({
            timeWindowHours: windowHours,
            maxItems: batchSize,
          });
          totalScanned += report.scanned;
          totalEnriched += report.enriched;
          for (const s of report.skipped) {
            skippedAgg.set(s.reason, (skippedAgg.get(s.reason) ?? 0) + s.count);
          }
          drainPasses++;
          if (report.scanned < batchSize) break; // queue drained
        }
        if (totalScanned > 0) {
          logger.info(
            {
              drainPasses,
              totalScanned,
              totalEnriched,
              skipped: Array.from(skippedAgg, ([reason, count]) => ({
                reason,
                count,
              })),
              hitDrainCap: drainPasses === maxDrain,
            },
            "FQA audit drain complete",
          );
        }
      } catch (err) {
        logger.error(
          { error: (err as Error).message },
          "FQA audit drain failed",
        );
      }
    });
  };

  setInterval(runDrainCycle, auditMs);

  const ttlHours = Number(process.env.KNOLDR_FQA_PULL_TTL_HOURS ?? "24");
  const ttlMs = Number(
    process.env.KNOLDR_FQA_TTL_SWEEP_INTERVAL_MS ?? 30 * 60 * 1000,
  );
  setInterval(async () => {
    await withClusterLock("fqa-ttl-sweep", async () => {
      try {
        await expireStalePullTasks(ttlHours);
      } catch (err) {
        logger.error(
          { error: (err as Error).message },
          "FQA TTL sweep failed",
        );
      }
    });
  }, ttlMs);

  logger.info(
    { auditMs, batchSize, windowHours, maxDrain, ttlMs, ttlHours },
    "FQA background workers started",
  );
}
