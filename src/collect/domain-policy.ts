import { db } from "../db/connection";
import { crawlDomain } from "../db/schema";
import { eq, sql } from "drizzle-orm";
import { logger } from "../observability/logger";

export interface DomainPolicy {
  domain: string;
  sourceType: string;
  trust: number;
  blocked: boolean;
  blockReason: string | null;
  rateLimitMs: number;
  robotsTxt: string | null;
  robotsFetchedAt: Date | null;
  config: unknown;
  totalCrawled: number;
  totalSuccess: number;
  lastCrawledAt: Date | null;
}

// In-memory rate limit tracker (last request time per domain)
const lastRequestTime = new Map<string, number>();

const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Get or create domain policy. Auto-fetches robots.txt on first visit.
 */
export async function getDomainPolicy(domain: string): Promise<DomainPolicy> {
  const existing = await db.select().from(crawlDomain).where(eq(crawlDomain.domain, domain)).limit(1);

  if (existing.length > 0) {
    const policy = existing[0]!;

    // Refresh robots.txt if stale
    if (!policy.robotsFetchedAt || Date.now() - policy.robotsFetchedAt.getTime() > ROBOTS_TTL_MS) {
      const robotsTxt = await fetchRobotsTxt(domain);
      await db.update(crawlDomain).set({
        robotsTxt,
        robotsFetchedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(crawlDomain.domain, domain));
      policy.robotsTxt = robotsTxt;
      policy.robotsFetchedAt = new Date();
    }

    return policy as DomainPolicy;
  }

  // New domain — create with defaults
  const robotsTxt = await fetchRobotsTxt(domain);
  const newPolicy: typeof crawlDomain.$inferInsert = {
    domain,
    robotsTxt,
    robotsFetchedAt: new Date(),
  };

  await db.insert(crawlDomain).values(newPolicy).onConflictDoNothing();
  logger.info({ domain }, "new crawl domain registered");

  const result = await db.select().from(crawlDomain).where(eq(crawlDomain.domain, domain)).limit(1);
  return result[0]! as DomainPolicy;
}

/**
 * Check if a URL path is allowed by robots.txt.
 * Simple parser — handles User-agent: * and Disallow directives.
 */
export function isPathAllowed(robotsTxt: string | null, path: string): boolean {
  if (!robotsTxt) return true;

  const lines = robotsTxt.split("\n");
  let inWildcardBlock = false;
  const disallowed: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim().toLowerCase();
    if (line.startsWith("user-agent:")) {
      const agent = line.slice("user-agent:".length).trim();
      inWildcardBlock = agent === "*";
    } else if (inWildcardBlock && line.startsWith("disallow:")) {
      const disallowPath = line.slice("disallow:".length).trim();
      if (disallowPath) disallowed.push(disallowPath);
    }
  }

  const lowerPath = path.toLowerCase();
  return !disallowed.some((d) => lowerPath.startsWith(d));
}

/**
 * Check rate limit — returns true if we should wait, with ms to wait.
 */
export function checkRateLimit(domain: string, rateLimitMs: number): { shouldWait: boolean; waitMs: number } {
  const last = lastRequestTime.get(domain) ?? 0;
  const elapsed = Date.now() - last;
  if (elapsed >= rateLimitMs) {
    return { shouldWait: false, waitMs: 0 };
  }
  return { shouldWait: true, waitMs: rateLimitMs - elapsed };
}

/**
 * Record that a request was made to this domain.
 */
export function recordRequest(domain: string): void {
  lastRequestTime.set(domain, Date.now());
}

/**
 * Update domain stats after crawling a page.
 */
export async function updateDomainStats(domain: string, success: boolean): Promise<void> {
  await db.update(crawlDomain).set({
    totalCrawled: sql`${crawlDomain.totalCrawled} + 1`,
    totalSuccess: success ? sql`${crawlDomain.totalSuccess} + 1` : crawlDomain.totalSuccess,
    lastCrawledAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(crawlDomain.domain, domain));

  // Auto-block check: if 20+ crawls and success rate < 10%
  const result = await db.select({
    totalCrawled: crawlDomain.totalCrawled,
    totalSuccess: crawlDomain.totalSuccess,
    blocked: crawlDomain.blocked,
  }).from(crawlDomain).where(eq(crawlDomain.domain, domain)).limit(1);

  if (result[0] && !result[0].blocked && result[0].totalCrawled >= 20) {
    const rate = result[0].totalSuccess / result[0].totalCrawled;
    if (rate < 0.1) {
      await db.update(crawlDomain).set({
        blocked: true,
        blockReason: `auto-blocked: success rate ${(rate * 100).toFixed(1)}% (${result[0].totalSuccess}/${result[0].totalCrawled})`,
        updatedAt: new Date(),
      }).where(eq(crawlDomain.domain, domain));
      logger.warn({ domain, rate }, "domain auto-blocked due to low success rate");
    }
  }
}

async function fetchRobotsTxt(domain: string): Promise<string | null> {
  try {
    const res = await fetch(`https://${domain}/robots.txt`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}
