// TDD regressions for the six known defects found by the full-package
// review (all were live in production paths untouched by earlier tests):
//   D1 explore pagination — cursor encoded the ranked FINAL score but the
//      SQL keyset compared raw authority/epoch → page 2 empty (created_at)
//      or dup/skip (authority); presentation order also contradicted sortBy.
//   D2 query pagination — cursor applied only in memory over a fixed
//      limit×3 pool → depth capped, phantom nextCursor at pool edge.
//   D3 graph CTEs — no visited guard: A↔B edges explode row counts
//      exponentially with hops and the root returns as its own neighbor.
//   D4 claim_feedback — no rate limit (entry feedback has one): one agent
//      could hammer a claim's authority in a loop.
//   D5 KG-prefix grounding contamination — verdict NLI premises were
//      prefixed with internal KG facts, so an irrelevant-but-fetchable
//      citation could verify a claim (violates strict grounding).
//   D6 worker livelock — entries whose extraction yields zero claims were
//      re-selected every tick forever (unbounded LLM spend).

import { describe, test, expect, afterAll, mock } from 'bun:test';

import { IngestAction, SortBy, Verdict } from '../../src/score/enums';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { startMockEmbeddingServer, startMockOllamaServer, stopMockServers } from '../helpers/mock-apis';

process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/knoldr_test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.KNOLDR_EMBEDDING_BASE_URL = 'http://localhost:19883';
process.env.KNOLDR_EMBEDDING_API_KEY = 'test-key';
process.env.OLLAMA_HOST = 'http://127.0.0.1:11493';
process.env.KNOLDR_OLLAMA_TIMEOUT_MS = '2000';
process.env.KNOLDR_OLLAMA_FAST_MODEL = 'mock';

// D5 needs to observe that verify NEVER consults the KG-expansion for
// source grounding; nli is mocked so no ONNX loads.
let expandCalls = 0;
void mock.module('../../src/kg/expand', () => ({
  expandWithKgFacts: async () => {
    expandCalls++;
    return 'KG_FACT_PREFIX: something the KG believes. ';
  },
}));
void mock.module('../../src/llm/nli', () => {
  const score = (premise: string) => {
    if (premise.includes('GROUND_ME')) {
      return { entailment: 0.93, neutral: 0.04, contradiction: 0.03 };
    }
    return { entailment: 0.15, neutral: 0.7, contradiction: 0.15 };
  };
  return {
    nliScore: async (premise: string) => score(premise),
    nliScoreLocal: async (premise: string) => score(premise),
  };
});

const dbAvailable = await (async () => {
  try {
    await setupTestDb();
    startMockEmbeddingServer(19883);
    startMockOllamaServer(11493);
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

async function seedEntry(opts: { title: string; content: string; authority: number; createdAt: Date }) {
  const { getDb } = await import('../../src/db/connection');
  const { entry } = await import('../../src/db/schema');
  const { ulid } = await import('ulid');
  const id = ulid();
  await getDb().insert(entry).values({
    id,
    title: opts.title,
    content: opts.content,
    language: 'en',
    authority: opts.authority,
    status: 'active',
    createdAt: opts.createdAt,
    embedding: EMB,
  });
  return id;
}

/** Walk pages until nextCursor runs out (bounded), returning all ids. */
async function walkExplore(sortBy: SortBy, limit: number): Promise<string[]> {
  const { explore } = await import('../../src/search/search');
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res = await explore({ sortBy, limit, cursor });
    seen.push(...res.entries.map(e => e.id));
    if (!res.nextCursor) {
      break;
    }
    cursor = res.nextCursor;
  }
  return seen;
}

describe('D1 — explore keyset pagination', () => {
  test.skipIf(!dbAvailable)('authority sort: every entry exactly once across pages', async () => {
    await cleanTestDb();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        await seedEntry({
          title: `explore auth ${i}`,
          content: `explore body ${i}`,
          authority: 0.2 + i * 0.15,
          createdAt: new Date(Date.now() - i * 60000),
        }),
      );
    }
    const seen = await walkExplore(SortBy.Authority, 2);
    expect(seen.length).toBe(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen.sort()).toEqual(ids.sort());
  });

  test.skipIf(!dbAvailable)('created_at sort: page 2 is NOT empty and completes the set', async () => {
    await cleanTestDb();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        await seedEntry({
          title: `explore time ${i}`,
          content: `explore time body ${i}`,
          authority: 0.5,
          createdAt: new Date(Date.now() - i * 3600_000),
        }),
      );
    }
    const seen = await walkExplore(SortBy.CreatedAt, 2);
    expect(seen.length).toBe(5);
    expect(new Set(seen).size).toBe(5);
  });

  test.skipIf(!dbAvailable)('presentation order follows the requested sortBy', async () => {
    await cleanTestDb();
    const low = await seedEntry({ title: 'low', content: 'order body', authority: 0.1, createdAt: new Date() });
    const high = await seedEntry({
      title: 'high',
      content: 'order body',
      authority: 0.9,
      createdAt: new Date(Date.now() - 86400_000),
    });
    const { explore } = await import('../../src/search/search');
    const res = await explore({ sortBy: SortBy.Authority, limit: 10 });
    expect(res.entries.map(e => e.id)).toEqual([high, low]);
  });
});

