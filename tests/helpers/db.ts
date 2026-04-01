/**
 * Test database helper.
 * Requires a running PostgreSQL with pgvector + pgroonga extensions.
 * Set TEST_DATABASE_URL to use (defaults to knoldr_test database).
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../src/db/schema";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/knoldr_test";

let _client: ReturnType<typeof postgres> | null = null;
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getTestDb() {
  if (!_db) {
    _client = postgres(TEST_DB_URL, { max: 5 });
    _db = drizzle(_client, { schema });
  }
  return _db;
}

export function getTestClient() {
  if (!_client) {
    _client = postgres(TEST_DB_URL, { max: 5 });
  }
  return _client;
}

/** Run migrations on test DB */
export async function setupTestDb() {
  const sql = getTestClient();

  await sql`CREATE EXTENSION IF NOT EXISTS vector`;
  await sql`CREATE EXTENSION IF NOT EXISTS pgroonga`;

  // Create tables (simplified, no partitioning for tests)
  await sql`
    CREATE TABLE IF NOT EXISTS entry (
      id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'en',
      metadata JSONB,
      authority DOUBLE PRECISION NOT NULL DEFAULT 0.0,
      decay_rate DOUBLE PRECISION NOT NULL DEFAULT 0.01,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TIMESTAMPTZ NOT NULL,
      embedding vector(1536) NOT NULL,
      PRIMARY KEY (id, created_at)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS entry_domain (
      entry_id TEXT NOT NULL,
      entry_created_at TIMESTAMPTZ NOT NULL,
      domain TEXT NOT NULL,
      PRIMARY KEY (entry_id, entry_created_at, domain)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS entry_tag (
      entry_id TEXT NOT NULL,
      entry_created_at TIMESTAMPTZ NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (entry_id, entry_created_at, tag)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS entry_source (
      entry_id TEXT NOT NULL,
      entry_created_at TIMESTAMPTZ NOT NULL,
      url TEXT NOT NULL,
      source_type TEXT NOT NULL,
      trust DOUBLE PRECISION NOT NULL DEFAULT 0.0,
      PRIMARY KEY (entry_id, entry_created_at, url)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS ingest_log (
      id TEXT PRIMARY KEY,
      url_hash TEXT,
      entry_id TEXT,
      entry_created_at TIMESTAMPTZ,
      action TEXT NOT NULL,
      reason TEXT,
      ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS feedback_log (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      entry_created_at TIMESTAMPTZ NOT NULL,
      signal TEXT NOT NULL,
      reason TEXT,
      agent_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS retry_queue (
      id TEXT PRIMARY KEY,
      raw_content TEXT NOT NULL,
      source_url TEXT,
      error_reason TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      next_retry_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS crawl_domain (
      domain TEXT PRIMARY KEY,
      source_type TEXT NOT NULL DEFAULT 'unknown',
      trust DOUBLE PRECISION NOT NULL DEFAULT 0.1,
      blocked BOOLEAN NOT NULL DEFAULT false,
      block_reason TEXT,
      rate_limit_ms INTEGER NOT NULL DEFAULT 2000,
      robots_txt TEXT,
      robots_fetched_at TIMESTAMPTZ,
      config JSONB,
      total_crawled INTEGER NOT NULL DEFAULT 0,
      total_success INTEGER NOT NULL DEFAULT 0,
      last_crawled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  // pgroonga index
  await sql`CREATE INDEX IF NOT EXISTS idx_entry_fulltext ON entry USING pgroonga(title, content)`;
}

/** Clean all test data */
export async function cleanTestDb() {
  const sql = getTestClient();
  await sql`DELETE FROM feedback_log`;
  await sql`DELETE FROM ingest_log`;
  await sql`DELETE FROM entry_source`;
  await sql`DELETE FROM entry_tag`;
  await sql`DELETE FROM entry_domain`;
  await sql`DELETE FROM retry_queue`;
  await sql`DELETE FROM crawl_domain`;
  await sql`DELETE FROM entry`;
}

/** Close test DB connection */
export async function teardownTestDb() {
  if (_client) {
    await _client.end();
    _client = null;
    _db = null;
  }
}
