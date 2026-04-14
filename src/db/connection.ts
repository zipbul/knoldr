import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

function init(): ReturnType<typeof drizzle<typeof schema>> {
  if (_db) return _db;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  const client = postgres(connectionString, {
    max: 20,
    idle_timeout: 30,
    connect_timeout: 10,
  });

  _db = drizzle(client, { schema });
  return _db;
}

/** Lazy-initialized DB instance. Throws only when first accessed without DATABASE_URL. */
export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_, prop) {
    const instance = init();
    return (instance as unknown as Record<string | symbol, unknown>)[prop];
  },
});
