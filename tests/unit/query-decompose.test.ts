import { describe, expect, test, beforeAll } from "bun:test";
import { decomposeQuery } from "../../src/collect/query-decompose";

// Force both CLIs to fail so fallbackQueries() is exercised.
// `false` is a POSIX command that always exits non-zero.
beforeAll(() => {
  process.env.KNOLDR_CODEX_CLI = "false";
  process.env.KNOLDR_GEMINI_CLI = "false";
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
