// No-search restructure contract tests (docs/no-search-restructure-plan.md):
//   - sourceless claims finalize single-pass as Unverified with the new
//     `no-cited-sources` evidence source (never retried);
//   - cross-ref edges are NLI-CLASSIFIED (mocked local NLI here): an
//     entailed neighbor → SUPPORTS (weight = entailment, written
//     neighbor→claim), a contradicted neighbor → CONTRADICTS (weight =
//     contradiction, written claim→neighbor), an NLI-neutral but
//     topically-similar neighbor → NO edge, and the verdict is never
//     touched by neighbors (no Disputed contagion);
//   - factBundle surfaces SUPPORTS incoming-only (target's bundle lists
//     the supporter; the supporter's own bundle does not invert it);
//   - writeClaimEdges honors direction + per-target weights.

import { describe, test, expect, afterAll, mock } from 'bun:test';

import { EvidenceSource, Verdict } from '../../src/score/enums';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { startMockEmbeddingServer, startMockOllamaServer, stopMockServers } from '../helpers/mock-apis';

process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/knoldr_test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.KNOLDR_EMBEDDING_BASE_URL = 'http://localhost:19878';
process.env.KNOLDR_EMBEDDING_API_KEY = 'test-key';
process.env.OLLAMA_HOST = 'http://127.0.0.1:11497';
process.env.KNOLDR_OLLAMA_TIMEOUT_MS = '2000';
process.env.KNOLDR_OLLAMA_FAST_MODEL = 'mock';

// Mock the NLI module BEFORE claim/verify is imported: edge classification
// must never load ONNX models (or call Ollama) in tests. Statement markers
// steer the canned scores. `nliScore` (the translate-fallback-capable
// variant) THROWS: edge classification is contractually LOCAL-ONLY, so a
// regression that routes edges through nliScore fails loudly here.
void mock.module('../../src/llm/nli', () => {
  const score = (premise: string) => {
    if (premise.includes('SUPPORT_ME')) {
      return { entailment: 0.92, neutral: 0.05, contradiction: 0.03 };
    }
    if (premise.includes('CONTRA_ME')) {
      return { entailment: 0.03, neutral: 0.05, contradiction: 0.91 };
    }
    return { entailment: 0.2, neutral: 0.6, contradiction: 0.2 };
  };
  return {
    nliScore: async () => {
      throw new Error('nliScore must not be called for edge classification (local-only contract)');
    },
    nliScoreLocal: async (premise: string) => score(premise),
  };
});

// Mock the KG contradiction check: statements containing KG_CONFLICT get a
// canned functional conflict pointing at test-settable claim ids.
let kgConflictClaimIds: string[] = [];
void mock.module('../../src/kg/contradiction', () => ({
  checkKgContradiction: async (statement: string) => {
    if (!statement.includes('KG_CONFLICT') || kgConflictClaimIds.length === 0) {
      return null;
    }
    return {
      newTriple: { subject: 'test-subject', subjectType: 'tech', predicate: 'runs_on', object: 'A', objectType: 'tech' },
      confidence: 0.85,
      conflictingObjects: [{ objectName: 'B', objectType: 'tech', supportingClaims: 1, claimIds: kgConflictClaimIds }],
    };
  },
}));

const dbAvailable = await (async () => {
  try {
    await setupTestDb();
    startMockEmbeddingServer(19878);
    startMockOllamaServer(11497);
    return true;
  } catch (err) {
    console.warn('⚠ Test DB unavailable:', (err as Error).message);
    return false;
  }
})();

afterAll(async () => {
  stopMockServers();
  if (dbAvailable) {
    await cleanTestDb();
    await teardownTestDb();
  }
});

const EMB = Array.from({ length: 384 }, () => 0.01);

async function seedEntryWithClaim(statement: string, opts: { verdict?: string; sourceUrl?: string } = {}) {
  const { getDb } = await import('../../src/db/connection');
  const { entry, claim, entrySource } = await import('../../src/db/schema');
  const { ulid } = await import('ulid');
  const entryId = ulid();
  const createdAt = new Date();
  const claimId = ulid();
  await getDb().transaction(async tx => {
    await tx.insert(entry).values({
      id: entryId,
      title: statement.slice(0, 100),
      content: statement,
      language: 'en',
      authority: 0.5,
      status: 'active',
      createdAt,
      embedding: EMB,
    });
    await tx.insert(claim).values({
      id: claimId,
      entryId,
      entryCreatedAt: createdAt,
      statement,
      type: 'factual',
      verdict: opts.verdict ?? 'unverified',
      certainty: 0,
      embedding: EMB,
    });
    if (opts.sourceUrl) {
      await tx.insert(entrySource).values({
        entryId,
        entryCreatedAt: createdAt,
        url: opts.sourceUrl,
        sourceType: 'unknown',
        trust: 0.5,
      });
    }
  });
  return { entryId, createdAt, claimId };
}

