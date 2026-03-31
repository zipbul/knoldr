import { db } from "../../db/connection";
import { sourceFeed } from "../../db/schema";
import { eq } from "drizzle-orm";
import { ingest } from "../../ingest/engine";
import { parseStoreInput } from "../../ingest/validate";
import { logger } from "../../observability/logger";

interface WebhookBody {
  content: string;
  url?: string;
  sourceType?: string;
}

/** Handle incoming webhook POST /webhook/:feedId */
export async function handleWebhook(feedId: string, body: WebhookBody, authToken: string): Promise<{ ok: boolean; error?: string }> {
  // Validate feed exists
  const feeds = await db.select().from(sourceFeed).where(eq(sourceFeed.id, feedId)).limit(1);
  const feed = feeds[0];
  if (!feed) return { ok: false, error: "Feed not found" };

  // Validate auth token
  const config = feed.config as Record<string, unknown> | null;
  const expectedToken = config?.webhookToken as string | undefined;
  if (expectedToken && expectedToken !== authToken) {
    return { ok: false, error: "Unauthorized" };
  }

  if (!body.content || typeof body.content !== "string") {
    return { ok: false, error: "content is required" };
  }

  // Ingest
  try {
    const input = parseStoreInput({
      raw: body.content,
      sources: body.url
        ? [{ url: body.url, sourceType: body.sourceType ?? "unknown" }]
        : undefined,
    });
    await ingest(input);
    logger.info({ feedId }, "webhook ingestion completed");
    return { ok: true };
  } catch (err) {
    logger.error({ feedId, error: (err as Error).message }, "webhook ingestion failed");
    return { ok: false, error: (err as Error).message };
  }
}
