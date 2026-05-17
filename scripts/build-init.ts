#!/usr/bin/env bun
// Regenerate drizzle/0000_init.sql from schema.ts.
//
// This is the *post-processor* that turns drizzle-kit's auto-
// generated baseline into the form the project actually runs:
// drizzle-kit understands tables / columns / CHECK / FK / index,
// but does not model Postgres extensions, RANGE-partitioned tables,
// HNSW / pgroonga index types, or the legacy push-channel cleanup
// the v0.4 schema accumulated. We let drizzle-kit emit the naive
// baseline into a temp folder, then layer those additions on top.
//
// Run via `bun run db:generate`. The matching script in package.json
// chains this after `drizzle-kit generate` so a contributor cannot
// accidentally commit the unprocessed auto-gen output.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runDrizzleGenerate(outDir: string): void {
  const result = spawnSync(
    'bunx',
    ['drizzle-kit', 'generate', '--schema', './src/db/schema.ts', '--out', outDir, '--dialect', 'postgresql', '--name', 'init'],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    throw new Error(`drizzle-kit generate failed (exit ${result.status})`);
  }
}

function postProcess(autoGen: string): string {
  let out = autoGen;

  // IF NOT EXISTS on every CREATE TABLE / INDEX so the migration is
  // safe to re-apply against a pre-v0.4 deployment.
  out = out.replace(/^CREATE TABLE /gm, 'CREATE TABLE IF NOT EXISTS ');
  out = out.replace(/^CREATE INDEX /gm, 'CREATE INDEX IF NOT EXISTS ');
  out = out.replace(/^CREATE UNIQUE INDEX /gm, 'CREATE UNIQUE INDEX IF NOT EXISTS ');

  // Add PARTITION BY RANGE to the entry table. drizzle-kit emits the
  // CREATE TABLE with a trailing `);` — splice the PARTITION clause
  // before the semicolon.
  out = out.replace(/(CREATE TABLE IF NOT EXISTS "entry" \([\s\S]*?)\n\);/m, '$1\n) PARTITION BY RANGE ("created_at");');

  // Wrap every `ALTER TABLE ... ADD CONSTRAINT name FOREIGN KEY ...`
  // statement in a guarded DO block so re-running the migration
  // doesn't fail when the constraint already exists.
  out = out.replace(
    /^ALTER TABLE "(\w+)" ADD CONSTRAINT "([^"]+)" (FOREIGN KEY [\s\S]+?);(--> statement-breakpoint)?$/gm,
    (_m: string, table: string, name: string, body: string, br: string | undefined) => `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
    ALTER TABLE "${table}" ADD CONSTRAINT "${name}" ${body};
  END IF;
END $$;${br ?? ''}`,
  );

  // Embedding indexes must use HNSW (drizzle-kit emits plain btree on
  // a vector column, which is wrong for ANN search). Rewrite any
  // that landed; append the canonical set if drizzle-kit omitted
  // them.
  out = out.replace(
    /^CREATE INDEX IF NOT EXISTS "(idx_(?:entry|claim|entity)_embedding)" ON "(\w+)" USING btree \("embedding"\);/gm,
    'CREATE INDEX IF NOT EXISTS "$1" ON "$2" USING hnsw ("embedding" vector_cosine_ops);',
  );
  if (!/idx_entry_embedding/.test(out)) {
    out += '\nCREATE INDEX IF NOT EXISTS "idx_entry_embedding" ON "entry" USING hnsw ("embedding" vector_cosine_ops);';
  }
  if (!/idx_claim_embedding/.test(out)) {
    out += '\nCREATE INDEX IF NOT EXISTS "idx_claim_embedding" ON "claim" USING hnsw ("embedding" vector_cosine_ops);';
  }
  if (!/idx_entity_embedding/.test(out)) {
    out += '\nCREATE INDEX IF NOT EXISTS "idx_entity_embedding" ON "entity" USING hnsw ("embedding" vector_cosine_ops);';
  }

  // Case-insensitive entity uniqueness + lower(name) probe — needed
  // by upsertEntity and findConflictingObjects respectively.
  if (!/uniq_entity_type_name_ci/.test(out)) {
    out += '\nCREATE UNIQUE INDEX IF NOT EXISTS "uniq_entity_type_name_ci" ON "entity" ("type", lower("name"));';
  }
  if (!/idx_entity_name_lower/.test(out)) {
    out += '\nCREATE INDEX IF NOT EXISTS "idx_entity_name_lower" ON "entity" (lower("name"));';
  }

  // pgroonga fulltext on entry — drives the query skill's relevance.
  if (!/idx_entry_fulltext/.test(out)) {
    out += '\nCREATE INDEX IF NOT EXISTS "idx_entry_fulltext" ON "entry" USING pgroonga ("title", "content");';
  }

  // Legacy cleanup: obsolete table from prior crawler, retired push-
  // channel columns / CHECKs on claim_feedback, plus the one-time
  // verify_queue sweep for attempts > 3 stuck rows.
  const legacyCleanup = `
--> statement-breakpoint

-- Drop obsolete table from prior crawler architecture.
DROP TABLE IF EXISTS "crawl_domain";
--> statement-breakpoint

-- Legacy push-channel cleanup (pre-v0.4 columns + constraints).
ALTER TABLE "claim_feedback" DROP CONSTRAINT IF EXISTS "claim_feedback_callback_capability_values";
--> statement-breakpoint
ALTER TABLE "claim_feedback" DROP CONSTRAINT IF EXISTS "claim_feedback_callback_url_len";
--> statement-breakpoint
ALTER TABLE "claim_feedback" DROP CONSTRAINT IF EXISTS "claim_feedback_push_outcome_values";
--> statement-breakpoint
ALTER TABLE "claim_feedback" DROP COLUMN IF EXISTS "enrichment_callback_url";
--> statement-breakpoint
ALTER TABLE "claim_feedback" DROP COLUMN IF EXISTS "callback_capability";
--> statement-breakpoint
ALTER TABLE "claim_feedback" DROP COLUMN IF EXISTS "push_attempted_at";
--> statement-breakpoint
ALTER TABLE "claim_feedback" DROP COLUMN IF EXISTS "push_outcome";
--> statement-breakpoint

-- Legacy verify_queue sweep: anything past attempts=3 is committed
-- as unverified + dropped from the queue.
WITH stuck AS (SELECT "claim_id" FROM "verify_queue" WHERE "attempts" > 3)
UPDATE "claim"
SET "verdict" = 'unverified',
    "certainty" = 0,
    "evidence" = COALESCE("evidence", '{}'::jsonb)
      || jsonb_build_object('source', 'llm_jury', 'rationale', 'legacy stuck row swept')
WHERE "id" IN (SELECT "claim_id" FROM stuck)
  AND "verdict" = 'unverified';
--> statement-breakpoint
DELETE FROM "verify_queue" WHERE "attempts" > 3;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verify_queue_attempts_check') THEN
    BEGIN
      ALTER TABLE "verify_queue" ADD CONSTRAINT "verify_queue_attempts_check"
        CHECK ("attempts" >= 0 AND "attempts" <= 3);
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END IF;
END $$;
`;
  out += legacyCleanup;

  // Single-row calibration_state seed.
  out += '\n--> statement-breakpoint\nINSERT INTO "calibration_state" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;';

  // Header. (Fresh installs land every enum CHECK via the inline
  // `CONSTRAINT ... CHECK (...)` drizzle-kit emits at CREATE TABLE.
  // Legacy installs skip the CREATE TABLE entirely and have no
  // kebab CHECKs at this point — `0001_kebab_cleanup.sql` rewrites
  // snake values and then adds the named CHECKs.)
  const header = `-- Baseline schema migration.
--
-- Generated by \`bun run db:generate\` (drizzle-kit + scripts/build-init.ts).
-- Do not edit by hand; rerun \`db:generate\` after every schema.ts change.
--
-- \`scripts/build-init.ts\` post-processes drizzle-kit's auto-gen output
-- for Postgres features the generator doesn't model — extensions,
-- partitioning, HNSW / pgroonga index types, the legacy push-channel
-- cleanup, and IF-NOT-EXISTS idempotency.

CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgroonga;
--> statement-breakpoint
`;
  return header + out;
}

const tmp = mkdtempSync(join(tmpdir(), 'knoldr-build-init-'));
try {
  runDrizzleGenerate(tmp);
  const generated = readFileSync(join(tmp, '0000_init.sql'), 'utf8');
  const transformed = postProcess(generated);
  mkdirSync('drizzle', { recursive: true });
  writeFileSync('drizzle/0000_init.sql', transformed);
  console.log(`wrote drizzle/0000_init.sql (${transformed.split('\n').length} lines)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