describe('restructure — sourceless single-pass finalize', () => {
  test.skipIf(!dbAvailable)('no cited sources → Unverified with no-cited-sources, never null', async () => {
    await cleanTestDb();
    const { claimId } = await seedEntryWithClaim('Sourceless factual claim about nothing in particular.');
    const { verifyClaim } = await import('../../src/claim/verify');
    const result = await verifyClaim(claimId);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe(Verdict.Unverified);
    expect(result!.certainty).toBe(0);
    expect(result!.evidence.source).toBe(EvidenceSource.NoCitedSources);
  });

  test.skipIf(!dbAvailable)('committer records no-cited-sources in claim + verdict_log and drops the queue row', async () => {
    await cleanTestDb();
    const { claimId } = await seedEntryWithClaim('Another sourceless claim, committed via the queue.');
    const { getDb } = await import('../../src/db/connection');
    const { sql } = await import('drizzle-orm');
    await getDb().execute(sql`
      INSERT INTO verify_queue (claim_id, priority, attempts, next_attempt_at, queued_at)
      VALUES (${claimId}, 50, 0, NOW(), NOW())
    `);
    const { processVerifyQueue } = await import('../../src/claim/verify');
    const processed = await processVerifyQueue(1);
    expect(processed).toBe(1);

    const rows = (await getDb().execute(sql`
      SELECT c.verdict, c.evidence->>'source' AS evidence_source,
             (SELECT evidence_source FROM verdict_log WHERE claim_id = ${claimId} ORDER BY created_at DESC LIMIT 1) AS logged,
             (SELECT count(*)::int FROM verify_queue WHERE claim_id = ${claimId}) AS queued
      FROM claim c WHERE c.id = ${claimId}
    `)) as unknown as Array<{ verdict: string; evidence_source: string; logged: string; queued: number }>;
    expect(rows[0]!.verdict).toBe('unverified');
    expect(rows[0]!.evidence_source).toBe('no-cited-sources');
    expect(rows[0]!.logged).toBe('no-cited-sources');
    expect(rows[0]!.queued).toBe(0);
  });
});

