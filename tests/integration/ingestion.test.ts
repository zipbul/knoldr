import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { setupTestDb, cleanTestDb, teardownTestDb, getTestDb, getTestClient } from "../helpers/db";
import {
  startMockEmbeddingServer,
  stopMockServers,
  MOCK_CODEX_CLI,
  setCodexHandler,
  fakeEmbedding,
} from "../helpers/mock-apis";

// Set env vars before importing app modules
process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/knoldr_test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.KNOLDR_EMBEDDING_BASE_URL = "http://localhost:19876";
process.env.KNOLDR_EMBEDDING_API_KEY = "test-key";
// Cloud-CLI path is opt-in at runtime now. Enable it for this test
// so the mock Codex binary actually gets invoked. Also block the
// Ollama primary path so mock Codex is the only route — without
// this, a live Ollama on the host runs the real pipeline instead.
process.env.KNOLDR_ENABLE_CLOUD_CLI = "1";
process.env.KNOLDR_CODEX_CLI = MOCK_CODEX_CLI;
process.env.KNOLDR_CLOUD_CODEX_MODEL = "mock";
process.env.OLLAMA_HOST = "http://127.0.0.1:1";
process.env.KNOLDR_OLLAMA_TIMEOUT_MS = "200";

// Dynamic imports to pick up env vars
let ingest: typeof import("../../src/ingest/engine").ingest;
let parseStoreInput: typeof import("../../src/ingest/validate").parseStoreInput;

let dbAvailable = false;

beforeAll(async () => {
  try {
    await setupTestDb();
    dbAvailable = true;
  } catch (err) {
    console.warn("⚠ Test DB unavailable, skipping integration tests:", (err as Error).message);
    return;
  }

  startMockEmbeddingServer(19876);

  const engineMod = await import("../../src/ingest/engine");
  const validateMod = await import("../../src/ingest/validate");
  ingest = engineMod.ingest;
  parseStoreInput = validateMod.parseStoreInput;
});

afterEach(async () => {
  if (dbAvailable) await cleanTestDb();
  setCodexHandler(null);
});

afterAll(async () => {
  stopMockServers();
  if (dbAvailable) await teardownTestDb();
});

describe("Ingestion Engine — Mode 1 (raw)", () => {
  test("decomposes raw text and stores entry", async () => {
    if (!dbAvailable) return;

    const input = parseStoreInput({ raw: "Bun is a fast JavaScript runtime." });
    const results = await ingest(input);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.action).toBe("stored");
    expect(results[0]!.entryId).toBeTruthy();
    expect(results[0]!.authority).toBe(0.1); // no sources
  });

  test("stores with sources → higher authority", async () => {
    if (!dbAvailable) return;

    const input = parseStoreInput({
      raw: "React 19 released",
      sources: [{ url: "https://react.dev/blog", sourceType: "official_blog" }],
    });
    const results = await ingest(input);

    expect(results[0]!.action).toBe("stored");
    expect(results[0]!.authority).toBe(0.8); // official_blog
  });

  test("handles LLM returning multiple entries", async () => {
    if (!dbAvailable) return;

    setCodexHandler("multi");

    const input = parseStoreInput({ raw: "Multi-topic article" });
    const results = await ingest(input);

    expect(results.length).toBe(2);
    expect(results[0]!.action).toBe("stored");
    expect(results[1]!.action).toBe("stored");
  });

  test("logs rejected when LLM fails", async () => {
    if (!dbAvailable) return;

    setCodexHandler("fail");

    const input = parseStoreInput({ raw: "Bad input that LLM can't handle" });
    const results = await ingest(input);

    expect(results.length).toBe(1);
    expect(results[0]!.action).toBe("rejected");
  });
});

describe("Ingestion Engine — Mode 2 (structured)", () => {
  test("stores pre-structured entry (skips decompose)", async () => {
    if (!dbAvailable) return;

    const input = parseStoreInput({
      entries: [
        {
          title: "Direct Entry",
          content: "Pre-structured content that bypasses LLM.",
          domain: ["testing"],
          tags: ["structured"],
          language: "en",
          decayRate: 0.01,
        },
      ],
    });
    const results = await ingest(input);

    expect(results.length).toBe(1);
    expect(results[0]!.action).toBe("stored");
  });

  test("stores multiple structured entries", async () => {
    if (!dbAvailable) return;

    const input = parseStoreInput({
      entries: [
        { title: "Entry A", content: "Content A", domain: ["a"] },
        { title: "Entry B", content: "Content B completely different", domain: ["b"] },
      ],
    });
    const results = await ingest(input);

    const stored = results.filter((r) => r.action === "stored");
    expect(stored.length).toBe(2);
  });
});

