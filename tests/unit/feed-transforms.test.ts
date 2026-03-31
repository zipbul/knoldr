import { describe, test, expect } from "bun:test";
import { githubReleaseToRaw } from "../../src/collect/feeds/github-release";
import { npmToRaw } from "../../src/collect/feeds/npm-registry";
import { osvToRaw } from "../../src/collect/feeds/osv";
import { arxivToRaw } from "../../src/collect/feeds/arxiv";
import { redditToRaw } from "../../src/collect/feeds/reddit";

describe("githubReleaseToRaw", () => {
  test("formats release as raw + source", () => {
    const result = githubReleaseToRaw({
      repo: "oven-sh/bun",
      tag: "v1.2.0",
      body: "Bug fixes and performance improvements",
      url: "https://github.com/oven-sh/bun/releases/tag/v1.2.0",
    });
    expect(result.raw).toContain("oven-sh/bun v1.2.0");
    expect(result.raw).toContain("Bug fixes");
    expect(result.sources[0]!.sourceType).toBe("github_release");
  });
});

describe("npmToRaw", () => {
  test("formats package as raw + source", () => {
    const result = npmToRaw({
      name: "drizzle-orm",
      version: "0.45.0",
      description: "TypeScript ORM",
      url: "https://www.npmjs.com/package/drizzle-orm",
    });
    expect(result.raw).toContain("drizzle-orm@0.45.0");
    expect(result.raw).toContain("TypeScript ORM");
    expect(result.sources[0]!.sourceType).toBe("official_docs");
  });
});

describe("osvToRaw", () => {
  test("formats vulnerability as raw + source", () => {
    const result = osvToRaw({
      id: "GHSA-xxxx-yyyy",
      summary: "Critical XSS vulnerability",
      details: "Detailed description of the vulnerability",
      affected: ["package-a", "package-b"],
      url: "https://osv.dev/vulnerability/GHSA-xxxx-yyyy",
    });
    expect(result.raw).toContain("GHSA-xxxx-yyyy");
    expect(result.raw).toContain("Critical XSS");
    expect(result.raw).toContain("package-a, package-b");
    expect(result.sources[0]!.sourceType).toBe("cve_db");
  });
});

describe("arxivToRaw", () => {
  test("formats paper as raw + source", () => {
    const result = arxivToRaw({
      title: "Attention Is All You Need",
      summary: "Transformer architecture paper",
      url: "https://arxiv.org/abs/1706.03762",
    });
    expect(result.raw).toContain("Attention Is All You Need");
    expect(result.raw).toContain("Transformer");
    expect(result.sources[0]!.sourceType).toBe("research_paper");
  });
});

describe("redditToRaw", () => {
  test("formats self post as raw + source", () => {
    const result = redditToRaw({
      title: "Why Bun is awesome",
      selftext: "Bun is really fast",
      url: "https://reddit.com/r/javascript/...",
      permalink: "/r/javascript/comments/abc/why_bun/",
      score: 500,
      isSelfPost: true,
    });
    expect(result.raw).toContain("Why Bun is awesome");
    expect(result.raw).toContain("Bun is really fast");
    expect(result.sources[0]!.url).toContain("reddit.com");
    expect(result.sources[0]!.sourceType).toBe("community_forum");
  });

  test("formats link post (no selftext) as title only", () => {
    const result = redditToRaw({
      title: "Check out this article",
      selftext: "",
      url: "https://external.com/article",
      permalink: "/r/programming/comments/xyz/check_out/",
      score: 200,
      isSelfPost: false,
    });
    expect(result.raw).toBe("Check out this article");
  });
});
