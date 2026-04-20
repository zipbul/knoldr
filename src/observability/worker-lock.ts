import { sql } from "drizzle-orm";
import { db } from "../db/connection";
import { logger } from "./logger";

/**
 * Postgres advisory-lock based mutex for cluster-wide singleton
 * workers.
 *
 * The server's setInterval loops (batch dedup, reclassify, claim
 * extraction, KG extraction, verify, calibration, drift, invariants,
 * smoke eval) were all using process-local flags (e.g. `verifyRunning`)
 * or no flag at all. In a single-process deployment this is fine; as
 * soon as you scale to two replicas every tick runs on every replica
 * — 2× batch-dedup, 2× calibration, 2× smoke eval, 2× drift, etc.
 *
 * `pg_try_advisory_lock` gives us a non-blocking lock that survives as
 * long as the Postgres SESSION holds it. We grab the lock before each
 * worker body runs; release in a `finally` so a crash frees the
 * session and the lock unwinds naturally.
 *
 * Key space is a 64-bit integer — hash the worker name so operators
 * don't need to manage numbers.
 */
function keyFor(name: string): bigint {
  // 64-bit FNV-1a
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  for (let i = 0; i < name.length; i++) {
    h ^= BigInt(name.charCodeAt(i));
    h = (h * prime) & mask;
  }
  // Map uint64 → int64 two's complement so the number fits
  // Postgres's signed bigint argument.
  const signMask = 1n << 63n;
  return h >= signMask ? h - (1n << 64n) : h;
}

/**
 * Run `fn` exactly once across the cluster for each tick. Returns the
 * fn's return value on success, or null if another replica holds the
 * lock (caller should skip silently).
 */
export async function withClusterLock<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const key = keyFor(name);
  const acquired = (await db.execute(
    sql`SELECT pg_try_advisory_lock(${key.toString()}::bigint) AS ok`,
  )) as unknown as Array<{ ok: boolean }>;
  if (!acquired[0]?.ok) {
    logger.debug({ worker: name }, "advisory lock busy, skipping tick");
    return null;
  }
  try {
    return await fn();
  } finally {
    try {
      await db.execute(sql`SELECT pg_advisory_unlock(${key.toString()}::bigint)`);
    } catch (err) {
      logger.warn({ worker: name, error: (err as Error).message }, "lock release failed");
    }
  }
}
