import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let _client: ReturnType<typeof postgres> | null = null;

function init() {
  if (_db) return { db: _db, client: _client! };

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  _client = postgres(connectionString, {
    max: 20,
    idle_timeout: 30,
    connect_timeout: 10,
  });

  _db = drizzle(_client, { schema });
  return { db: _db, client: _client };
}

/** Lazy-initialized DB instance. Throws only when first accessed without DATABASE_URL. */
export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_, prop) {
    const { db } = init();
    return (db as unknown as Record<string | symbol, unknown>)[prop];
  },
});

export function getClient() {
  return init().client;
}
