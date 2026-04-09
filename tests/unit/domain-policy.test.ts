import { describe, expect, test } from "bun:test";
import { isPathAllowed, checkRateLimit, recordRequest } from "../../src/collect/domain-policy";

describe("Domain Policy", () => {
  describe("isPathAllowed (robots.txt)", () => {
    const robotsTxt = `User-agent: *
Disallow: /admin
Disallow: /private/
Disallow: /api/internal

User-agent: Googlebot
Disallow: /no-google`;

    test("blocks disallowed paths", () => {
      expect(isPathAllowed(robotsTxt, "/admin")).toBe(false);
      expect(isPathAllowed(robotsTxt, "/admin/settings")).toBe(false);
      expect(isPathAllowed(robotsTxt, "/private/data")).toBe(false);
      expect(isPathAllowed(robotsTxt, "/api/internal")).toBe(false);
    });

    test("allows other paths", () => {
      expect(isPathAllowed(robotsTxt, "/")).toBe(true);
      expect(isPathAllowed(robotsTxt, "/public")).toBe(true);
      expect(isPathAllowed(robotsTxt, "/article/123")).toBe(true);
      expect(isPathAllowed(robotsTxt, "/api/public")).toBe(true);
    });

    test("only applies wildcard user-agent rules", () => {
      // /no-google is only for Googlebot, not wildcard
      expect(isPathAllowed(robotsTxt, "/no-google")).toBe(true);
    });

    test("null robots.txt allows all", () => {
      expect(isPathAllowed(null, "/anything")).toBe(true);
      expect(isPathAllowed(null, "/admin")).toBe(true);
    });

    test("empty robots.txt allows all", () => {
      expect(isPathAllowed("", "/anything")).toBe(true);
    });
  });

  describe("checkRateLimit", () => {
    test("first request is not rate limited", () => {
      const result = checkRateLimit("unique-domain-1.com", 2000);
      expect(result.shouldWait).toBe(false);
    });

    test("rapid second request is rate limited", () => {
      recordRequest("rate-test-domain.com");
      const result = checkRateLimit("rate-test-domain.com", 2000);
      expect(result.shouldWait).toBe(true);
      expect(result.waitMs).toBeGreaterThan(0);
      expect(result.waitMs).toBeLessThanOrEqual(2000);
    });
  });
});