describe('restructure — NLI-classified edges, weights, directions, no contagion', () => {
  test.skipIf(!dbAvailable)(
    'entailed→SUPPORTS(neighbor→claim), contradicted→CONTRADICTS(claim→neighbor), neutral→none; verdict untouched',
    async () => {
      await cleanTestDb();
      // Decided neighbors sharing the pivot's embedding (cosine 1 ≥ 0.8).
      const supporter = await seedEntryWithClaim('SUPPORT_ME: the framework is written in Zig.', { verdict: 'verified' });
      const contra = await seedEntryWithClaim('CONTRA_ME: the framework is written in Rust.', { verdict: 'disputed' });
      await seedEntryWithClaim('Topically similar but unrelated neighbor statement.', { verdict: 'disputed' });
      const pivot = await seedEntryWithClaim('The framework is written in Zig, says the pivot.');

      const { getDb } = await import('../../src/db/connection');
      const { sql } = await import('drizzle-orm');
      await getDb().execute(sql`
      INSERT INTO verify_queue (claim_id, priority, attempts, next_attempt_at, queued_at)
      VALUES (${pivot.claimId}, 50, 0, NOW(), NOW())
    `);
      const { processVerifyQueue } = await import('../../src/claim/verify');
      expect(await processVerifyQueue(1)).toBe(1);

      // Verdict: sourceless finalize — a Disputed embedding-neighbor must NOT
      // demote or otherwise change it (no contagion; edges only).
      const claimRow = (await getDb().execute(sql`
      SELECT verdict, evidence->>'source' AS src FROM claim WHERE id = ${pivot.claimId}
    `)) as unknown as Array<{ verdict: string; src: string }>;
      expect(claimRow[0]!.verdict).toBe('unverified');
      expect(claimRow[0]!.src).toBe('no-cited-sources');

      const edges = (await getDb().execute(sql`
      SELECT source_claim_id, target_claim_id, relation_type, weight
      FROM claim_relation ORDER BY relation_type
    `)) as unknown as Array<{ source_claim_id: string; target_claim_id: string; relation_type: string; weight: number }>;

      // Exactly two edges: neutral neighbor produced none.
      expect(edges).toHaveLength(2);
      const contraEdge = edges.find(e => e.relation_type === 'contradicts')!;
      const supEdge = edges.find(e => e.relation_type === 'supports')!;
      // CONTRADICTS: claim → neighbor, weight = classifying contradiction prob.
      expect(contraEdge.source_claim_id).toBe(pivot.claimId);
      expect(contraEdge.target_claim_id).toBe(contra.claimId);
      expect(contraEdge.weight).toBeCloseTo(0.91, 5);
      // SUPPORTS: neighbor → claim, weight = classifying entailment prob.
      expect(supEdge.source_claim_id).toBe(supporter.claimId);
      expect(supEdge.target_claim_id).toBe(pivot.claimId);
      expect(supEdge.weight).toBeCloseTo(0.92, 5);
    },
  );

  test.skipIf(!dbAvailable)('factBundle surfaces SUPPORTS incoming-only', async () => {
    // Depends on the edges written by the previous test? No — reseed.
    await cleanTestDb();
    const supporter = await seedEntryWithClaim('SUPPORT_ME neighbor for bundle test.', { verdict: 'verified' });
    const pivot = await seedEntryWithClaim('Pivot claim for bundle test.', { verdict: 'verified' });
    const { writeClaimEdges } = await import('../../src/claim/relation-writer');
    const written = await writeClaimEdges(pivot.claimId, [{ id: supporter.claimId, weight: 0.88 }], 'supports', {
      direction: 'incoming',
      createdBy: 'auto',
    });
    expect(written).toBe(1);

    const { fetchFactBundlesForEntries } = await import('../../src/claim/query');
    const bundles = await fetchFactBundlesForEntries(
      [
        { id: pivot.entryId, createdAt: pivot.createdAt.toISOString() },
        { id: supporter.entryId, createdAt: supporter.createdAt.toISOString() },
      ],
      { maxPerEntry: 5 },
    );
    const pivotBundle = bundles.find(b => b.id === pivot.claimId);
    const supporterBundle = bundles.find(b => b.id === supporter.claimId);
    // Target claim's bundle lists its supporter…
    expect(pivotBundle?.supports.map(s => s.claimId)).toEqual([supporter.claimId]);
    // …and the supporter's own bundle does NOT invert the edge.
    expect(supporterBundle?.supports ?? []).toHaveLength(0);
  });

  test.skipIf(!dbAvailable)('writeClaimEdges: per-target weights + outgoing default', async () => {
    await cleanTestDb();
    const a = await seedEntryWithClaim('Edge writer target A.');
    const b = await seedEntryWithClaim('Edge writer target B.');
    const pivot = await seedEntryWithClaim('Edge writer pivot.');
    const { writeClaimEdges } = await import('../../src/claim/relation-writer');
    const n = await writeClaimEdges(
      pivot.claimId,
      [
        { id: a.claimId, weight: 0.3 },
        { id: b.claimId, weight: 0.7 },
      ],
      'contradicts',
    );
    expect(n).toBe(2);
    const { getDb } = await import('../../src/db/connection');
    const { sql } = await import('drizzle-orm');
    const rows = (await getDb().execute(sql`
      SELECT target_claim_id, weight FROM claim_relation WHERE source_claim_id = ${pivot.claimId} ORDER BY weight
    `)) as unknown as Array<{ target_claim_id: string; weight: number }>;
    expect(rows.map(r => [r.target_claim_id, r.weight])).toEqual([
      [a.claimId, 0.3],
      [b.claimId, 0.7],
    ]);
  });
});

