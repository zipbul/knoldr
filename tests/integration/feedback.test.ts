import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { setupTestDb, cleanTestDb, teardownTestDb, getTestClient } from "../helpers/db";
import { startMockEmbeddingServer, startMockOllamaServer, stopMockServers } from "../helpers/mock-apis";

process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/knoldr_test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.KNOLDR_EMBEDDING_BASE_URL = "http://localhost:19876";
process.env.KNOLDR_EMBEDDING_API_KEY = "test-key";
process.env.OLLAMA_HOST = "http://127.0.0.1:11499";
process.env.KNOLDR_OLLAMA_TIMEOUT_MS = "2000";
process.env.KNOLDR_OLLAMA_FAST_MODEL = "mock";
process.env.KNOLDR_OLLAMA_JURY_MODELS = "mock";

let processFeedback: typeof import("../../src/score/feedback").processFeedback;
let RateLimitError: typeof import("../../src/score/feedback").RateLimitError;
let ingest: typeof import("../../src/ingest/engine").ingest;
let parseStoreInput: typeof import("../../src/ingest/validate").parseStoreInput;

let dbAvailable = false;

beforeAll(async () => {
  try {
    await setupTestDb();
    dbAvailable = true;
  } catch (err) {
    console.warn("⚠ Test DB unavailable, skipping feedback tests:", (err as Error).message);
    return;
  }

  startMockEmbeddingServer(19876);
  startMockOllamaServer(11499);

  const fbMod = await import("../../src/score/feedback");
  processFeedback = fbMod.processFeedback;
  RateLimitError = fbMod.RateLimitError;

  const engineMod = await import("../../src/ingest/engine");
  ingest = engineMod.ingest;

  const validateMod = await import("../../src/ingest/validate");
  parseStoreInput = validateMod.parseStoreInput;
});

afterEach(async () => {
  if (dbAvailable) await cleanTestDb();
});

afterAll(async () => {
  stopMockServers();
  if (dbAvailable) await teardownTestDb();
});

let entryCounter = 0;
async function createTestEntry() {
  entryCounter++;
  // fakeEmbedding in mock-apis.ts hashes only the first 384 chars position
  // by position, so varying tokens must appear early in the string to
  // yield distinct vectors. Put the unique id at the very start.
  const uniqueId = `${entryCounter}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const input = parseStoreInput({
    entries: [{
      title: `${uniqueId} Feedback Test Entry`,
      content: `${uniqueId} Completely unique and different content for feedback testing.`,
      domain: [`testing-${entryCounter}`],
    }],
    sources: [{ url: "https://docs.example.com", sourceType: "official_docs" }],
  });
  const results = await ingest(input);
  if (results[0]!.action !== "stored" || !results[0]!.entryId) {
    throw new Error(`createTestEntry failed: action=${results[0]!.action}`);
  }
  return results[0]!.entryId;
}

describe("Feedback — authority adjustment", () => {
  test("positive feedback increases authority", async () => {
    if (!dbAvailable) return;

    const entryId = await createTestEntry();
    const sql = getTestClient();
    const before = await sql`SELECT authority FROM entry WHERE id = ${entryId}`;
    const beforeAuth = before[0]!.authority as number;

    const result = await processFeedback(entryId, "positive", undefined, "agent-1");
    expect(result.newAuthority).toBeGreaterThan(beforeAuth);
    // LEAST(1.0, authority * 1.1)
    expect(result.newAuthority).toBeCloseTo(Math.min(1.0, beforeAuth * 1.1), 3);
  });

  test("negative feedback decreases authority", async () => {
    if (!dbAvailable) return;

    const entryId = await createTestEntry();
    const sql = getTestClient();
    const before = await sql`SELECT authority FROM entry WHERE id = ${entryId}`;
    const beforeAuth = before[0]!.authority as number;

    const result = await processFeedback(entryId, "negative", "outdated", "agent-1");
    expect(result.newAuthority).toBeLessThan(beforeAuth);
    // GREATEST(0.05, authority * 0.8)
    expect(result.newAuthority).toBeCloseTo(Math.max(0.05, beforeAuth * 0.8), 3);
  });

  test("authority never drops below 0.05", async () => {
    if (!dbAvailable) return;

    const entryId = await createTestEntry();

    // Apply many negative feedbacks (from different agents)
    for (let i = 0; i < 20; i++) {
      try {
        await processFeedback(entryId, "negative", undefined, `agent-${i}`);
      } catch {
        // rate limit is fine
      }
    }

    const sql = getTestClient();
    const after = await sql`SELECT authority FROM entry WHERE id = ${entryId}`;
    expect(after[0]!.authority as number).toBeGreaterThanOrEqual(0.05);
  });

  test("authority never exceeds 1.0", async () => {
    if (!dbAvailable) return;

    const entryId = await createTestEntry();

    for (let i = 0; i < 10; i++) {
      try {
        await processFeedback(entryId, "positive", undefined, `agent-${i}`);
      } catch {
        // rate limit
      }
    }

    const sql = getTestClient();
    const after = await sql`SELECT authority FROM entry WHERE id = ${entryId}`;
    expect(after[0]!.authority as number).toBeLessThanOrEqual(1.0);
  });
});

describe("Feedback — rate limiting", () => {
  test("same agent+entry blocked within 1 hour", async () => {
    if (!dbAvailable) return;

    const entryId = await createTestEntry();
    await processFeedback(entryId, "positive", undefined, "agent-rl");

    await expect(
      processFeedback(entryId, "positive", undefined, "agent-rl"),
    ).rejects.toThrow(RateLimitError);
  });

  test("different agent on same entry is allowed", async () => {
    if (!dbAvailable) return;

    const entryId = await createTestEntry();
    await processFeedback(entryId, "positive", undefined, "agent-a");

    // Different agent should work
    const result = await processFeedback(entryId, "positive", undefined, "agent-b");
    expect(result.newAuthority).toBeGreaterThan(0);
  });

  test("same agent on different entries is allowed", async () => {
    if (!dbAvailable) return;

    const entryId1 = await createTestEntry();
    const entryId2 = await createTestEntry();

    await processFeedback(entryId1, "positive", undefined, "agent-x");
    const result = await processFeedback(entryId2, "positive", undefined, "agent-x");
    expect(result.newAuthority).toBeGreaterThan(0);
  });
});

describe("Feedback — audit log", () => {
  test("feedback is recorded in feedback_log", async () => {
    if (!dbAvailable) return;

    const entryId = await createTestEntry();
    await processFeedback(entryId, "negative", "test reason", "agent-log");

    const sql = getTestClient();
    const logs = await sql`SELECT signal, reason, agent_id FROM feedback_log WHERE entry_id = ${entryId}`;
    expect(logs).toHaveLength(1);
    expect(logs[0]!.signal).toBe("negative");
    expect(logs[0]!.reason).toBe("test reason");
    expect(logs[0]!.agent_id).toBe("agent-log");
  });
});
