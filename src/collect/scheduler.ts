import { db } from "../db/connection";
import { sourceFeed, ingestLog } from "../db/schema";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { ingest } from "../ingest/engine";
import { parseStoreInput } from "../ingest/validate";
import { hashUrl } from "./url-utils";
import { fetchRss } from "./feeds/rss";
import { fetchGithubReleases, githubReleaseToRaw } from "./feeds/github-release";
import { fetchNpmPackage, npmToRaw } from "./feeds/npm-registry";
import { fetchOsvVulnerabilities, osvToRaw } from "./feeds/osv";
import { fetchArxiv, arxivToRaw } from "./feeds/arxiv";
import { fetchHnTopStories, hnToRaw } from "./feeds/hackernews";
import { fetchRedditHot, redditToRaw } from "./feeds/reddit";
import { processRetryQueue } from "./retry";
import { batchDedup } from "./batch-dedup";
import { logger } from "../observability/logger";

interface FeedConfig {
  sourceType?: string;
  keywords?: string[];
  ecosystems?: string[];
  subreddits?: string[];
  clientId?: string;
  clientSecret?: string;
  category?: string;
}

/** Check if URL was already ingested */
async function isUrlIngested(url: string): Promise<boolean> {
  const hash = hashUrl(url);
  const existing = await db
    .select({ id: ingestLog.id })
    .from(ingestLog)
    .where(eq(ingestLog.urlHash, hash))
    .limit(1);
  return existing.length > 0;
}

/** Ingest a raw item with URL dedup check */
async function ingestWithUrlDedup(
  raw: string,
  sources: Array<{ url: string; sourceType: string }>,
  feedId: string,
): Promise<void> {
  const url = sources[0]?.url;
  if (url && (await isUrlIngested(url))) {
    logger.debug({ url, feedId }, "URL already ingested, skipping");
    return;
  }

  try {
    const input = parseStoreInput({ raw: raw.slice(0, 200_000), sources });
    const results = await ingest(input);

    // Record URL hash for future dedup
    if (url) {
      for (const r of results) {
        if (r.action === "stored") {
          await db
            .insert(ingestLog)
            .values({
              id: ulid(),
              urlHash: hashUrl(url),
              sourceFeedId: feedId,
              entryId: r.entryId,
              action: "stored",
            })
            .onConflictDoNothing();
        }
      }
    }
  } catch (err) {
    logger.warn({ feedId, error: (err as Error).message }, "feed ingestion failed");
  }
}

/** Process a single feed */
async function processFeed(feed: typeof sourceFeed.$inferSelect): Promise<void> {
  const config = (feed.config as FeedConfig) ?? {};
  logger.info({ feedId: feed.id, feedType: feed.feedType }, "processing feed");

  try {
    switch (feed.feedType) {
      case "rss":
      case "atom": {
        const items = await fetchRss(feed.url);
        for (const item of items.slice(0, 10)) {
          const sourceType = config.sourceType ?? "unknown";
          await ingestWithUrlDedup(
            `${item.title}\n\n${item.description}`,
            [{ url: item.link, sourceType }],
            feed.id,
          );
        }
        break;
      }

      case "github_release": {
        const releases = await fetchGithubReleases(feed.url);
        for (const release of releases.slice(0, 5)) {
          const data = githubReleaseToRaw(release);
          await ingestWithUrlDedup(data.raw, data.sources, feed.id);
        }
        break;
      }

      case "npm": {
        for (const keyword of config.keywords ?? []) {
          const pkg = await fetchNpmPackage(keyword);
          if (pkg) {
            const data = npmToRaw(pkg);
            await ingestWithUrlDedup(data.raw, data.sources, feed.id);
          }
        }
        break;
      }

      case "osv": {
        for (const ecosystem of config.ecosystems ?? []) {
          const vulns = await fetchOsvVulnerabilities(ecosystem);
          for (const vuln of vulns.slice(0, 10)) {
            const data = osvToRaw(vuln);
            await ingestWithUrlDedup(data.raw, data.sources, feed.id);
          }
        }
        break;
      }

      case "arxiv": {
        const category = config.category ?? "cs.AI";
        const papers = await fetchArxiv(category);
        for (const paper of papers.slice(0, 10)) {
          const data = arxivToRaw(paper);
          await ingestWithUrlDedup(data.raw, data.sources, feed.id);
        }
        break;
      }

      case "hackernews": {
        const stories = await fetchHnTopStories(30);
        const jinaKey = process.env.KNOLDR_JINA_API_KEY;
        for (const story of stories.slice(0, 10)) {
          const data = await hnToRaw(story, jinaKey);
          await ingestWithUrlDedup(data.raw, data.sources, feed.id);
        }
        break;
      }

      case "reddit": {
        const clientId = config.clientId ?? "";
        const clientSecret = config.clientSecret ?? "";
        for (const subreddit of config.subreddits ?? []) {
          const posts = await fetchRedditHot(subreddit, clientId, clientSecret);
          for (const post of posts.slice(0, 10)) {
            const data = redditToRaw(post);
            await ingestWithUrlDedup(data.raw, data.sources, feed.id);
          }
        }
        break;
      }

      default:
        logger.warn({ feedType: feed.feedType }, "unknown feed type");
    }

    // Update last_fetched_at
    await db
      .update(sourceFeed)
      .set({ lastFetchedAt: new Date() })
      .where(eq(sourceFeed.id, feed.id));
  } catch (err) {
    logger.error({ feedId: feed.id, error: (err as Error).message }, "feed processing failed");
  }
}

