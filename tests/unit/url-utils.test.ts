import { describe, test, expect } from "bun:test";
import { normalizeUrl, hashUrl } from "../../src/collect/url-utils";

describe("normalizeUrl", () => {
  test("removes utm parameters", () => {
    expect(normalizeUrl("https://example.com/page?utm_source=twitter&utm_medium=social"))
      .toBe("https://example.com/page");
  });

  test("removes multiple tracking params", () => {
    expect(normalizeUrl("https://example.com/page?ref=abc&fbclid=xyz&keep=1"))
      .toBe("https://example.com/page?keep=1");
  });

  test("removes trailing slash", () => {
    expect(normalizeUrl("https://example.com/page/")).toBe("https://example.com/page");
  });

  test("preserves root path", () => {
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com/");
  });

  test("preserves non-tracking query params", () => {
    expect(normalizeUrl("https://example.com/search?q=bun&page=2"))
      .toBe("https://example.com/search?q=bun&page=2");
  });

  test("handles invalid URL gracefully", () => {
    expect(normalizeUrl("not-a-url")).toBe("not-a-url");
  });

  test("handles empty string", () => {
    expect(normalizeUrl("")).toBe("");
  });
});

describe("hashUrl", () => {
  test("produces consistent hash for same URL", () => {
    const h1 = hashUrl("https://example.com/page");
    const h2 = hashUrl("https://example.com/page");
    expect(h1).toBe(h2);
  });

  test("same URL with/without tracking params produces same hash", () => {
    const h1 = hashUrl("https://example.com/page");
    const h2 = hashUrl("https://example.com/page?utm_source=twitter");
    expect(h1).toBe(h2);
  });

  test("different URLs produce different hashes", () => {
    const h1 = hashUrl("https://example.com/page1");
    const h2 = hashUrl("https://example.com/page2");
    expect(h1).not.toBe(h2);
  });

  test("hash is a hex string", () => {
    const h = hashUrl("https://example.com");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
