import { ulid } from "ulid";
import { db } from "../db/connection";
import { claim, verifyQueue } from "../db/schema";
import { generateEmbedding } from "../ingest/embed";
import { logger } from "../observability/logger";
import type { ExtractedClaim } from "./extract";

export interface StoredClaim {
  id: string;
  type: string;
  verdict: string;
}

/**
 * Persist extracted claims for an entry. Factual claims are immediately
 * enqueued for Pyreez verification; subjective/predictive/normative go in
 * with verdict=not_applicable and never leave that state.
 */
export async function storeClaims(
  entryId: string,
  entryCreatedAt: Date,
  extracted: ExtractedClaim[],
  priority = 0,
): Promise<StoredClaim[]> {
  if (extracted.length === 0) return [];

  const stored: StoredClaim[] = [];

  for (const c of extracted) {
    const id = ulid();
    const embedding = await generateEmbedding(c.statement);
    const verdict = c.type === "factual" ? "unverified" : "not_applicable";

    await db.transaction(async (tx) => {
      await tx.insert(claim).values({
        id,
        entryId,
        entryCreatedAt,
        statement: c.statement,
        type: c.type,
        verdict,
        certainty: 0,
        embedding,
      });

      if (c.type === "factual") {
        await tx.insert(verifyQueue).values({
          claimId: id,
          priority,
        });
      }
    });

    stored.push({ id, type: c.type, verdict });
  }

  logger.info(
    {
      entryId,
      total: stored.length,
      factual: stored.filter((s) => s.type === "factual").length,
    },
    "claims stored",
  );

  return stored;
}
