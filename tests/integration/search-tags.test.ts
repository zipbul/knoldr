// P0 regression: the tag filter used `ANY(${tags})`, which drizzle's
// tagged template expands into a positional TUPLE — `ANY(($1,$2))` —
// which Postgres rejects at runtime. Every find/query/explore call
// that included tags returned "Internal error". The fix binds a real
// text[] array (same pattern as src/kg/expand.ts).

import { describe, test, expect, afterAll } from 'bun:test';

import { IngestAction, SortBy } from '../../src/score/enums';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { startMockEmbeddingServer, startMockOllamaServer, stopMockServers } from '../helpers/mock-apis';

process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/knoldr_test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.KNOLDR_EMBEDDING_BASE_URL = 'http://localhost:19881';
process.env.KNOLDR_EMBEDDING_API_KEY = 'test-key';
process.env.OLLAMA_HOST = 'http://127.0.0.1:11491';
process.env.KNOLDR_OLLAMA_TIMEOUT_MS = '2000';
process.env.KNOLDR_OLLAMA_FAST_MODEL = 'mock';

const dbAvailable = await (async () => {
  try {
    await setupTestDb();
    startMockEmbeddingServer(19881);
    startMockOllamaServer(11491);
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

async function seedTaggedEntry(title: string, content: string, tags: string[]) {
  const { ingest } = await import('../../src/ingest/engine');
  const { parseStoreInput } = await import('../../src/ingest/validate');
  const results = await ingest(
    parseStoreInput({
      entries: [{ title, content, domain: ['testing'], tags, language: 'en' }],
    }),
  );
  expect(results[0]!.action).toBe(IngestAction.Stored);
  return results[0]!.entryId!;
}

describe('search — tag filter binds a real text[] array', () => {
  test.skipIf(!dbAvailable)('query search with tags returns the tagged entry (no SQL error)', async () => {
    await cleanTestDb();
    const id = await seedTaggedEntry('Tagged pgbouncer entry', 'pgbouncer is a lightweight connection pooler for PostgreSQL.', [
      'pooling',
      'postgres',
    ]);
    await seedTaggedEntry('Untagged decoy entry', 'pgbouncer decoy without the wanted tag.', ['other']);

    const { search } = await import('../../src/search/search');
    const result = await search({ query: 'pgbouncer', tags: ['pooling'], limit: 10 });
    expect(result.entries.map(e => e.id)).toContain(id);
    expect(result.entries).toHaveLength(1);
  });

  test.skipIf(!dbAvailable)('explore with tags returns only matching entries (no SQL error)', async () => {
    await cleanTestDb();
    const id = await seedTaggedEntry('Explore tagged entry', 'Content about HNSW graphs for explore mode.', ['graphs']);
    await seedTaggedEntry('Explore decoy entry', 'Different content about B-trees.', ['trees']);

    const { explore } = await import('../../src/search/search');
    const result = await explore({ tags: ['graphs'], sortBy: SortBy.Authority, limit: 10 });
    expect(result.entries.map(e => e.id)).toEqual([id]);
  });

  test.skipIf(!dbAvailable)('multiple tags act as OR within the filter', async () => {
    await cleanTestDb();
    const a = await seedTaggedEntry('Multi A', 'Shared topic text for multi-tag test alpha.', ['alpha']);
    const b = await seedTaggedEntry('Multi B', 'Shared topic text for multi-tag test beta.', ['beta']);
    await seedTaggedEntry('Multi C', 'Shared topic text for multi-tag test gamma.', ['gamma']);

    const { explore } = await import('../../src/search/search');
    const result = await explore({ tags: ['alpha', 'beta'], sortBy: SortBy.Authority, limit: 10 });
    expect(result.entries.map(e => e.id).sort()).toEqual([a, b].sort());
  });
});
