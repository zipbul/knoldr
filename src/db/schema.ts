import {
  pgTable,
  text,
  doublePrecision,
  timestamp,
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
// We store vectors as vector(384) and use sql template for operations.
import { customType } from "drizzle-orm/pg-core";

const vector = customType<{ data: number[]; driverParam: string }>({
  dataType() {
    return "vector(384)";
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
// ingest_log — Ingestion audit trail + URL dedup
// ============================================================
export const ingestLog = pgTable(
  "ingest_log",
  {
    id: text("id").primaryKey(),
    urlHash: text("url_hash"),
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

// ============================================================
// claim — Atomic assertions extracted from entries (v0.3)
// ============================================================
// Each Entry may produce N claims; each claim is a single-fact proposition
// classified by epistemic type (factual/subjective/predictive/normative) and,
// for factual claims, verified by Pyreez deliberation into a verdict +
// certainty. Claim embeddings enable claim-level semantic retrieval and the
// db_cross_ref verification step.
export const claim = pgTable(
  "claim",
  {
    id: text("id").primaryKey(),
    entryId: text("entry_id").notNull(),
    entryCreatedAt: timestamp("entry_created_at", { withTimezone: true }).notNull(),
    statement: text("statement").notNull(),
    type: text("type").notNull(),
    verdict: text("verdict").notNull().default("unverified"),
    certainty: doublePrecision("certainty").notNull().default(0.0),
    evidence: jsonb("evidence"),
    embedding: vector("embedding").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.entryId, t.entryCreatedAt],
      foreignColumns: [entry.id, entry.createdAt],
    }).onDelete("cascade"),
    check(
      "claim_type_values",
      sql`${t.type} IN ('factual', 'subjective', 'predictive', 'normative')`,
    ),
    check(
      "claim_verdict_values",
      sql`${t.verdict} IN ('verified', 'disputed', 'unverified', 'not_applicable')`,
    ),
    check("claim_certainty_range", sql`${t.certainty} >= 0 AND ${t.certainty} <= 1`),
    check("claim_statement_len", sql`length(${t.statement}) <= 2000`),
    index("idx_claim_entry").on(t.entryId, t.entryCreatedAt),
    index("idx_claim_type_verdict").on(t.type, t.verdict),
    // pgvector hnsw index created via raw SQL in migration.
  ],
);

// ============================================================
// verify_queue — Factual claims awaiting Pyreez verification
// ============================================================
export const verifyQueue = pgTable(
  "verify_queue",
  {
    claimId: text("claim_id").primaryKey(),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    priority: integer("priority").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.claimId],
      foreignColumns: [claim.id],
    }).onDelete("cascade"),
    index("idx_verify_queue_next")
      .on(t.priority, t.nextAttemptAt)
      .where(sql`${t.attempts} < 3`),
  ],
);

// ============================================================
// entity — Knowledge Graph nodes (v0.4)
// ============================================================
export const entity = pgTable(
  "entity",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    aliases: text("aliases")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    metadata: jsonb("metadata"),
    embedding: vector("embedding").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("entity_name_len", sql`length(${t.name}) <= 200`),
    check("entity_type_len", sql`length(${t.type}) <= 50`),
    index("idx_entity_name").on(t.name),
    index("idx_entity_type").on(t.type),
    // pgvector hnsw index created via raw SQL in migration.
  ],
);

// ============================================================
// kg_relation — Knowledge Graph edges (v0.4)
// ============================================================
export const kgRelation = pgTable(
  "kg_relation",
  {
    id: text("id").primaryKey(),
    sourceEntityId: text("source_entity_id").notNull(),
    targetEntityId: text("target_entity_id").notNull(),
    relationType: text("relation_type").notNull(),
    claimId: text("claim_id"),
    weight: doublePrecision("weight").notNull().default(1.0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.sourceEntityId],
      foreignColumns: [entity.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.targetEntityId],
      foreignColumns: [entity.id],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.claimId],
      foreignColumns: [claim.id],
    }).onDelete("set null"),
    check("kg_relation_weight_range", sql`${t.weight} >= 0 AND ${t.weight} <= 1`),
    check(
      "kg_relation_no_self_loop",
      sql`${t.sourceEntityId} <> ${t.targetEntityId}`,
    ),
    uniqueIndex("uniq_kg_relation_edge")
      .on(t.sourceEntityId, t.targetEntityId, t.relationType, t.claimId),
    index("idx_kg_relation_source").on(t.sourceEntityId),
    index("idx_kg_relation_target").on(t.targetEntityId),
  ],
);

// ============================================================
// entry_score — Derived dimensions per entry (v0.3)
// ============================================================
// Composite PK (entry_id, entry_created_at, dimension). Partition-aware FK
// to entry.  `dimension` is an enumerable string for forward compatibility
// (v0.4 adds novelty/actionability/signal).
export const entryScore = pgTable(
  "entry_score",
  {
    entryId: text("entry_id").notNull(),
    entryCreatedAt: timestamp("entry_created_at", { withTimezone: true }).notNull(),
    dimension: text("dimension").notNull(),
    value: doublePrecision("value").notNull(),
    scoredAt: timestamp("scored_at", { withTimezone: true }).notNull().defaultNow(),
    scoredBy: text("scored_by").notNull().default("system"),
  },
  (t) => [
    primaryKey({ columns: [t.entryId, t.entryCreatedAt, t.dimension] }),
    foreignKey({
      columns: [t.entryId, t.entryCreatedAt],
      foreignColumns: [entry.id, entry.createdAt],
    }).onDelete("cascade"),
    check(
      "entry_score_dimension_values",
      sql`${t.dimension} IN ('factuality', 'novelty', 'actionability', 'signal')`,
    ),
    check("entry_score_value_range", sql`${t.value} >= 0 AND ${t.value} <= 1`),
    index("idx_entry_score_dimension").on(t.dimension, t.value),
  ],
);