describe('D2 — query pagination depth', () => {
  test.skipIf(!dbAvailable)('rows beyond the first limit×3 pool are reachable via cursor', async () => {
    await cleanTestDb();
    // limit=2 → first pool is max(6,20)=20; seed 25 matching rows so the
    // tail is only reachable if the cursor deepens the fetch window.
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      ids.push(
        await seedEntry({
          title: `zebrafinch doc ${i}`,
          content: `zebrafinch corpus row number ${i}`,
          authority: 0.2 + (i % 10) * 0.05,
          createdAt: new Date(Date.now() - i * 60000),
        }),
      );
    }
    const { search } = await import('../../src/search/search');
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 30; page++) {
      const res = await search({ query: 'zebrafinch', limit: 2, cursor });
      res.entries.forEach(e => seen.add(e.id));
      if (!res.nextCursor) {
        break;
      }
      cursor = res.nextCursor;
    }
    expect(seen.size).toBe(25);
  });

  test.skipIf(!dbAvailable)('no phantom nextCursor once the matching set is exhausted', async () => {
    await cleanTestDb();
    for (let i = 0; i < 3; i++) {
      await seedEntry({
        title: `quokkabird doc ${i}`,
        content: `quokkabird row ${i}`,
        authority: 0.5,
        createdAt: new Date(Date.now() - i * 60000),
      });
    }
    const { search } = await import('../../src/search/search');
    const p1 = await search({ query: 'quokkabird', limit: 3 });
    expect(p1.entries.length).toBe(3);
    if (p1.nextCursor) {
      const p2 = await search({ query: 'quokkabird', limit: 3, cursor: p1.nextCursor });
      expect(p2.entries.length).toBe(0);
      expect(p2.nextCursor).toBeUndefined();
    }
  });
});

describe('D3 — graph walks terminate on cycles', () => {
  test.skipIf(!dbAvailable)('neighbors: mutual edges do not explode and root is not its own neighbor', async () => {
    await cleanTestDb();
    const { getDb } = await import('../../src/db/connection');
    const { entity, kgRelation } = await import('../../src/db/schema');
    const { ulid } = await import('ulid');
    const a = ulid();
    const b = ulid();
    await getDb()
      .insert(entity)
      .values([
        { id: a, name: 'cyclon-a', type: 'tech', embedding: EMB },
        { id: b, name: 'cyclon-b', type: 'tech', embedding: EMB },
      ]);
    await getDb()
      .insert(kgRelation)
      .values([
        { id: ulid(), sourceEntityId: a, targetEntityId: b, relationType: 'related_to', weight: 1 },
        { id: ulid(), sourceEntityId: b, targetEntityId: a, relationType: 'related_to', weight: 1 },
      ]);
    const { handleNeighbors } = await import('../../src/mcp/handlers/neighbors');
    const started = Date.now();
    const res = (await handleNeighbors({ entity: 'cyclon-a', hops: 4, limit: 20 })) as {
      ok: boolean;
      neighbors?: Array<{ id: string }>;
    };
    expect(Date.now() - started).toBeLessThan(3000);
    expect(res.ok).toBe(true);
    const ids = (res.neighbors ?? []).map(n => n.id);
    expect(ids).toContain(b);
    expect(ids).not.toContain(a);
  });

  test.skipIf(!dbAvailable)('provenance: derives-from cycle terminates with each ancestor once', async () => {
    await cleanTestDb();
    const { getDb } = await import('../../src/db/connection');
    const { entry, claim, claimRelation } = await import('../../src/db/schema');
    const { ulid } = await import('ulid');
    const entryId = ulid();
    const createdAt = new Date();
    await getDb().insert(entry).values({
      id: entryId,
      title: 'prov cycle',
      content: 'prov cycle body',
      language: 'en',
      authority: 0.5,
      status: 'active',
      createdAt,
      embedding: EMB,
    });
    const c1 = ulid();
    const c2 = ulid();
    await getDb()
      .insert(claim)
      .values(
        [c1, c2].map(id => ({
          id,
          entryId,
          entryCreatedAt: createdAt,
          statement: `prov claim ${id}`,
          type: 'factual',
          verdict: 'verified',
          certainty: 0.8,
          embedding: EMB,
        })),
      );
    await getDb()
      .insert(claimRelation)
      .values([
        { id: ulid(), sourceClaimId: c1, targetClaimId: c2, relationType: 'derives-from', weight: 1, createdBy: 'auto' },
        { id: ulid(), sourceClaimId: c2, targetClaimId: c1, relationType: 'derives-from', weight: 1, createdBy: 'auto' },
      ]);
    const { handleProvenance } = await import('../../src/mcp/handlers/provenance');
    const res = (await handleProvenance({ claimId: c1, maxDepth: 5 })) as {
      ok: boolean;
      ancestors?: Array<{ claimId: string }>;
    };
    expect(res.ok).toBe(true);
    const ids = (res.ancestors ?? []).map(x => x.claimId);
    expect(ids.filter(x => x === c2).length).toBe(1);
    expect(ids).not.toContain(c1);
  });
});

