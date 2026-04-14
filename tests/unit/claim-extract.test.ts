import { describe, test, expect, beforeAll } from "bun:test";
import { extractClaims, CLAIM_TYPES } from "../../src/claim/extract";

// Both LLM CLIs are forced to fail so extractClaims falls through to
// returning []. The LLM-bound success path is exercised by integration
// tests; unit tests verify the contract around failure.
beforeAll(() => {
  process.env.KNOLDR_CODEX_CLI = "false";
  process.env.KNOLDR_GEMINI_CLI = "false";
});

describe("extractClaims — LLM unavailable", () => {
  test("returns empty array when both CLIs fail", async () => {
    const result = await extractClaims("Title", "Some content about Bun.");
    expect(result).toEqual([]);
  });

  test("does not throw on empty inputs", async () => {
    const result = await extractClaims("", "");
    expect(result).toEqual([]);
  });
});

describe("CLAIM_TYPES invariants", () => {
  test("covers the four DESIGN.md v0.3 epistemic categories", () => {
    expect(CLAIM_TYPES).toEqual(["factual", "subjective", "predictive", "normative"]);
  });
});