describe('restructure — audit regressions', () => {
  test.skipIf(!dbAvailable)('reciprocal SUPPORTS edges: both bundles keep their supporter', async () => {
    await cleanTestDb();
    const a = await seedEntryWithClaim('Reciprocal supports claim A.', { verdict: 'verified' });
    const b = await seedEntryWithClaim('Reciprocal supports claim B.', { verdict: 'verified' });
    const { writeClaimEdges } = await import('../../src/claim/relation-writer');
    // A→B and B→A both exist (reachable via outdated-requeue re-verification).
    expect(await writeClaimEdges(b.claimId, [{ id: a.claimId, weight: 0.8 }], 'supports', { direction: 'incoming' })).toBe(1);
    expect(await writeClaimEdges(a.claimId, [{ id: b.claimId, weight: 0.7 }], 'supports', { direction: 'incoming' })).toBe(1);

    const { fetchFactBundlesForEntries } = await import('../../src/claim/query');
    const bundles = await fetchFactBundlesForEntries(
      [
        { id: a.entryId, createdAt: a.createdAt.toISOString() },
        { id: b.entryId, createdAt: b.createdAt.toISOString() },
      ],
      { maxPerEntry: 5 },
    );
    const bundleA = bundles.find(x => x.id === a.claimId);
    const bundleB = bundles.find(x => x.id === b.claimId);
    // Pre-fix, the pivot's own outgoing row consumed the direction-blind
    // dedupe key and shadowed the genuine incoming supporter.
    expect(bundleA?.supports.map(l => l.claimId)).toEqual([b.claimId]);
    expect(bundleB?.supports.map(l => l.claimId)).toEqual([a.claimId]);
  });

  test.skipIf(!dbAvailable)(
    'KG conflict: Disputed verdict, KG-scored edge, and NO cross-ref SUPPORTS for the same neighbor',
    async () => {
      await cleanTestDb();
      // Neighbor that the KG marks conflicting AND pairwise NLI would entail.
      const neighbor = await seedEntryWithClaim('SUPPORT_ME neighbor that KG contradicts.', { verdict: 'verified' });
      kgConflictClaimIds = [neighbor.claimId];
      try {
        const pivot = await seedEntryWithClaim('KG_CONFLICT pivot claim.');
        const { verifyClaim } = await import('../../src/claim/verify');
        const result = await verifyClaim(pivot.claimId);
        expect(result).not.toBeNull();
        expect(result!.verdict).toBe(Verdict.Disputed);
        expect(result!.certainty).toBeCloseTo(0.85, 5);
        // KG-wins across lists: the neighbor appears ONLY as contradicting
        // (with the KG confidence), never also as corroborating.
        expect(result!.evidence.contradicting?.map(t => [t.id, t.score])).toEqual([[neighbor.claimId, 0.85]]);
        expect((result!.evidence.corroborating ?? []).map(t => t.id)).not.toContain(neighbor.claimId);
      } finally {
        kgConflictClaimIds = [];
      }
    },
  );

  test.skipIf(!dbAvailable)(
    'ExhaustedPipeline finalize commits WITHOUT cross-ref edges',
    async () => {
      await cleanTestDb();
      // Decided neighbor that WOULD classify as a supporter…
      await seedEntryWithClaim('SUPPORT_ME neighbor for the exhausted case.', { verdict: 'verified' });
      // …but the pivot has a cited source that cannot be fetched (SSRF guard
      // blocks loopback), so every attempt returns null; at attempts=2 the
      // committer finalizes ExhaustedPipeline — with no edge writes.
      const pivot = await seedEntryWithClaim('Cited but unfetchable pivot claim.', { sourceUrl: 'http://127.0.0.1:9/x' });
      const { getDb } = await import('../../src/db/connection');
      const { sql } = await import('drizzle-orm');
      await getDb().execute(sql`
      INSERT INTO verify_queue (claim_id, priority, attempts, next_attempt_at, queued_at)
      VALUES (${pivot.claimId}, 50, 2, NOW(), NOW())
    `);
      const { processVerifyQueue } = await import('../../src/claim/verify');
      expect(await processVerifyQueue(1)).toBe(1);

      const rows = (await getDb().execute(sql`
      SELECT c.verdict, c.evidence->>'source' AS src,
             (SELECT count(*)::int FROM claim_relation) AS edges
      FROM claim c WHERE c.id = ${pivot.claimId}
    `)) as unknown as Array<{ verdict: string; src: string; edges: number }>;
      expect(rows[0]!.verdict).toBe(Verdict.Unverified);
      expect(rows[0]!.src).toBe(EvidenceSource.ExhaustedPipeline);
      expect(rows[0]!.edges).toBe(0);
    },
    20000,
  );
});
