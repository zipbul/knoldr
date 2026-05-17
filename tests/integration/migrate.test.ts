/**
 * Migration regression tests.
 *
 * Covers the two behaviors that broke silently in earlier rounds:
 *   1. Idempotency — running migrate twice in a row must succeed,
 *      preserving applied state and inserting no spurious rows.
 *   2. snake → kebab conversion — a pre-v0.4 deployment seeded with
 *      snake_case enum values must end up with every row carrying
 *      the project-wide kebab convention AND the named *_values
 *      CHECK constraint flipped to enforced (VALIDATE CONSTRAINT).
 *
 * Both tests spin a dedicated ephemeral database next to the main
 * test DB so they don't interfere with parallel suites.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate as drizzleMigrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/knoldr_test';

/** Build the admin connection (defaults to postgres super-db). */
function adminClient() {
  // Connect to the `postgres` maintenance DB on the same host/port
  // as TEST_DATABASE_URL so we can CREATE / DROP databases.
  const u = new URL(ADMIN_URL);
  u.pathname = '/postgres';
  return postgres(u.toString(), { max: 1 });
}

async function createDb(name: string) {
  const admin = adminClient();
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  await admin.end();
}

async function dropDb(name: string) {
  const admin = adminClient();
  await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
  await admin.end();
}

function dbUrl(name: string): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${name}`;
  return u.toString();
}

async function runMigrate(dbName: string): Promise<void> {
  const sql = postgres(dbUrl(dbName), { max: 1 });
  const db = drizzle(sql);
  await drizzleMigrate(db, { migrationsFolder: './drizzle' });
  const currentYear = new Date().getFullYear();
  for (let year = 2025; year <= currentYear + 1; year++) {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS entry_${year} PARTITION OF entry
        FOR VALUES FROM ('${year}-01-01') TO ('${year + 1}-01-01')
    `);
  }
  await sql.end();
}

// Skip everything when the test DB is unreachable.
const dbAvailable = await (async () => {
  try {
    const probe = postgres(ADMIN_URL, { max: 1 });
    await probe`SELECT 1`;
    await probe.end();
    return true;
  } catch (err) {
    console.warn('⚠ Test DB unavailable, skipping migrate tests:', (err as Error).message);
    return false;
  }
})();

const tmpDbs: string[] = [];

afterAll(async () => {
  for (const name of tmpDbs) {
    await dropDb(name);
  }
});

describe('migrate — idempotency', () => {
  test.skipIf(!dbAvailable)('running migrate twice on a fresh DB is a no-op the second time', async () => {
    const name = `knoldr_mig_idempotent_${Date.now()}`;
    tmpDbs.push(name);
    await createDb(name);
    await runMigrate(name);

    // After the first run, capture row counts on the migration journal.
    const sql1 = postgres(dbUrl(name), { max: 1 });
    const [{ count: applied1 }] = await sql1<{ count: string }[]>`
      SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations
    `;
    await sql1.end();
    expect(Number(applied1)).toBeGreaterThan(0);

    // Second run shouldn't add anything.
    await runMigrate(name);
    const sql2 = postgres(dbUrl(name), { max: 1 });
    const [{ count: applied2 }] = await sql2<{ count: string }[]>`
      SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations
    `;
    await sql2.end();
    expect(applied2).toBe(applied1);
  });
});

