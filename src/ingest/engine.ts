import { ulid } from "ulid";
import { db } from "../db/connection";
import { entry, entryDomain, entryTag, entrySource, ingestLog } from "../db/schema";
import { decompose, detectLanguage } from "./decompose";
import { buildEmbeddingInput, generateEmbedding } from "./embed";
import { isDuplicate } from "./dedup";
import { calculateAuthority, getSourceTrust } from "../score/authority";
import { enqueueRetry } from "../collect/retry";
import { decodeUlidTimestamp } from "../lib/ulid-utils";
import { ingestionTotal, ingestionLatency } from "../observability/metrics";
import {
  type StoreInput,
  type Source,
  type SourceMetadata,
  type StructuredEntry,
  isRawInput,
  stripHtml,
} from "./validate";
import { logger } from "../observability/logger";

export interface IngestResult {
  entryId: string;
  authority: number;
  decayRate: number;
  action: "stored" | "duplicate" | "rejected";
  reason?: string;
}

/**
 * Main ingestion engine. Accepts both raw (Mode 1) and structured (Mode 2) inputs.
 */
export async function ingest(input: StoreInput): Promise<IngestResult[]> {
  const timer = ingestionLatency.startTimer();
  const sources: Source[] = input.sources ?? [];
  const sourceMetadata: SourceMetadata | undefined = isRawInput(input)
    ? input.sourceMetadata
    : undefined;
  const results: IngestResult[] = [];

  let decomposedEntries: StructuredEntry[];

  if (isRawInput(input)) {
    // Mode 1: raw → LLM decompose
    logger.info("ingesting raw input, calling LLM decompose");
    try {
      const response = await decompose(stripHtml(input.raw));
      decomposedEntries = response.entries;
    } catch (err) {
      const errorMsg = (err as Error).message;
      logger.error({ error: errorMsg }, "decompose failed, enqueuing for retry");

      // Log as rejected
      await db.insert(ingestLog).values({
        id: ulid(),
        action: "rejected",
        reason: `decompose_failed: ${errorMsg}`,
      });

      // Enqueue for retry
      await enqueueRetry(
        input.raw,
        sources[0]?.url,
        `decompose_parse_error: ${errorMsg}`,
      );

      return [{ entryId: "", authority: 0, decayRate: 0, action: "rejected", reason: errorMsg }];
    }

    // Handle empty entries (LLM returned nothing useful)
    if (decomposedEntries.length === 0) {
      await db.insert(ingestLog).values({
        id: ulid(),
        action: "rejected",
        reason: "no_entries_extracted",
      });
      return [{ entryId: "", authority: 0, decayRate: 0, action: "rejected", reason: "no_entries_extracted" }];
    }
  } else {
    // Mode 2: structured → skip decompose
    logger.info({ count: input.entries.length }, "ingesting structured input");
    decomposedEntries = input.entries;
  }

  // Process each entry through the pipeline
  for (const decomposed of decomposedEntries) {
    try {
      const result = await processEntry(decomposed, sources, sourceMetadata);
      results.push(result);
    } catch (err) {
      const errorMsg = (err as Error).message;
      logger.error({ error: errorMsg, title: decomposed.title }, "entry processing failed");
      results.push({ entryId: "", authority: 0, decayRate: 0, action: "rejected", reason: errorMsg });
    }
  }

  // Record metrics
  timer();
  for (const r of results) {
    ingestionTotal.inc({ action: r.action });
  }

  return results;
}

async function processEntry(
  decomposed: StructuredEntry,
  sources: Source[],
  sourceMetadata: SourceMetadata | undefined,
): Promise<IngestResult> {
  const id = ulid();
  const createdAt = new Date(decodeUlidTimestamp(id));
  const title = stripHtml(decomposed.title);
  const content = stripHtml(decomposed.content);
  const domains = decomposed.domain;
  const tags = decomposed.tags ?? [];
  const language = decomposed.language ?? (await detectLanguage(content));
  const decayRate = decomposed.decayRate ?? 0.01;
  const mergedMetadata: Record<string, unknown> | null = mergeMetadata(
    decomposed.metadata,
    sourceMetadata,
  );

  // Step 3: Generate embedding
  const embeddingText = buildEmbeddingInput(title, content);
  const embedding = await generateEmbedding(embeddingText);

  // Step 4: Semantic dedup
  const duplicate = await isDuplicate(embedding);
  if (duplicate) {
    await db.insert(ingestLog).values({
      id: ulid(),
      entryId: id,
      entryCreatedAt: createdAt,
      action: "duplicate",
      reason: "semantic similarity > 0.95",
    });
    return { entryId: id, authority: 0, decayRate, action: "duplicate" };
  }

  // Step 5: Authority score (rule-based)
  const authority = calculateAuthority(sources);

  // Step 6: DB transaction
  await db.transaction(async (tx) => {
    await tx.insert(entry).values({
      id,
      title,
      content,
      language,
      metadata: mergedMetadata,
      authority,
      decayRate,
      status: "active",
      createdAt,
      embedding,
    });

    if (domains.length > 0) {
      await tx.insert(entryDomain).values(
        domains.map((d) => ({
          entryId: id,
          entryCreatedAt: createdAt,
          domain: d,
        })),
      );
    }

    if (tags.length > 0) {
      await tx.insert(entryTag).values(
        tags.map((t) => ({
          entryId: id,
          entryCreatedAt: createdAt,
          tag: t,
        })),
      );
    }

    if (sources.length > 0) {
      await tx.insert(entrySource).values(
        sources.map((s) => ({
          entryId: id,
          entryCreatedAt: createdAt,
          url: s.url,
          sourceType: s.sourceType,
          trust: getSourceTrust(s.sourceType),
        })),
      );
    }

    await tx.insert(ingestLog).values({
      id: ulid(),
      entryId: id,
      entryCreatedAt: createdAt,
      action: "stored",
    });
  });

  logger.info({ entryId: id, authority, decayRate, domains }, "entry stored");

  return { entryId: id, authority, decayRate, action: "stored" };
}

function mergeMetadata(
  decomposedMetadata: Record<string, unknown> | undefined,
  sourceMetadata: SourceMetadata | undefined,
): Record<string, unknown> | null {
  const merged: Record<string, unknown> = { ...(decomposedMetadata ?? {}) };
  if (sourceMetadata?.publishedAt) merged.publishedAt = sourceMetadata.publishedAt;
  if (sourceMetadata?.siteName) merged.siteName = sourceMetadata.siteName;
  if (sourceMetadata?.author) merged.author = sourceMetadata.author;
  return Object.keys(merged).length > 0 ? merged : null;
}
