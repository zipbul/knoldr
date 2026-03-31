import {
  pgTable,
  text,
  doublePrecision,
  timestamp,
  boolean,
  jsonb,
  integer,
  index,
  uniqueIndex,
  primaryKey,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// -- Custom pgvector column type
// Drizzle doesn't have built-in vector support; use a custom column via sql.
// We store vectors as vector(1536) and use sql template for operations.
import { customType } from "drizzle-orm/pg-core";

const vector = customType<{ data: number[]; driverParam: string }>({
  dataType() {
    return "vector(1536)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: unknown): number[] {
    const str = String(value);
    return str
      .slice(1, -1)
      .split(",")
      .map(Number);
  },
});

// ============================================================
// entry — Core data table (partitioned by created_at)
// ============================================================
// NOTE: Partitioning (PARTITION BY RANGE) is not supported by drizzle-orm schema.
// We define the logical schema here; partitioning + partition tables are created
// via raw SQL in the migration script (src/db/migrate.ts).
export const entry = pgTable(
  "entry",
  {
    id: text("id").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    language: text("language").notNull().default("en"),
    metadata: jsonb("metadata"),
    authority: doublePrecision("authority").notNull().default(0.0),
    decayRate: doublePrecision("decay_rate").notNull().default(0.01),
    status: text("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    embedding: vector("embedding").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    check("entry_title_len", sql`length(${t.title}) <= 500`),
    check("entry_content_len", sql`length(${t.content}) <= 50000`),
    check("entry_authority_range", sql`${t.authority} >= 0 AND ${t.authority} <= 1`),
    check("entry_decay_rate_range", sql`${t.decayRate} >= 0 AND ${t.decayRate} <= 1`),
    check("entry_status_values", sql`${t.status} IN ('draft', 'active')`),
    check("entry_metadata_size", sql`pg_column_size(${t.metadata}) <= 1048576`),
    // pgroonga FTS index — created via raw SQL in migration (drizzle doesn't support pgroonga)
    index("idx_entry_status").on(t.status),
    index("idx_entry_authority").on(t.authority),
    index("idx_entry_language").on(t.language),
    index("idx_entry_created_at").on(t.createdAt),
  ],
);

// ============================================================
// entry_domain — M:N domain tags
// ============================================================
export const entryDomain = pgTable(
  "entry_domain",
  {
    entryId: text("entry_id").notNull(),
    entryCreatedAt: timestamp("entry_created_at", { withTimezone: true }).notNull(),
    domain: text("domain").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.entryId, t.entryCreatedAt, t.domain] }),
    foreignKey({
      columns: [t.entryId, t.entryCreatedAt],
      foreignColumns: [entry.id, entry.createdAt],
    }).onDelete("cascade"),
    check("entry_domain_len", sql`length(${t.domain}) <= 50`),
    index("idx_entry_domain_domain").on(t.domain),
  ],
);

// ============================================================
// entry_tag — M:N tags
// ============================================================
export const entryTag = pgTable(
  "entry_tag",
  {
    entryId: text("entry_id").notNull(),
    entryCreatedAt: timestamp("entry_created_at", { withTimezone: true }).notNull(),
    tag: text("tag").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.entryId, t.entryCreatedAt, t.tag] }),
    foreignKey({
      columns: [t.entryId, t.entryCreatedAt],
      foreignColumns: [entry.id, entry.createdAt],
    }).onDelete("cascade"),
    check("entry_tag_len", sql`length(${t.tag}) <= 50`),
    index("idx_entry_tag_tag").on(t.tag),
  ],
);

// ============================================================
// entry_source — M:N sources (normalized, not JSONB)
// ============================================================
export const entrySource = pgTable(
  "entry_source",
  {
    entryId: text("entry_id").notNull(),
    entryCreatedAt: timestamp("entry_created_at", { withTimezone: true }).notNull(),
    url: text("url").notNull(),
    sourceType: text("source_type").notNull(),
    trust: doublePrecision("trust").notNull().default(0.0),
  },
  (t) => [
    primaryKey({ columns: [t.entryId, t.entryCreatedAt, t.url] }),
    foreignKey({
      columns: [t.entryId, t.entryCreatedAt],
      foreignColumns: [entry.id, entry.createdAt],
    }).onDelete("cascade"),
    check("entry_source_trust_range", sql`${t.trust} >= 0 AND ${t.trust} <= 1`),
    index("idx_entry_source_type").on(t.sourceType),
  ],
);

// ============================================================
// source_feed — Collection pipeline feed configuration
// ============================================================
export const sourceFeed = pgTable("source_feed", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  feedType: text("feed_type").notNull(),
  schedule: text("schedule").notNull(),
  config: jsonb("config"),
  lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
  enabled: boolean("enabled").notNull().default(true),
});

// ============================================================
// ingest_log — Ingestion audit trail + URL dedup
// ============================================================
export const ingestLog = pgTable(
  "ingest_log",
  {
    id: text("id").primaryKey(),
    urlHash: text("url_hash"),
    sourceFeedId: text("source_feed_id").references(() => sourceFeed.id),
    entryId: text("entry_id"),
    entryCreatedAt: timestamp("entry_created_at", { withTimezone: true }),
    action: text("action").notNull(),
    reason: text("reason"),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("ingest_log_action_values", sql`${t.action} IN ('stored', 'duplicate', 'rejected')`),
    uniqueIndex("idx_ingest_log_url_hash")
      .on(t.urlHash)
      .where(sql`${t.urlHash} IS NOT NULL`),
    index("idx_ingest_log_ingested_at").on(t.ingestedAt),
  ],
);

// ============================================================
// feedback_log — Feedback audit trail
// ============================================================
export const feedbackLog = pgTable(
  "feedback_log",
  {
    id: text("id").primaryKey(),
    entryId: text("entry_id").notNull(),
    entryCreatedAt: timestamp("entry_created_at", { withTimezone: true }).notNull(),
    signal: text("signal").notNull(),
    reason: text("reason"),
    agentId: text("agent_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.entryId, t.entryCreatedAt],
      foreignColumns: [entry.id, entry.createdAt],
    }).onDelete("cascade"),
    check("feedback_log_signal_values", sql`${t.signal} IN ('positive', 'negative')`),
    index("idx_feedback_log_entry").on(t.entryId, t.createdAt),
    index("idx_feedback_log_agent_entry").on(t.agentId, t.entryId, t.createdAt),
  ],
);

// ============================================================
// retry_queue — Failed ingestion retry
// ============================================================
export const retryQueue = pgTable(
  "retry_queue",
  {
    id: text("id").primaryKey(),
    rawContent: text("raw_content").notNull(),
    sourceUrl: text("source_url"),
    sourceFeedId: text("source_feed_id").references(() => sourceFeed.id),
    errorReason: text("error_reason"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_retry_queue_next")
      .on(t.nextRetryAt)
      .where(sql`${t.attempts} < 3`),
  ],
);
