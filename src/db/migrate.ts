import postgres from "postgres";
import { logger } from "../observability/logger";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is required");
}

const sql = postgres(connectionString, { max: 1 });

async function migrate() {
  logger.info("running migrations");

  // Extensions
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;
  await sql`CREATE EXTENSION IF NOT EXISTS pgroonga`;

  // ============================================================
  // entry (partitioned by created_at)
  // ============================================================
  await sql`
    CREATE TABLE IF NOT EXISTS entry (
      id TEXT NOT NULL,
      title TEXT NOT NULL CHECK (length(title) <= 500),
      content TEXT NOT NULL CHECK (length(content) <= 50000),
      language TEXT NOT NULL DEFAULT 'en',
      metadata JSONB CHECK (pg_column_size(metadata) <= 1048576),
      authority DOUBLE PRECISION NOT NULL DEFAULT 0.0 CHECK (authority >= 0 AND authority <= 1),
      decay_rate DOUBLE PRECISION NOT NULL DEFAULT 0.01 CHECK (decay_rate >= 0 AND decay_rate <= 1),
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active')),
      created_at TIMESTAMPTZ NOT NULL,
      embedding vector(384) NOT NULL,
      PRIMARY KEY (id, created_at)
    ) PARTITION BY RANGE (created_at)
  `;

  // Partitions
  const currentYear = new Date().getFullYear();
  for (let year = 2025; year <= currentYear + 1; year++) {
    const partName = `entry_${year}`;
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${partName} PARTITION OF entry
        FOR VALUES FROM ('${year}-01-01') TO ('${year + 1}-01-01')
    `);
  }

  // entry indexes
  await sql`CREATE INDEX IF NOT EXISTS idx_entry_fulltext ON entry USING pgroonga(title, content)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_entry_status ON entry(status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_entry_authority ON entry(authority DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_entry_language ON entry(language)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_entry_created_at ON entry(created_at DESC)`;

  // ============================================================
  // entry_domain
  // ============================================================
  await sql`
    CREATE TABLE IF NOT EXISTS entry_domain (
      entry_id TEXT NOT NULL,
      entry_created_at TIMESTAMPTZ NOT NULL,
      domain TEXT NOT NULL CHECK (length(domain) <= 50),
      PRIMARY KEY (entry_id, entry_created_at, domain),
      FOREIGN KEY (entry_id, entry_created_at) REFERENCES entry(id, created_at) ON DELETE CASCADE
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_entry_domain_domain ON entry_domain(domain)`;

  // ============================================================
  // entry_tag
  // ============================================================
  await sql`
    CREATE TABLE IF NOT EXISTS entry_tag (
      entry_id TEXT NOT NULL,
      entry_created_at TIMESTAMPTZ NOT NULL,
      tag TEXT NOT NULL CHECK (length(tag) <= 50),
      PRIMARY KEY (entry_id, entry_created_at, tag),
      FOREIGN KEY (entry_id, entry_created_at) REFERENCES entry(id, created_at) ON DELETE CASCADE
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_entry_tag_tag ON entry_tag(tag)`;

  // ============================================================
  // entry_source
  // ============================================================
  await sql`
    CREATE TABLE IF NOT EXISTS entry_source (
      entry_id TEXT NOT NULL,
      entry_created_at TIMESTAMPTZ NOT NULL,
      url TEXT NOT NULL,
      source_type TEXT NOT NULL,
      trust DOUBLE PRECISION NOT NULL DEFAULT 0.0 CHECK (trust >= 0 AND trust <= 1),
      PRIMARY KEY (entry_id, entry_created_at, url),
      FOREIGN KEY (entry_id, entry_created_at) REFERENCES entry(id, created_at) ON DELETE CASCADE
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_entry_source_type ON entry_source(source_type)`;

  // ============================================================
  // ingest_log
  // ============================================================
  await sql`
    CREATE TABLE IF NOT EXISTS ingest_log (
      id TEXT PRIMARY KEY,
      url_hash TEXT,
      entry_id TEXT,
      entry_created_at TIMESTAMPTZ,
      action TEXT NOT NULL CHECK (action IN ('stored', 'duplicate', 'rejected')),
      reason TEXT,
      ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_ingest_log_url_hash ON ingest_log(url_hash) WHERE url_hash IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ingest_log_ingested_at ON ingest_log(ingested_at DESC)`;

  // ============================================================
  // feedback_log
  // ============================================================
  await sql`
    CREATE TABLE IF NOT EXISTS feedback_log (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      entry_created_at TIMESTAMPTZ NOT NULL,
      signal TEXT NOT NULL CHECK (signal IN ('positive', 'negative')),
      reason TEXT,
      agent_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      FOREIGN KEY (entry_id, entry_created_at) REFERENCES entry(id, created_at) ON DELETE CASCADE
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_feedback_log_entry ON feedback_log(entry_id, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_feedback_log_agent_entry ON feedback_log(agent_id, entry_id, created_at DESC)`;

  // ============================================================
  // retry_queue
  // ============================================================
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
  await sql`CREATE INDEX IF NOT EXISTS idx_retry_queue_next ON retry_queue(next_retry_at) WHERE attempts < 3`;

  // Drop obsolete table from prior crawler architecture
  await sql`DROP TABLE IF EXISTS crawl_domain`;

  // ============================================================
  // claim (v0.3) — atomic assertions extracted from entries
  // ============================================================
  await sql`
    CREATE TABLE IF NOT EXISTS claim (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      entry_created_at TIMESTAMPTZ NOT NULL,
      statement TEXT NOT NULL CHECK (length(statement) <= 2000),
      type TEXT NOT NULL CHECK (type IN ('factual', 'subjective', 'predictive', 'normative')),
      verdict TEXT NOT NULL DEFAULT 'unverified'
        CHECK (verdict IN ('verified', 'disputed', 'unverified', 'not_applicable')),
      certainty DOUBLE PRECISION NOT NULL DEFAULT 0.0 CHECK (certainty >= 0 AND certainty <= 1),
      evidence JSONB,
      embedding vector(384) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      FOREIGN KEY (entry_id, entry_created_at)
        REFERENCES entry(id, created_at) ON DELETE CASCADE
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_claim_entry ON claim(entry_id, entry_created_at)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_claim_type_verdict ON claim(type, verdict)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_claim_embedding ON claim USING hnsw(embedding vector_cosine_ops)`;

  // ============================================================
  // verify_queue (v0.3)
  // ============================================================
  await sql`
    CREATE TABLE IF NOT EXISTS verify_queue (
      claim_id TEXT PRIMARY KEY REFERENCES claim(id) ON DELETE CASCADE,
      queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      priority INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_verify_queue_next ON verify_queue(priority DESC, next_attempt_at) WHERE attempts < 3`;

  // ============================================================
  // entry_score (v0.3) — per-entry derived dimensions
  // ============================================================
  await sql`
    CREATE TABLE IF NOT EXISTS entry_score (
      entry_id TEXT NOT NULL,
      entry_created_at TIMESTAMPTZ NOT NULL,
      dimension TEXT NOT NULL CHECK (dimension IN ('factuality', 'novelty', 'actionability', 'signal')),
      value DOUBLE PRECISION NOT NULL CHECK (value >= 0 AND value <= 1),
      scored_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      scored_by TEXT NOT NULL DEFAULT 'system',
      PRIMARY KEY (entry_id, entry_created_at, dimension),
      FOREIGN KEY (entry_id, entry_created_at)
        REFERENCES entry(id, created_at) ON DELETE CASCADE
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_entry_score_dimension ON entry_score(dimension, value)`;

  logger.info("migrations complete");
  await sql.end();
}

migrate().catch((err) => {
  logger.error(err, "migration failed");
  process.exit(1);
});
