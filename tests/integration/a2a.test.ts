import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { setupTestDb, cleanTestDb, teardownTestDb } from "../helpers/db";
import { startMockEmbeddingServer, startMockLlmServer, stopMockServers } from "../helpers/mock-apis";

process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/knoldr_test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.KNOLDR_EMBEDDING_BASE_URL = "http://localhost:19876";
process.env.KNOLDR_EMBEDDING_API_KEY = "test-key";
process.env.KNOLDR_LLM_BASE_URL = "http://localhost:19877";
process.env.KNOLDR_LLM_API_KEY = "test-key";
process.env.KNOLDR_PORT = "19960";
process.env.KNOLDR_API_TOKEN = "test-token";

let dbAvailable = false;
let server: ReturnType<typeof Bun.serve> | null = null;

const A2A_URL = "http://localhost:19960";

async function a2aSend(skill: string, input: Record<string, unknown> = {}) {
  const res = await fetch(`${A2A_URL}/a2a`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-token",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `req-${Date.now()}`,
      method: "message/send",
      params: {
        message: {
          kind: "message",
          messageId: `msg-${Date.now()}`,
          role: "user",
          parts: [{ kind: "data", data: { skill, input } }],
        },
      },
    }),
  });
  return res.json();
}

beforeAll(async () => {
  try {
    await setupTestDb();
    dbAvailable = true;
  } catch (err) {
    console.warn("⚠ Test DB unavailable:", (err as Error).message);
    return;
  }

  startMockEmbeddingServer(19876);
  startMockLlmServer(19877);

  const { startServer } = await import("../../src/a2a/server");
  server = startServer();
});

afterEach(async () => {
  if (dbAvailable) await cleanTestDb();
});

afterAll(async () => {
  server?.stop();
  stopMockServers();
  if (dbAvailable) await teardownTestDb();
});

describe("A2A — Agent Card", () => {
  test("GET /.well-known/agent-card.json returns agent card", async () => {
    if (!dbAvailable) return;

    const res = await fetch(`${A2A_URL}/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
    const card = await res.json();
    expect(card.name).toBe("knoldr");
    expect(card.skills.length).toBe(6);
  });
});

describe("A2A — Health", () => {
  test("GET /health returns status", async () => {
    if (!dbAvailable) return;

    const res = await fetch(`${A2A_URL}/health`);
    expect(res.status).toBe(200);
    const health = await res.json();
    expect(health.db).toBe("up");
  });
});

describe("A2A — Auth", () => {
  test("rejects request without token", async () => {
    if (!dbAvailable) return;

    const res = await fetch(`${A2A_URL}/a2a`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "req-1",
        method: "message/send",
        params: { message: { kind: "message", messageId: "m1", role: "user", parts: [{ kind: "data", data: { skill: "audit", input: {} } }] } },
      }),
    });
    expect(res.status).toBe(401);
  });
});

describe("A2A — Store", () => {
  test("stores structured entry via A2A", async () => {
    if (!dbAvailable) return;

    const result = await a2aSend("store", {
      entries: [
        {
          title: "A2A Store Test",
          content: "Content stored via A2A protocol",
          domain: ["testing"],
          tags: ["a2a"],
        },
      ],
    }) as { result?: { parts?: Array<{ data?: { entries?: Array<{ action: string }> } }> } };

    const data = result.result?.parts?.[0]?.data;
    expect(data?.entries?.[0]?.action).toBe("stored");
  });
});

describe("A2A — Query", () => {
  test("queries entries via A2A", async () => {
    if (!dbAvailable) return;

    // Store first
    await a2aSend("store", {
      entries: [{ title: "Bun runtime", content: "Bun is fast JavaScript runtime", domain: ["javascript"] }],
    });

    const result = await a2aSend("query", { query: "Bun runtime" }) as {
      result?: { parts?: Array<{ data?: { entries?: unknown[] } }> };
    };

    const data = result.result?.parts?.[0]?.data;
    expect(data?.entries).toBeArray();
  });
});

describe("A2A — Explore", () => {
  test("explores entries via A2A", async () => {
    if (!dbAvailable) return;

    await a2aSend("store", {
      entries: [{ title: "Explore via A2A", content: "Explore test content", domain: ["a2a-test"] }],
    });

    const result = await a2aSend("explore", { domain: "a2a-test" }) as {
      result?: { parts?: Array<{ data?: { entries?: unknown[] } }> };
    };

    const data = result.result?.parts?.[0]?.data;
    expect(data?.entries).toBeArray();
  });
});

describe("A2A — Audit", () => {
  test("returns system stats via A2A", async () => {
    if (!dbAvailable) return;

    const result = await a2aSend("audit") as {
      result?: { parts?: Array<{ data?: { totalEntries?: number } }> };
    };

    const data = result.result?.parts?.[0]?.data;
    expect(data).toHaveProperty("totalEntries");
    expect(data).toHaveProperty("activeEntries");
    expect(data).toHaveProperty("ingestion");
  });
});

describe("A2A — Unknown skill", () => {
  test("returns error for unknown skill", async () => {
    if (!dbAvailable) return;

    const result = await a2aSend("nonexistent") as {
      result?: { parts?: Array<{ data?: { error?: string } }> };
    };

    const data = result.result?.parts?.[0]?.data;
    expect(data?.error).toContain("Unknown skill");
  });
});
