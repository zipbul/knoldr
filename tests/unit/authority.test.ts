import { describe, test, expect } from "bun:test";
import { calculateAuthority, getSourceTrust } from "../../src/score/authority";
import type { Source } from "../../src/ingest/validate";

function s(sourceType: Source["sourceType"], trust?: number): Source {
  return { url: `https://${sourceType}.com`, sourceType, trust };
}

describe("getSourceTrust", () => {
  test("returns correct score for each known source type", () => {
    expect(getSourceTrust("official_docs")).toBe(0.9);
    expect(getSourceTrust("github_release")).toBe(0.85);
    expect(getSourceTrust("cve_db")).toBe(0.9);
    expect(getSourceTrust("official_blog")).toBe(0.8);
    expect(getSourceTrust("research_paper")).toBe(0.75);
    expect(getSourceTrust("established_blog")).toBe(0.6);
    expect(getSourceTrust("community_forum")).toBe(0.4);
    expect(getSourceTrust("personal_blog")).toBe(0.3);
    expect(getSourceTrust("ai_generated")).toBe(0.2);
    expect(getSourceTrust("unknown")).toBe(0.1);
  });

  test("returns 0.1 for unrecognized source type", () => {
    expect(getSourceTrust("nonexistent")).toBe(0.1);
    expect(getSourceTrust("")).toBe(0.1);
  });
});

describe("calculateAuthority", () => {
  test("returns 0.1 when no sources", () => {
    expect(calculateAuthority([])).toBe(0.1);
  });

  test("returns sourceType score for single source", () => {
    expect(calculateAuthority([s("official_docs")])).toBe(0.9);
    expect(calculateAuthority([s("unknown")])).toBe(0.1);
    expect(calculateAuthority([s("ai_generated")])).toBe(0.2);
  });

  test("ignores caller-supplied trust field (rule-based only)", () => {
    expect(calculateAuthority([s("ai_generated", 1.0)])).toBe(0.2);
    expect(calculateAuthority([s("unknown", 0.99)])).toBe(0.1);
  });

  test("multiple sources: max * 0.8 + avg * 0.2", () => {
    const result = calculateAuthority([s("official_docs"), s("community_forum")]);
    // max=0.9, avg=(0.9+0.4)/2=0.65 → 0.9*0.8+0.65*0.2=0.85
    expect(result).toBeCloseTo(0.85, 10);
  });

  test("multiple sources all same type", () => {
    const result = calculateAuthority([s("official_docs"), s("official_docs"), s("official_docs")]);
    // max=0.9, avg=0.9 → 0.9
    expect(result).toBeCloseTo(0.9, 10);
  });

  test("three sources mixed", () => {
    const result = calculateAuthority([s("cve_db"), s("research_paper"), s("personal_blog")]);
    // max=0.9, avg=(0.9+0.75+0.3)/3=0.65 → 0.85
    expect(result).toBeCloseTo(0.85, 10);
  });

  test("all low-trust sources", () => {
    const result = calculateAuthority([s("ai_generated"), s("unknown")]);
    // max=0.2, avg=0.15 → 0.2*0.8+0.15*0.2=0.19
    expect(result).toBeCloseTo(0.19, 10);
  });

  test("authority is always between 0 and 1", () => {
    const bestSources: Source[] = Array.from({ length: 20 }, () => s("official_docs"));
    const best = calculateAuthority(bestSources);
    expect(best).toBeLessThanOrEqual(1);
    expect(best).toBeGreaterThanOrEqual(0);

    const worstSources: Source[] = Array.from({ length: 20 }, () => s("unknown"));
    const worst = calculateAuthority(worstSources);
    expect(worst).toBeLessThanOrEqual(1);
    expect(worst).toBeGreaterThanOrEqual(0);
  });
});
