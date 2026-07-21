import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';

import { IngestAction, SourceType } from '../../src/score/enums';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { startMockEmbeddingServer, startMockOllamaServer, stopMockServers } from '../helpers/mock-apis';

process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/knoldr_test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.KNOLDR_EMBEDDING_BASE_URL = 'http://localhost:19876';
process.env.KNOLDR_EMBEDDING_API_KEY = 'test-key';
process.env.OLLAMA_HOST = 'http://127.0.0.1:11499';
process.env.KNOLDR_OLLAMA_TIMEOUT_MS = '2000';
process.env.KNOLDR_OLLAMA_FAST_MODEL = 'mock';
process.env.KNOLDR_OLLAMA_JURY_MODELS = 'mock';
process.env.KNOLDR_PORT = '19960';
process.env.KNOLDR_HOST = '127.0.0.1';
process.env.KNOLDR_API_TOKEN = 'test-token';

let server: ReturnType<typeof Bun.serve> | null = null;

// Probe the DB once at module load (mirrors the unit/integration pattern).
// test.skipIf evaluates at registration time, so the flag must be known
// before tests register.
const dbAvailable = await (async () => {
  try {
    await setupTestDb();
    startMockEmbeddingServer(19876);
    startMockOllamaServer(11499);
    const { startMcpServer } = await import('../../src/mcp/server');
    server = startMcpServer();
    return true;
  } catch (err) {
    console.warn('⚠ Test DB unavailable:', (err as Error).message);
    return false;
  }
})();

const BASE_URL = 'http://localhost:19960';
const MCP_URL = `${BASE_URL}/mcp`;

let client: Client | null = null;

beforeAll(async () => {
  if (!dbAvailable) {
    return;
  }
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: 'Bearer test-token' } },
  });
  const c = new Client({ name: 'knoldr-test-client', version: '0.0.0' });
  await c.connect(transport);
  client = c;
});

afterEach(async () => {
  if (dbAvailable) {
    await cleanTestDb();
  }
});

afterAll(async () => {
  await client?.close();
  await server?.stop(true);
  stopMockServers();
  if (dbAvailable) {
    await teardownTestDb();
  }
});

async function seed(
  entries: Array<{ title: string; content: string; domain: string[]; tags?: string[]; language?: string }>,
  sources?: Array<{ url: string; sourceType: string }>,
) {
  const { ingest } = await import('../../src/ingest/engine');
  const { parseStoreInput } = await import('../../src/ingest/validate');
  return ingest(parseStoreInput(sources ? { entries, sources } : { entries }));
}

// ============================================================
// Tool surface
// ============================================================
describe('MCP — tool surface', () => {
  test.skipIf(!dbAvailable)('advertises exactly the 7 knoldr tools with schemas', async () => {
    const { tools } = await client!.listTools();
    const names = tools.map(t => t.name).sort();
    expect(names).toEqual(['claim_feedback', 'contradictions', 'feedback', 'find', 'ingest', 'neighbors', 'provenance']);
    for (const t of tools) {
      expect(t.description).toBeTruthy();
      expect(t.inputSchema).toBeDefined();
    }
  });
});

// ============================================================
// Health (unauthenticated route)
// ============================================================
describe('MCP — health', () => {
  test.skipIf(!dbAvailable)('GET /health reports db up', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    expect(res.status).toBe(200);
    const health = (await res.json()) as { db: string };
    expect(health.db).toBe('up');
  });
});

