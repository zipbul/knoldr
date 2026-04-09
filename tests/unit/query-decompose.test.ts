import { describe, expect, test, beforeAll } from "bun:test";
import { decomposeQuery } from "../../src/collect/query-decompose";

// Use a command that exits immediately with failure to trigger fallback
beforeAll(() => {
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
