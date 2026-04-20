import { describe, expect, test, beforeAll } from "bun:test";
import { decomposeQuery } from "../../src/collect/query-decompose";

// Force ALL LLM paths to fail so fallbackQueries() is exercised.
// `false` is a POSIX command that always exits non-zero; Ollama is
// now primary (role-separated /api/chat) so we must also point its
// host at an unreachable address for the fallback path to trigger.
beforeAll(() => {
  process.env.KNOLDR_CODEX_CLI = "false";
  process.env.KNOLDR_GEMINI_CLI = "false";
  process.env.OLLAMA_HOST = "http://127.0.0.1:1";
  process.env.KNOLDR_OLLAMA_TIMEOUT_MS = "200";
});

describe("Query Decompose", () => {
  test("fallback produces 3 queries when CLI fails", async () => {
    // With no valid Gemini CLI, should fall back to 3 simple queries
    const queries = await decomposeQuery("test topic");
    expect(queries.length).toBe(3);
    expect(queries[0]!.main).toBe("test topic");
    expect(queries[1]!.main).toBe("test topic overview");
    expect(queries[2]!.main).toBe("test topic latest");
  });

  test("fallback queries have empty expansions", async () => {
    const queries = await decomposeQuery("test");
    for (const q of queries) {
      expect(q.expansions).toEqual([]);
    }
  });
});