describe("Ingestion Engine — Dedup", () => {
  test("detects duplicate on second ingestion of same content", async () => {
    if (!dbAvailable) return;

    // First: store
    const input1 = parseStoreInput({
      entries: [{ title: "Dedup Test", content: "Exact same content for dedup test", domain: ["testing"] }],
    });
    const results1 = await ingest(input1);
    expect(results1[0]!.action).toBe("stored");

    // Second: same title + content → same embedding → duplicate
    const input2 = parseStoreInput({
      entries: [{ title: "Dedup Test", content: "Exact same content for dedup test", domain: ["testing"] }],
    });
    const results2 = await ingest(input2);
    expect(results2[0]!.action).toBe("duplicate");
  });

  test("allows different content in same domain", async () => {
    if (!dbAvailable) return;

    const input1 = parseStoreInput({
      entries: [{ title: "Topic A", content: "Completely different topic about quantum computing", domain: ["science"] }],
    });
    await ingest(input1);

    const input2 = parseStoreInput({
      entries: [{ title: "Topic B", content: "Entirely unrelated topic about medieval history", domain: ["science"] }],
    });
    const results2 = await ingest(input2);
    expect(results2[0]!.action).toBe("stored");
  });
});

describe("Ingestion Engine — DB transaction", () => {
  test("entry has correct status after ingestion", async () => {
    if (!dbAvailable) return;

    const input = parseStoreInput({
      entries: [{ title: "Status Test", content: "Check status is active", domain: ["testing"] }],
    });
    const results = await ingest(input);
    const entryId = results[0]!.entryId;

    const sql = getTestClient();
    const rows = await sql`SELECT status FROM entry WHERE id = ${entryId}`;
    expect(rows[0]?.status).toBe("active");
  });

  test("domain and tags are stored correctly", async () => {
    if (!dbAvailable) return;

    const input = parseStoreInput({
      entries: [{
        title: "Relations Test",
        content: "Check domain and tag storage",
        domain: ["web-security", "javascript"],
        tags: ["xss", "csp", "headers"],
      }],
    });
    const results = await ingest(input);
    const entryId = results[0]!.entryId;

    const sql = getTestClient();
    const domains = await sql`SELECT domain FROM entry_domain WHERE entry_id = ${entryId}`;
    expect(domains.map((d) => (d as Record<string, string>).domain).sort()).toEqual(["javascript", "web-security"]);

    const tags = await sql`SELECT tag FROM entry_tag WHERE entry_id = ${entryId}`;
    expect(tags.map((t) => (t as Record<string, string>).tag).sort()).toEqual(["csp", "headers", "xss"]);
  });

  test("ingest_log records stored action", async () => {
    if (!dbAvailable) return;

    const input = parseStoreInput({
      entries: [{ title: "Log Test", content: "Check ingest log", domain: ["testing"] }],
    });
    const results = await ingest(input);
    const entryId = results[0]!.entryId;

    const sql = getTestClient();
    const logs = await sql`SELECT action FROM ingest_log WHERE entry_id = ${entryId}`;
    expect(logs[0]?.action).toBe("stored");
  });

  test("sources stored with rule-based trust", async () => {
    if (!dbAvailable) return;

    const input = parseStoreInput({
      entries: [{ title: "Source Test", content: "Check source trust values", domain: ["testing"] }],
      sources: [
        { url: "https://docs.example.com", sourceType: "official_docs" },
        { url: "https://blog.example.com", sourceType: "personal_blog" },
      ],
    });
    const results = await ingest(input);
    const entryId = results[0]!.entryId;

    const sql = getTestClient();
    const sources = await sql`SELECT source_type, trust FROM entry_source WHERE entry_id = ${entryId} ORDER BY source_type`;
    expect(sources).toHaveLength(2);

    const official = sources.find((s) => (s as Record<string, unknown>).source_type === "official_docs");
    expect((official as Record<string, unknown>)?.trust).toBe(0.9);

    const personal = sources.find((s) => (s as Record<string, unknown>).source_type === "personal_blog");
    expect((personal as Record<string, unknown>)?.trust).toBe(0.3);
  });
});
