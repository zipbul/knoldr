import { describe, test, expect, beforeAll } from "bun:test";
import { extractTriples, normalizeEntityKey } from "../../src/kg/extract";

beforeAll(() => {
  process.env.KNOLDR_CODEX_CLI = "false";
  process.env.KNOLDR_GEMINI_CLI = "false";
});

describe("normalizeEntityKey", () => {
  test("lowercases and trims both fields", () => {
    expect(normalizeEntityKey({ name: "  Bun  ", type: " Tech " })).toBe("tech|bun");
  });

  test("distinguishes entities with same name but different type", () => {
    const a = normalizeEntityKey({ name: "Bun", type: "tech" });
    const b = normalizeEntityKey({ name: "Bun", type: "food" });
    expect(a).not.toBe(b);
  });
});

describe("extractTriples — LLM unavailable", () => {
  test("returns [] when both CLIs fail", async () => {
    const triples = await extractTriples("Bun is a JavaScript runtime.");
    expect(triples).toEqual([]);
  });

  test("does not throw on empty input", async () => {
    const triples = await extractTriples("");
    expect(triples).toEqual([]);
  });
});
