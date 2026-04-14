import { eq, or, sql, desc } from "drizzle-orm";
import { db } from "../db/connection";
import { entity, kgRelation } from "../db/schema";
import { generateEmbedding } from "../ingest/embed";

export interface EntityRow {
  id: string;
  name: string;
  type: string;
}

export interface Neighbor {
  entity: EntityRow;
  relationType: string;
  direction: "out" | "in";
  weight: number;
  claimId: string | null;
}

/** Find entities whose name or aliases match the given query string. */
export async function findEntitiesByName(
  nameLike: string,
  limit = 5,
): Promise<EntityRow[]> {
  const pattern = `%${nameLike.trim()}%`;
  const rows = await db
    .select({ id: entity.id, name: entity.name, type: entity.type })
    .from(entity)
    .where(
      or(
        sql`lower(${entity.name}) LIKE lower(${pattern})`,
        sql`EXISTS (SELECT 1 FROM unnest(${entity.aliases}) a WHERE lower(a) LIKE lower(${pattern}))`,
      ),
    )
    .limit(limit);
  return rows;
}

/** Semantic entity lookup via embedding cosine similarity. */
export async function findEntitiesBySemantic(
  text: string,
  limit = 5,
  minSimilarity = 0.7,
): Promise<Array<EntityRow & { similarity: number }>> {
  const vec = await generateEmbedding(text);
  const rows = await db.execute(sql`
    SELECT id, name, type,
           1 - (embedding <=> ${`[${vec.join(",")}]`}::vector) AS similarity
    FROM entity
    WHERE 1 - (embedding <=> ${`[${vec.join(",")}]`}::vector) >= ${minSimilarity}
    ORDER BY embedding <=> ${`[${vec.join(",")}]`}::vector
    LIMIT ${limit}
  `);
  return rows as unknown as Array<EntityRow & { similarity: number }>;
}

/** 1-hop neighbors of an entity (both outgoing and incoming edges). */
export async function getNeighbors(
  entityId: string,
  limit = 20,
): Promise<Neighbor[]> {
  const out = await db
    .select({
      id: entity.id,
      name: entity.name,
      type: entity.type,
      relationType: kgRelation.relationType,
      weight: kgRelation.weight,
      claimId: kgRelation.claimId,
    })
    .from(kgRelation)
    .innerJoin(entity, eq(kgRelation.targetEntityId, entity.id))
    .where(eq(kgRelation.sourceEntityId, entityId))
    .orderBy(desc(kgRelation.weight))
    .limit(limit);

  const incoming = await db
    .select({
      id: entity.id,
      name: entity.name,
      type: entity.type,
      relationType: kgRelation.relationType,
      weight: kgRelation.weight,
      claimId: kgRelation.claimId,
    })
    .from(kgRelation)
    .innerJoin(entity, eq(kgRelation.sourceEntityId, entity.id))
    .where(eq(kgRelation.targetEntityId, entityId))
    .orderBy(desc(kgRelation.weight))
    .limit(limit);

  const outNeighbors: Neighbor[] = out.map((r) => ({
    entity: { id: r.id, name: r.name, type: r.type },
    relationType: r.relationType,
    direction: "out",
    weight: r.weight,
    claimId: r.claimId,
  }));
  const inNeighbors: Neighbor[] = incoming.map((r) => ({
    entity: { id: r.id, name: r.name, type: r.type },
    relationType: r.relationType,
    direction: "in",
    weight: r.weight,
    claimId: r.claimId,
  }));

  return [...outNeighbors, ...inNeighbors].slice(0, limit);
}

/** How many edges touch this entity (in both directions). */
export async function getEntityDegree(entityId: string): Promise<number> {
  const [row] = await db
    .select({ cnt: sql<number>`COUNT(*)::int` })
    .from(kgRelation)
    .where(
      or(
        eq(kgRelation.sourceEntityId, entityId),
        eq(kgRelation.targetEntityId, entityId),
      ),
    );
  return row?.cnt ?? 0;
}