describe('D4 — claim_feedback rate limit', () => {
  test.skipIf(!dbAvailable)('same agent+claim limited to 1/hour; different agent passes', async () => {
    await cleanTestDb();
    const { getDb } = await import('../../src/db/connection');
    const { entry, claim } = await import('../../src/db/schema');
    const { ulid } = await import('ulid');
    const entryId = ulid();
    const createdAt = new Date();
    await getDb().insert(entry).values({
      id: entryId,
      title: 'rl claim entry',
      content: 'rl body',
      language: 'en',
      authority: 0.5,
      status: 'active',
      createdAt,
      embedding: EMB,
    });
    const claimId = ulid();
    await getDb().insert(claim).values({
      id: claimId,
      entryId,
      entryCreatedAt: createdAt,
      statement: 'rate limited claim',
      type: 'factual',
      verdict: 'verified',
      certainty: 0.8,
      embedding: EMB,
    });
    const { handleClaimFeedback } = await import('../../src/mcp/handlers/claim-feedback');
    const first = await handleClaimFeedback({ claimId, applicationMethod: 'applied', outcome: 'held' }, 'rl-agent');
    expect(first.ok).toBe(true);
    const second = await handleClaimFeedback({ claimId, applicationMethod: 'applied', outcome: 'held' }, 'rl-agent');
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toBe('rate_limited');
    }
    const other = await handleClaimFeedback({ claimId, applicationMethod: 'applied', outcome: 'held' }, 'rl-agent-2');
    expect(other.ok).toBe(true);
  });
});

describe('D5 — grounding premises are source-text only (no KG prefix)', () => {
  test.skipIf(!dbAvailable)(
    'verify never consults KG expansion for source grounding',
    async () => {
      await cleanTestDb();
      expandCalls = 0;
      // Local mock source the fetcher can actually read (SSRF guard removed).
      const srv = Bun.serve({
        port: 19884,
        fetch: () =>
          new Response(
            '<html><head><title>t</title></head><body><article>' +
              `<p>${'GROUND_ME the framework is written in Zig. '.repeat(20)}</p>` +
              '</article></body></html>',
            { headers: { 'Content-Type': 'text/html' } },
          ),
      });
      try {
        const { getDb } = await import('../../src/db/connection');
        const { entry, claim, entrySource } = await import('../../src/db/schema');
        const { ulid } = await import('ulid');
        const entryId = ulid();
        const createdAt = new Date();
        await getDb().insert(entry).values({
          id: entryId,
          title: 'ground entry',
          content: 'ground body',
          language: 'en',
          authority: 0.5,
          status: 'active',
          createdAt,
          embedding: EMB,
        });
        await getDb().insert(entrySource).values({
          entryId,
          entryCreatedAt: createdAt,
          url: 'http://127.0.0.1:19884/doc',
          sourceType: 'unknown',
          trust: 0.5,
        });
        const claimId = ulid();
        await getDb().insert(claim).values({
          id: claimId,
          entryId,
          entryCreatedAt: createdAt,
          statement: 'GROUND_ME the framework is written in Zig.',
          type: 'factual',
          verdict: 'unverified',
          certainty: 0,
          embedding: EMB,
        });
        const { verifyClaim } = await import('../../src/claim/verify');
        const result = await verifyClaim(claimId);
        expect(result).not.toBeNull();
        expect(result!.verdict).toBe(Verdict.Verified);
        // The strict-grounding contract: verdict evidence comes from the
        // fetched source text alone — the KG expansion must not be called.
        expect(expandCalls).toBe(0);
      } finally {
        await srv.stop(true);
      }
    },
    20000,
  );
});

describe('D6 — empty-extraction entries are not re-selected forever', () => {
  test.skipIf(!dbAvailable)(
    'second tick skips the entry that produced zero claims',
    async () => {
      await cleanTestDb();
      // The mock Ollama's default reply is not claim-shaped, so extraction
      // parses to zero claims — exactly the livelock case.
      const { ingest } = await import('../../src/ingest/engine');
      const { parseStoreInput } = await import('../../src/ingest/validate');
      const stored = await ingest(
        parseStoreInput({
          entries: [{ title: 'livelock entry', content: 'livelock body content for extraction.', domain: ['testing'] }],
        }),
      );
      expect(stored[0]!.action).toBe(IngestAction.Stored);

      const { processClaimExtractionQueue } = await import('../../src/claim/extract-queue');
      const first = await processClaimExtractionQueue(3);
      expect(first).toBeGreaterThanOrEqual(1);
      const second = await processClaimExtractionQueue(3);
      expect(second).toBe(0);
    },
    20000,
  );
});
