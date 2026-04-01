import { describe, expect, test } from "bun:test";
import { preFilterLinks } from "../../src/collect/link-filter";

describe("Link Filter — preFilterLinks", () => {
  test("filters out non-http links", () => {
    const links = ["https://example.com/a", "javascript:void(0)", "mailto:a@b.com", "ftp://x"];
    const { sameDomain } = preFilterLinks(links, new Set(), "example.com");
    expect(sameDomain).toEqual(["https://example.com/a"]);
  });

  test("filters out visited URLs", () => {
    const links = ["https://example.com/a", "https://example.com/b"];
    const visited = new Set(["https://example.com/a"]);
    const { sameDomain } = preFilterLinks(links, visited, "example.com");
    expect(sameDomain).toEqual(["https://example.com/b"]);
  });

  test("filters out skip extensions", () => {
    const links = [
      "https://example.com/style.css",
      "https://example.com/app.js",
      "https://example.com/font.woff2",
      "https://example.com/article",
    ];
    const { sameDomain } = preFilterLinks(links, new Set(), "example.com");
    expect(sameDomain).toEqual(["https://example.com/article"]);
  });

  test("filters out skip URL patterns", () => {
    const links = [
      "https://example.com/login",
      "https://example.com/signup",
      "https://example.com/cart",
      "https://example.com/article",
    ];
    const { sameDomain } = preFilterLinks(links, new Set(), "example.com");
    expect(sameDomain).toEqual(["https://example.com/article"]);
  });

  test("separates same-domain and external links", () => {
    const links = [
      "https://example.com/page1",
      "https://sub.example.com/page2",
      "https://other.com/page3",
    ];
    const { sameDomain, external } = preFilterLinks(links, new Set(), "example.com");
    expect(sameDomain).toEqual(["https://example.com/page1", "https://sub.example.com/page2"]);
    expect(external).toEqual(["https://other.com/page3"]);
  });

  test("deduplicates anchor variants", () => {
    const links = [
      "https://example.com/article",
      "https://example.com/article#section1",
      "https://example.com/article#section2",
    ];
    const { sameDomain } = preFilterLinks(links, new Set(), "example.com");
    expect(sameDomain).toEqual(["https://example.com/article"]);
  });

  test("deduplicates against visited after normalization", () => {
    const links = ["https://example.com/article#section"];
    const visited = new Set(["https://example.com/article"]);
    const { sameDomain } = preFilterLinks(links, visited, "example.com");
    expect(sameDomain).toEqual([]);
  });
});
