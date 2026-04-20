import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let _client: ReturnType<typeof postgres> | null = null;

function init(): ReturnType<typeof drizzle<typeof schema>> {
  if (_db) return _db;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  _client = postgres(connectionString, {
    // Pool sized for concurrent verify batch (15) × per-verify
    // connection demand (SELECT claim/queue/sources + KG queries
    // + per-tx UPDATE/DELETE). 20 was choking every worker when
    // batch=15 landed — failed queries cascaded through extract /
    // reclassify / retry workers that shared the pool. Postgres
    // default max_connections is 100; 80 leaves headroom for the
    // psql diagnostics + fine-tune sidecar.
    max: 80,
    idle_timeout: 30,
    connect_timeout: 10,
  });

  _db = drizzle(_client, { schema });
  return _db;
}

/** Lazy-initialized DB instance. Throws only when first accessed without DATABASE_URL. */
export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_, prop) {
    const instance = init();
    return (instance as unknown as Record<string | symbol, unknown>)[prop];
  },
});

/**
 * Raw postgres-js client for operations that require a *pinned*
 * session — specifically Postgres advisory locks, which are
 * session-scoped and cannot be released from a different connection
 * in the pool.
 */
export function getPgClient(): ReturnType<typeof postgres> {
  init();
  return _client!;
}
