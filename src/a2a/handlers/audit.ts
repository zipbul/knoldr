import { db } from "../../db/connection";
import { entry, entryDomain, ingestLog } from "../../db/schema";
import { count, eq, and, gt, sql } from "drizzle-orm";
import { auditInputSchema } from "../../ingest/validate";

export async function handleAudit(input: Record<string, unknown>) {
  const validated = auditInputSchema.parse(input);
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [totalEntries, activeEntries, avgAuthority, stored, duplicate, rejected, domainDist] =
    await Promise.all([
      db.select({ cnt: count() }).from(entry),
      db.select({ cnt: count() }).from(entry).where(eq(entry.status, "active")),
      db
        .select({ avg: sql<number>`COALESCE(AVG(${entry.authority}), 0)` })
        .from(entry)
        .where(eq(entry.status, "active")),
      db
        .select({ cnt: count() })
        .from(ingestLog)
        .where(and(eq(ingestLog.action, "stored"), gt(ingestLog.ingestedAt, oneDayAgo))),
      db
        .select({ cnt: count() })
        .from(ingestLog)
        .where(and(eq(ingestLog.action, "duplicate"), gt(ingestLog.ingestedAt, oneDayAgo))),
      db
        .select({ cnt: count() })
        .from(ingestLog)
        .where(and(eq(ingestLog.action, "rejected"), gt(ingestLog.ingestedAt, oneDayAgo))),
      db
        .select({ domain: entryDomain.domain, cnt: count() })
        .from(entryDomain)
        .groupBy(entryDomain.domain)
        .orderBy(sql`count(*) DESC`)
        .limit(20),
    ]);

  return {
    totalEntries: totalEntries[0]?.cnt ?? 0,
    activeEntries: activeEntries[0]?.cnt ?? 0,
    avgAuthority: Number((avgAuthority[0]?.avg ?? 0).toFixed(3)),
    ingestion: {
      last24h: {
        stored: stored[0]?.cnt ?? 0,
        duplicate: duplicate[0]?.cnt ?? 0,
        rejected: rejected[0]?.cnt ?? 0,
      },
    },
    domainDistribution: Object.fromEntries(domainDist.map((d) => [d.domain, d.cnt])),
  };
}
