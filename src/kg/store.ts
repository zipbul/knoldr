import { ulid } from "ulid";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/connection";
import { entity, kgRelation } from "../db/schema";
import { generateEmbedding } from "../ingest/embed";
import { logger } from "../observability/logger";
import type { ExtractedTriple } from "./extract";

/**
 * Upsert an entity by (type, lower(name)). Aliases accumulate if the same
 * underlying entity appears under a different spelling.
 */
export async function upsertEntity(
  name: string,
  type: string,
): Promise<string> {
  const normName = name.trim();
  const normType = type.trim().toLowerCase();

  const [existing] = await db
    .select({ id: entity.id, aliases: entity.aliases })
    .from(entity)
    .where(
      and(
        eq(entity.type, normType),
        sql`lower(${entity.name}) = lower(${normName})`,
      ),
    )
    .limit(1);

  if (existing) return existing.id;

  // Fuzzy merge: same type, high-cosine embedding match → same entity
  const vec = await generateEmbedding(`${normType}: ${normName}`);
  const fuzzy = await db.execute(sql`
    SELECT id, aliases FROM entity
    WHERE type = ${normType}
      AND 1 - (embedding <=> ${`[${vec.join(",")}]`}::vector) >= 0.9
    ORDER BY embedding <=> ${`[${vec.join(",")}]`}::vector
    LIMIT 1
  `);

  const fuzzyRow = (fuzzy as unknown as Array<{ id: string; aliases: string[] }>)[0];
  if (fuzzyRow) {
    if (!fuzzyRow.aliases.map((a) => a.toLowerCase()).includes(normName.toLowerCase())) {
      await db
        .update(entity)
        .set({ aliases: sql`array_append(${entity.aliases}, ${normName})` })
        .where(eq(entity.id, fuzzyRow.id));
    }
    return fuzzyRow.id;
  }

  const id = ulid();
  await db.insert(entity).values({
    id,
    name: normName,
    type: normType,
    embedding: vec,
  });
  return id;
}

/**
 * Store extracted triples as entity + kg_relation rows. Idempotent on
 * the (source, target, relation_type, claim_id) unique index.
 */
export async function storeTriples(
  claimId: string,
  triples: ExtractedTriple[],
  weight = 0.8,
): Promise<number> {
  if (triples.length === 0) return 0;

  let stored = 0;
  for (const t of triples) {
    try {
      const sourceId = await upsertEntity(t.subject.name, t.subject.type);
      const targetId = await upsertEntity(t.object.name, t.object.type);
      if (sourceId === targetId) continue;

      await db
        .insert(kgRelation)
        .values({
          id: ulid(),
          sourceEntityId: sourceId,
          targetEntityId: targetId,
          relationType: t.predicate.trim().toLowerCase(),
          claimId,
          weight,
        })
        .onConflictDoNothing({
          target: [
            kgRelation.sourceEntityId,
            kgRelation.targetEntityId,
            kgRelation.relationType,
            kgRelation.claimId,
          ],
        });
      stored++;
    } catch (err) {
      logger.warn(
        { claimId, triple: t, error: (err as Error).message },
        "triple store failed",
      );
    }
  }

  if (stored > 0) {
    logger.info({ claimId, triples: stored }, "KG triples stored");
  }
  return stored;
}