describe('migrate — snake → kebab conversion', () => {
  test.skipIf(!dbAvailable)('rewrites every legacy snake_case enum column and validates every kebab CHECK', async () => {
    const name = `knoldr_mig_snake_${Date.now()}`;
    tmpDbs.push(name);
    await createDb(name);

    // Seed the DB the way a pre-v0.4 deployment looked: schema
    // with no kebab CHECKs at all and snake values stored
    // verbatim on every enum column the migration knows how to
    // rewrite (claim.verdict, verdict_log.verdict,
    // golden_set_claim.expected_verdict, claim_relation.relation_type,
    // claim_feedback.application_method / failure_dimension /
    // failure_dimension_inferred / enrichment_status,
    // entry_source.source_type). Anything 0001 rewrites must be
    // exercised here or a future regression in the UPDATE list
    // ships silently.
    const seed = postgres(dbUrl(name), { max: 1 });
    await seed.unsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
    await seed.unsafe(`CREATE EXTENSION IF NOT EXISTS pgroonga`);
    await seed.unsafe(`
      CREATE TABLE entry (
        id text NOT NULL,
        title text NOT NULL,
        content text NOT NULL,
        language text NOT NULL DEFAULT 'en',
        metadata jsonb,
        authority double precision NOT NULL DEFAULT 0.0,
        decay_rate double precision NOT NULL DEFAULT 0.01,
        status text NOT NULL DEFAULT 'draft',
        created_at timestamptz NOT NULL,
        embedding vector(384) NOT NULL,
        PRIMARY KEY (id, created_at)
      ) PARTITION BY RANGE (created_at)
    `);
    await seed.unsafe(`
      CREATE TABLE entry_2025 PARTITION OF entry
        FOR VALUES FROM ('2025-01-01') TO ('2026-01-01')
    `);
    await seed.unsafe(`
      CREATE TABLE entry_source (
        entry_id text NOT NULL,
        entry_created_at timestamptz NOT NULL,
        url text NOT NULL,
        source_type text NOT NULL,
        trust double precision DEFAULT 0.0,
        PRIMARY KEY (entry_id, entry_created_at, url),
        FOREIGN KEY (entry_id, entry_created_at) REFERENCES entry(id, created_at) ON DELETE CASCADE
      )
    `);
    await seed.unsafe(`
      CREATE TABLE claim (
        id text PRIMARY KEY,
        entry_id text NOT NULL,
        entry_created_at timestamptz NOT NULL,
        statement text NOT NULL,
        type text NOT NULL,
        verdict text NOT NULL DEFAULT 'unverified',
        certainty double precision NOT NULL DEFAULT 0.0,
        evidence jsonb,
        embedding vector(384) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (entry_id, entry_created_at) REFERENCES entry(id, created_at) ON DELETE CASCADE
      )
    `);
    await seed.unsafe(`
      CREATE TABLE verdict_log (
        id text PRIMARY KEY,
        claim_id text NOT NULL REFERENCES claim(id) ON DELETE CASCADE,
        verdict text NOT NULL,
        certainty double precision NOT NULL,
        evidence_source text,
        grounder_model text,
        trigger text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await seed.unsafe(`
      CREATE TABLE golden_set_claim (
        id text PRIMARY KEY,
        statement text NOT NULL,
        claim_type text NOT NULL,
        expected_verdict text NOT NULL,
        domain text,
        source_hint text,
        labeled_by text NOT NULL,
        labeled_at timestamptz NOT NULL DEFAULT now(),
        notes text,
        active integer NOT NULL DEFAULT 1
      )
    `);
    await seed.unsafe(`
      CREATE TABLE claim_relation (
        id text PRIMARY KEY,
        source_claim_id text NOT NULL REFERENCES claim(id) ON DELETE CASCADE,
        target_claim_id text NOT NULL REFERENCES claim(id) ON DELETE CASCADE,
        relation_type text NOT NULL,
        weight double precision NOT NULL DEFAULT 1.0,
        created_by text NOT NULL,
        metadata jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await seed.unsafe(`
      CREATE TABLE claim_feedback (
        id text PRIMARY KEY,
        claim_id text NOT NULL REFERENCES claim(id) ON DELETE CASCADE,
        reporter_agent_id text NOT NULL,
        observed_at timestamptz NOT NULL DEFAULT now(),
        application_method text NOT NULL,
        outcome text NOT NULL,
        failure_dimension text,
        partial_truth double precision,
        context_domain text,
        context_time_from timestamptz,
        context_time_until timestamptz,
        context_scope jsonb,
        counter_source_url text,
        counter_claim_text text,
        counter_nli_score double precision,
        audit_note text,
        failure_dimension_inferred text,
        partial_truth_inferred double precision,
        counter_source_url_inferred text,
        enriched_at timestamptz,
        enriched_by text,
        enrichment_llm_version text,
        reporter_responded integer,
        enrichment_status text NOT NULL DEFAULT 'pending',
        evidence_strength double precision NOT NULL DEFAULT 0.0,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await seed.unsafe(`
      CREATE TABLE feedback_log (
        id text PRIMARY KEY,
        entry_id text NOT NULL,
        entry_created_at timestamptz NOT NULL,
        signal text NOT NULL,
        reason text,
        agent_id text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (entry_id, entry_created_at) REFERENCES entry(id, created_at) ON DELETE CASCADE
      )
    `);
    const zeroVec = `[${new Array(384).fill(0).join(',')}]`;
    await seed.unsafe(
      `INSERT INTO entry (id, title, content, created_at, embedding) VALUES ('legacy-1', 't', 'c', '2025-06-15T00:00:00Z', '${zeroVec}'::vector)`,
    );
    await seed.unsafe(`INSERT INTO entry_source (entry_id, entry_created_at, url, source_type, trust) VALUES
      ('legacy-1', '2025-06-15T00:00:00Z', 'https://docs',     'official_docs',     0.9),
      ('legacy-1', '2025-06-15T00:00:00Z', 'https://gh',       'github_release',    0.85),
      ('legacy-1', '2025-06-15T00:00:00Z', 'https://cve',      'cve_db',            0.9),
      ('legacy-1', '2025-06-15T00:00:00Z', 'https://blog',     'official_blog',     0.8),
      ('legacy-1', '2025-06-15T00:00:00Z', 'https://paper',    'research_paper',    0.75),
      ('legacy-1', '2025-06-15T00:00:00Z', 'https://medium',   'established_blog',  0.6),
      ('legacy-1', '2025-06-15T00:00:00Z', 'https://so',       'community_forum',   0.4),
      ('legacy-1', '2025-06-15T00:00:00Z', 'https://personal', 'personal_blog',     0.3),
      ('legacy-1', '2025-06-15T00:00:00Z', 'https://ai',       'ai_generated',      0.2),
      ('legacy-1', '2025-06-15T00:00:00Z', 'https://wiki',     'reference_wiki',    0.5)`);
    await seed.unsafe(
      `INSERT INTO claim (id, entry_id, entry_created_at, statement, type, verdict, certainty, embedding)
       VALUES ('claim-1', 'legacy-1', '2025-06-15T00:00:00Z', 's', 'factual', 'not_applicable', 0, '${zeroVec}'::vector),
              ('claim-2', 'legacy-1', '2025-06-15T00:00:00Z', 's', 'factual', 'verified',       0.9, '${zeroVec}'::vector)`,
    );
    await seed.unsafe(
      `INSERT INTO verdict_log (id, claim_id, verdict, certainty, trigger)
       VALUES ('vl-1', 'claim-1', 'not_applicable', 0, 'auto')`,
    );
    await seed.unsafe(
      `INSERT INTO golden_set_claim (id, statement, claim_type, expected_verdict, labeled_by)
       VALUES ('g-1', 's', 'factual', 'not_applicable', 'tester')`,
    );
    await seed.unsafe(
      `INSERT INTO claim_relation (id, source_claim_id, target_claim_id, relation_type, created_by)
       VALUES ('cr-1', 'claim-1', 'claim-2', 'derives_from', 'auto'),
              ('cr-2', 'claim-2', 'claim-1', 'superseded_by', 'auto')`,
    );
    await seed.unsafe(`INSERT INTO claim_feedback
      (id, claim_id, reporter_agent_id, application_method, outcome,
       failure_dimension, failure_dimension_inferred, enrichment_status)
      VALUES
      ('cf-1','claim-1','agent','reasoned_over','failed','fully_false','scope_too_broad','finalized_inferred'),
      ('cf-2','claim-1','agent','applied','failed','time_expired','modality_too_strong','awaiting_pull'),
      ('cf-3','claim-1','agent','applied','failed','context_mismatch','partially_correct','expired_reporter_unavailable'),
      ('cf-4','claim-1','agent','applied','partial',NULL,NULL,'skipped_backpressure'),
      ('cf-5','claim-1','agent','applied','partial',NULL,NULL,'not_needed'),
      ('cf-6','claim-1','agent','applied','partial',NULL,NULL,'awaiting_reporter_push')`);
    await seed.unsafe(
      `INSERT INTO feedback_log (id, entry_id, entry_created_at, signal, agent_id) VALUES
       ('fl-1', 'legacy-1', '2025-06-15T00:00:00Z', 'positive', 'agent'),
       ('fl-2', 'legacy-1', '2025-06-15T00:00:00Z', 'negative', 'agent')`,
    );
    await seed.end();

    await runMigrate(name);

    const verify = postgres(dbUrl(name), { max: 1 });

    // Every snake → kebab UPDATE must have hit every legacy row.
    const sourceTypes = await verify<{ source_type: string }[]>`
      SELECT source_type FROM entry_source WHERE entry_id = 'legacy-1' ORDER BY url
    `;
    expect(sourceTypes.map(r => r.source_type).sort()).toEqual(
      [
        'official-docs',
        'github-release',
        'cve-db',
        'official-blog',
        'research-paper',
        'established-blog',
        'community-forum',
        'personal-blog',
        'ai-generated',
        'reference-wiki',
      ].sort(),
    );

    const verdicts = await verify<{ verdict: string }[]>`SELECT verdict FROM claim WHERE id = 'claim-1'`;
    expect(verdicts[0]!.verdict).toBe('not-applicable');

    const vlVerdicts = await verify<{ verdict: string }[]>`SELECT verdict FROM verdict_log WHERE id = 'vl-1'`;
    expect(vlVerdicts[0]!.verdict).toBe('not-applicable');

    const gsExpected = await verify<
      {
        expected_verdict: string;
      }[]
    >`SELECT expected_verdict FROM golden_set_claim WHERE id = 'g-1'`;
    expect(gsExpected[0]!.expected_verdict).toBe('not-applicable');

    const crTypes = await verify<{ relation_type: string }[]>`
      SELECT relation_type FROM claim_relation WHERE id IN ('cr-1','cr-2') ORDER BY id
    `;
    expect(crTypes.map(r => r.relation_type)).toEqual(['derives-from', 'superseded-by']);

    const cfRows = await verify<
      {
        application_method: string;
        failure_dimension: string | null;
        failure_dimension_inferred: string | null;
        enrichment_status: string;
      }[]
    >`
      SELECT application_method, failure_dimension, failure_dimension_inferred, enrichment_status
      FROM claim_feedback ORDER BY id
    `;
    expect(cfRows[0]!.application_method).toBe('reasoned-over');
    expect(cfRows[0]!.failure_dimension).toBe('fully-false');
    expect(cfRows[0]!.failure_dimension_inferred).toBe('scope-too-broad');
    expect(cfRows[0]!.enrichment_status).toBe('finalized-inferred');
    expect(cfRows[1]!.failure_dimension).toBe('time-expired');
    expect(cfRows[1]!.failure_dimension_inferred).toBe('modality-too-strong');
    expect(cfRows[1]!.enrichment_status).toBe('awaiting-pull');
    expect(cfRows[2]!.failure_dimension).toBe('context-mismatch');
    expect(cfRows[2]!.failure_dimension_inferred).toBe('partially-correct');
    expect(cfRows[2]!.enrichment_status).toBe('expired-reporter-unavailable');
    expect(cfRows[3]!.enrichment_status).toBe('skipped-backpressure');
    expect(cfRows[4]!.enrichment_status).toBe('not-needed');
    // `awaiting_reporter_push` collapses into `awaiting-pull` —
    // the push channel was retired entirely.
    expect(cfRows[5]!.enrichment_status).toBe('awaiting-pull');

    // Every *_values CHECK that 0001 VALIDATEs must end up enforced.
    const validated = await verify<{ conname: string; convalidated: boolean }[]>`
      SELECT conname, convalidated FROM pg_constraint
      WHERE conname LIKE '%\\_values' ESCAPE '\\' AND contype = 'c'
    `;
    const unvalidated = validated.filter(r => !r.convalidated).map(r => r.conname);
    expect(unvalidated).toEqual([]);
    expect(validated.length).toBeGreaterThan(0);

    // Future INSERT with snake value must be rejected.
    let rejected = false;
    try {
      await verify.unsafe(
        `INSERT INTO entry_source (entry_id, entry_created_at, url, source_type, trust) VALUES
         ('legacy-1', '2025-06-15T00:00:00Z', 'https://c', 'official_docs', 0.5)`,
      );
    } catch {
      rejected = true;
    }
    await verify.end();
    expect(rejected).toBe(true);
  });
});