// ============================================================
// Auth — /mcp requires a bearer token
// ============================================================
describe('MCP — auth', () => {
  test.skipIf(!dbAvailable)('rejects /mcp without bearer token (401 + WWW-Authenticate)', async () => {
    const res = await fetch(MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
  });
});

// ============================================================
// find — search + factBundle surface
// ============================================================
describe('MCP — find', () => {
  test.skipIf(!dbAvailable)('returns stored entries via structuredContent', async () => {
    const seeded = await seed([
      {
        title: 'pgvector HNSW index tuning notes',
        content: 'pgvector supports HNSW indexes. Tune ef_construction and m.',
        domain: ['pgvector'],
        tags: ['hnsw'],
        language: 'en',
      },
      {
        title: 'pgvector approximate nearest neighbor',
        content: 'Approximate nearest neighbor via HNSW in pgvector improves latency.',
        domain: ['pgvector'],
        tags: ['ann'],
        language: 'en',
      },
      {
        title: 'pgvector ivfflat background',
        content: 'ivfflat is the other pgvector index family; HNSW usually wins for recall.',
        domain: ['pgvector'],
        tags: ['ivfflat'],
        language: 'en',
      },
    ]);
    expect(seeded.filter(r => r.action === IngestAction.Stored).length).toBeGreaterThanOrEqual(3);

    const res = await client!.callTool({ name: 'find', arguments: { query: 'pgvector HNSW', limit: 5 } });
    const data = res.structuredContent as Record<string, unknown>;
    expect(Array.isArray(data.entries)).toBe(true);
    expect((data.entries as unknown[]).length).toBeGreaterThan(0);
    // Restructure contract: find is stored-data only — the researched /
    // research fields were REMOVED from the response shape entirely.
    expect('researched' in data).toBe(false);
    expect('research' in data).toBe(false);
  });
});

// ============================================================
// feedback — authority adjustment
// ============================================================
describe('MCP — feedback', () => {
  test.skipIf(!dbAvailable)('positive feedback raises authority', async () => {
    const seeded = await seed(
      [
        {
          title: 'Feedback test entry',
          content: 'Entry used to exercise the feedback tool end to end via MCP.',
          domain: ['testing'],
          language: 'en',
        },
      ],
      // High-authority source so a single positive boost clears the 0.8 bar.
      [{ url: 'https://docs.example.com', sourceType: SourceType.OfficialDocs }],
    );
    const entryId = seeded[0]!.entryId;
    expect(entryId).toBeTruthy();

    const res = await client!.callTool({ name: 'feedback', arguments: { entryId, signal: 'positive' } });
    const data = res.structuredContent as { ok?: boolean; newAuthority?: number };
    expect(data.ok).toBe(true);
    expect(data.newAuthority ?? 0).toBeGreaterThan(0.8);
  });

  test.skipIf(!dbAvailable)('rate-limits the same agent on the same entry', async () => {
    const seeded = await seed([
      {
        title: 'Rate-limit fixture entry',
        content: 'Another unique content body for a fresh embedding.',
        domain: ['testing'],
        language: 'en',
      },
    ]);
    const entryId = seeded[0]!.entryId;

    const first = await client!.callTool({
      name: 'feedback',
      arguments: { entryId, signal: 'positive' },
    });
    expect((first.structuredContent as { ok?: boolean }).ok).toBe(true);

    const second = await client!.callTool({
      name: 'feedback',
      arguments: { entryId, signal: 'negative' },
    });
    const data = second.structuredContent as { ok?: boolean; error?: string };
    expect(data.ok).toBe(false);
    expect(data.error).toBe('rate_limited');
  });

  test.skipIf(!dbAvailable)('structurally-invalid input is surfaced as an error', async () => {
    // Missing entryId/agentId + bogus signal fails the published input
    // schema, so the SDK rejects it (protocol-level), not the handler.
    let errored = false;
    try {
      const r = await client!.callTool({ name: 'feedback', arguments: { signal: 'maybe' } });
      errored = r.isError === true;
    } catch {
      errored = true;
    }
    expect(errored).toBe(true);
  });
});

// ============================================================
// Unknown tool — protocol-level rejection
// ============================================================
describe('MCP — unknown tool', () => {
  test.skipIf(!dbAvailable)('rejects an unknown tool name', async () => {
    let errored = false;
    try {
      const r = await client!.callTool({ name: 'does-not-exist', arguments: {} });
      errored = r.isError === true;
    } catch {
      errored = true;
    }
    expect(errored).toBe(true);
  });
});