/** Parse cron expression and check if it should run now */
function shouldRun(schedule: string, lastFetchedAt: Date | null): boolean {
  if (!lastFetchedAt) return true; // never fetched

  // Simple interval parser: "0 */N * * *" → every N hours
  const match = schedule.match(/\*\/(\d+)/);
  if (match) {
    const intervalHours = Number(match[1]);
    const elapsed = (Date.now() - lastFetchedAt.getTime()) / (1000 * 60 * 60);
    return elapsed >= intervalHours;
  }

  // Daily schedule: "0 0 * * *" → every 24h
  if (schedule.includes("0 0 ") || schedule.includes("0 */24")) {
    const elapsed = (Date.now() - lastFetchedAt.getTime()) / (1000 * 60 * 60);
    return elapsed >= 24;
  }

  // Default: run if > 6h since last fetch
  const elapsed = (Date.now() - lastFetchedAt.getTime()) / (1000 * 60 * 60);
  return elapsed >= 6;
}

/** Ensure partitions exist for current + next year */
async function ensurePartitions(): Promise<void> {
  const { getClient } = await import("../db/connection");
  const sql = getClient();
  const currentYear = new Date().getFullYear();

  for (let year = currentYear; year <= currentYear + 1; year++) {
    try {
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS entry_${year} PARTITION OF entry
          FOR VALUES FROM ('${year}-01-01') TO ('${year + 1}-01-01')
      `);
    } catch {
      // partition already exists
    }
  }
}

/** Main scheduler tick — runs all due feeds, retry queue, and partition check */
export async function schedulerTick(): Promise<void> {
  logger.info("scheduler tick");

  // Ensure partitions
  await ensurePartitions();

  // Process due feeds
  const feeds = await db
    .select()
    .from(sourceFeed)
    .where(eq(sourceFeed.enabled, true));

  for (const feed of feeds) {
    if (shouldRun(feed.schedule, feed.lastFetchedAt)) {
      await processFeed(feed);
    }
  }

  // Process retry queue
  const retried = await processRetryQueue();
  if (retried > 0) {
    logger.info({ retried }, "retry queue processed");
  }
}

/** Start the scheduler loop (runs every 5 minutes) */
export function startScheduler(): NodeJS.Timeout {
  // Run immediately once
  schedulerTick().catch((err) =>
    logger.error({ error: (err as Error).message }, "scheduler tick failed"),
  );

  // Then every 5 minutes
  return setInterval(() => {
    schedulerTick().catch((err) =>
      logger.error({ error: (err as Error).message }, "scheduler tick failed"),
    );
  }, 5 * 60 * 1000);
}

/** Start daily batch dedup (runs at UTC 03:00) */
export function startBatchDedup(): NodeJS.Timeout {
  const runAtUtc3 = () => {
    const now = new Date();
    const utcHour = now.getUTCHours();
    if (utcHour === 3) {
      batchDedup().catch((err) =>
        logger.error({ error: (err as Error).message }, "batch dedup failed"),
      );
    }
  };

  // Check every hour
  return setInterval(runAtUtc3, 60 * 60 * 1000);
}
