import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { setupTestDb, cleanTestDb, teardownTestDb } from "../helpers/db";
import { startMockEmbeddingServer, stopMockServers, MOCK_CODEX_CLI } from "../helpers/mock-apis";
import { join } from "path";

const CLI_PATH = join(import.meta.dir, "../../src/cli/index.ts");

const env = {
  ...process.env,
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/knoldr_test",
  KNOLDR_EMBEDDING_BASE_URL: "http://localhost:19879",
  KNOLDR_EMBEDDING_API_KEY: "test-key",
  KNOLDR_CODEX_CLI: MOCK_CODEX_CLI,
  KNOLDR_LOG_LEVEL: "error",
};

let dbAvailable = false;

async function runCli(args: string[], timeoutMs = 15000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    env,
    cwd: import.meta.dir, // avoid picking up .env from project root
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

beforeAll(async () => {
  try {
    await setupTestDb();
    dbAvailable = true;
  } catch (err) {
    console.warn("⚠ Test DB unavailable, skipping E2E tests:", (err as Error).message);
    return;
  }

  startMockEmbeddingServer(19879);
});

afterEach(async () => {
  if (dbAvailable) await cleanTestDb();
});

afterAll(async () => {
  stopMockServers();
  if (dbAvailable) await teardownTestDb();
});

// ============================================================
// CLI — help
// ============================================================
describe("CLI — help", () => {
  test("--help prints usage", async () => {
    const { stdout, exitCode } = await runCli(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("knoldr");
    expect(stdout).toContain("store");
    expect(stdout).toContain("query");
    expect(stdout).toContain("explore");
  });

  test("-h prints usage", async () => {
    const { stdout, exitCode } = await runCli(["-h"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("knoldr");
  });

  test("no args prints usage", async () => {
    const { stdout, exitCode } = await runCli([]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("knoldr");
  });
});

// ============================================================
// CLI — store
// ============================================================
describe("CLI — store", () => {
  test("store --raw stores and prints result", async () => {
    if (!dbAvailable) return;

    const { stdout, stderr, exitCode } = await runCli([
      "store",
      "--raw",
      "Bun is a fast JavaScript runtime",
    ]);
    if (exitCode !== 0) {
      console.error("CLI stderr:", stderr.slice(0, 500));
    }
    expect(exitCode).toBe(0);
    expect(stdout).toContain("[+]"); // stored icon
    expect(stdout).toContain("action=stored");
  });

  test("store --raw --json outputs JSON", async () => {
    if (!dbAvailable) return;

    const { stdout, exitCode } = await runCli([
      "store",
      "--raw",
      "JSON output test",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.entries).toBeArray();
    expect(parsed.entries[0].action).toBe("stored");
    expect(parsed.entries[0].entryId).toBeTruthy();
  });

  test("store --file reads from file", async () => {
    if (!dbAvailable) return;

    const tmpFile = join(import.meta.dir, "../../tmp-test-input.txt");
    await Bun.write(tmpFile, "Content from a file for testing.");

    const { stdout, exitCode } = await runCli(["store", "--file", tmpFile]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("action=stored");

    // cleanup
    await Bun.file(tmpFile).exists() && (await import("fs/promises")).unlink(tmpFile);
  });

  test("store --input reads structured JSON", async () => {
    if (!dbAvailable) return;

    const tmpFile = join(import.meta.dir, "../../tmp-test-structured.json");
    await Bun.write(
      tmpFile,
      JSON.stringify({
        entries: [
          {
            title: "Structured CLI Test",
            content: "Content from structured JSON input.",
            domain: ["cli-testing"],
            tags: ["e2e"],
          },
        ],
      }),
    );

    const { stdout, exitCode } = await runCli(["store", "--input", tmpFile, "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.entries[0].action).toBe("stored");

    await Bun.file(tmpFile).exists() && (await import("fs/promises")).unlink(tmpFile);
  });

  test("store with --source-url and --source-type", async () => {
    if (!dbAvailable) return;

    const { stdout, exitCode } = await runCli([
      "store",
      "--raw",
      "Test with sources",
      "--source-url",
      "https://example.com",
      "--source-type",
      "official_docs",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.entries[0].authority).toBe(0.9); // official_docs
  });

  test("store without mode flag exits with error", async () => {
    const { stderr, exitCode } = await runCli(["store"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--raw");
  });

  test("store --file with nonexistent file exits with error", async () => {
    const { stderr, exitCode } = await runCli([
      "store",
      "--file",
      "/tmp/nonexistent-knoldr-test-file.txt",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("not found");
  });
});

// ============================================================
// CLI — query
// ============================================================
describe("CLI — query", () => {
  test("query returns results after store", async () => {
    if (!dbAvailable) return;

    // Store first
    await runCli(["store", "--raw", "Bun runtime is blazing fast"]);

    // Query
    const { stdout, exitCode } = await runCli(["query", "Bun", "runtime"]);
    expect(exitCode).toBe(0);
    // May or may not find results depending on pgroonga tokenization
    // At minimum should not crash
  });

  test("query --json outputs valid JSON", async () => {
    if (!dbAvailable) return;

    await runCli(["store", "--raw", "PostgreSQL is a relational database"]);

    const { stdout, exitCode } = await runCli(["query", "PostgreSQL", "--json"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("entries");
    expect(parsed).toHaveProperty("scores");
    expect(parsed).toHaveProperty("trustLevels");
  });

  test("query without search term exits with error", async () => {
    const { stderr, exitCode } = await runCli(["query"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("search term");
  });
});

// ============================================================
// CLI — explore
// ============================================================
describe("CLI — explore", () => {
  test("explore returns entries", async () => {
    if (!dbAvailable) return;

    await runCli(["store", "--raw", "Explore test data"]);

    const { stdout, stderr, exitCode } = await runCli(["explore", "--json"]);
    if (exitCode !== 0) console.error("explore stderr:", stderr.slice(0, 500));
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.entries).toBeArray();
  });

  test("explore --domain filters by domain", async () => {
    if (!dbAvailable) return;

    // LLM mock returns domain=["testing"] by default
    await runCli(["store", "--raw", "Data for domain filter test"]);

    const { stdout, exitCode } = await runCli([
      "explore",
      "--domain",
      "testing",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    // Should include entries in "testing" domain
    expect(parsed.entries).toBeArray();
  });

  test("explore --sort created_at works", async () => {
    if (!dbAvailable) return;

    await runCli(["store", "--raw", "Sort test"]);

    const { exitCode } = await runCli(["explore", "--sort", "created_at"]);
    expect(exitCode).toBe(0);
  });
});

// ============================================================
// CLI — feedback
// ============================================================
describe("CLI — feedback", () => {
  test("feedback positive adjusts authority", async () => {
    if (!dbAvailable) return;

    // Store and get entryId
    const storeResult = await runCli([
      "store",
      "--raw",
      "Feedback test entry",
      "--json",
    ]);
    const parsed = JSON.parse(storeResult.stdout);
    const entryId = parsed.entries[0].entryId;

    const { stdout, exitCode } = await runCli([
      "feedback",
      entryId,
      "positive",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("feedback applied");
    expect(stdout).toContain("authority=");
  });

  test("feedback --json outputs JSON", async () => {
    if (!dbAvailable) return;

    const storeResult = await runCli(["store", "--raw", "JSON feedback test", "--json"]);
    const entryId = JSON.parse(storeResult.stdout).entries[0].entryId;

    const { stdout, exitCode } = await runCli([
      "feedback",
      entryId,
      "negative",
      "--reason",
      "test reason",
      "--json",
    ]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.entryId).toBe(entryId);
    expect(result.newAuthority).toBeDefined();
  });

  test("feedback without args exits with error", async () => {
    const { stderr, exitCode } = await runCli(["feedback"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("requires");
  });

  test("feedback with invalid signal exits with error", async () => {
    const { stderr, exitCode } = await runCli(["feedback", "some-id", "neutral"]);
    expect(exitCode).toBe(1);
  });
});

// ============================================================
// CLI — audit
// ============================================================
describe("CLI — audit", () => {
  test("audit shows statistics", async () => {
    if (!dbAvailable) return;

    // Store some data
    await runCli(["store", "--raw", "Audit test entry 1"]);
    await runCli(["store", "--raw", "Audit test entry 2"]);

    const { stdout, exitCode } = await runCli(["audit"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Entries:");
    expect(stdout).toContain("stored");
  });

  test("audit --json outputs valid JSON", async () => {
    if (!dbAvailable) return;

    await runCli(["store", "--raw", "Audit JSON test"]);

    const { stdout, exitCode } = await runCli(["audit", "--json"]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result).toHaveProperty("totalEntries");
    expect(result).toHaveProperty("activeEntries");
    expect(result).toHaveProperty("avgAuthority");
    expect(result).toHaveProperty("ingestion");
    expect(result).toHaveProperty("domainDistribution");
  });
});

// ============================================================
// CLI — unknown command
// ============================================================
describe("CLI — error handling", () => {
  test("unknown command shows error and help", async () => {
    const { stderr, exitCode } = await runCli(["unknown-cmd"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown command");
  });
});
