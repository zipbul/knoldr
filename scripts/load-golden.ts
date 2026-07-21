// Loader for the golden-set evaluation corpus.
//
// Reads a JSON file of labelled claims and upserts them into
// `golden_set_claim` — the table `runGoldenEval` (src/eval/golden.ts)
// reads. Until this corpus exists the evaluator is a no-op, which is
// why labelled measurement of the verify pipeline has been dormant.
//
// The file is the single source of truth: rows present are upserted and
// activated; rows absent are DEACTIVATED (active=0), never deleted, so
// historical golden_set_run results stay interpretable.
//
//   bun run eval:load            # loads eval/golden-set.json
//   bun run scripts/load-golden.ts path/to/other.json

import { notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import { getDb } from '../src/db/connection';
import { goldenSetClaim } from '../src/db/schema';
import { logger } from '../src/observability/logger';
import { ClaimType, Verdict } from '../src/score/enums';

const itemSchema = z.object({
  id: z.string().min(1).max(200),
  statement: z.string().min(1).max(2000),
  claimType: z.enum(ClaimType),
  expectedVerdict: z.enum(Verdict),
  domain: z.string().max(100).optional(),
  sourceHint: z.string().max(500).optional(),
  sourceUrls: z.array(z.url()).max(20).optional(),
  labeledBy: z.string().min(1).max(100),
  notes: z.string().max(2000).optional(),
  active: z.boolean().optional(),
});
const fileSchema = z.array(itemSchema).min(1);

async function main(): Promise<void> {
  const path = process.argv[2] ?? 'eval/golden-set.json';
  if (!(await Bun.file(path).exists())) {
    console.error(`golden-set file not found: ${path}`);
    process.exit(1);
  }

  let items: z.infer<typeof fileSchema>;
  try {
    items = fileSchema.parse(JSON.parse(await Bun.file(path).text()));
  } catch (err) {
    console.error(`invalid golden-set file (${path}): ${(err as Error).message}`);
    process.exit(1);
  }

  const ids = items.map(i => i.id);
  if (new Set(ids).size !== ids.length) {
    console.error('duplicate ids in golden-set file');
    process.exit(1);
  }

  // Strict grounding: Verified requires >=1 successful cited-source
  // grounding — a row labelled 'verified' with no sourceUrls is
  // permanently unwinnable and would silently drag F1 down forever.
  const unwinnable = items.filter(i => i.expectedVerdict === Verdict.Verified && (!i.sourceUrls || i.sourceUrls.length === 0));
  if (unwinnable.length > 0) {
    console.error(`rows labelled 'verified' MUST carry sourceUrls (strict grounding): ${unwinnable.map(i => i.id).join(', ')}`);
    process.exit(1);
  }

  const db = getDb();
  await db.transaction(async tx => {
    for (const it of items) {
      const row = {
        id: it.id,
        statement: it.statement,
        claimType: it.claimType,
        expectedVerdict: it.expectedVerdict,
        domain: it.domain ?? null,
        sourceHint: it.sourceHint ?? null,
        sourceUrls: it.sourceUrls ?? null,
        labeledBy: it.labeledBy,
        notes: it.notes ?? null,
        active: it.active === false ? 0 : 1,
      };
      await tx
        .insert(goldenSetClaim)
        .values(row)
        .onConflictDoUpdate({
          target: goldenSetClaim.id,
          set: {
            statement: row.statement,
            claimType: row.claimType,
            expectedVerdict: row.expectedVerdict,
            domain: row.domain,
            sourceHint: row.sourceHint,
            sourceUrls: row.sourceUrls,
            labeledBy: row.labeledBy,
            notes: row.notes,
            active: row.active,
          },
        });
    }
    // File is source of truth: deactivate any labelled row not in the file.
    const deactivated = await tx
      .update(goldenSetClaim)
      .set({ active: 0 })
      .where(notInArray(goldenSetClaim.id, ids))
      .returning({ id: goldenSetClaim.id });
    if (deactivated.length > 0) {
      logger.info({ deactivated: deactivated.length }, 'deactivated golden rows absent from file');
    }
  });

  const [counts] = await db
    .select({ active: sql<number>`count(*) FILTER (WHERE active = 1)::int`, total: sql<number>`count(*)::int` })
    .from(goldenSetClaim);

  console.log(`loaded ${items.length} claim(s) from ${path}`);
  console.log(`golden_set_claim now has ${counts?.active ?? 0} active / ${counts?.total ?? 0} total`);
  console.log('next: run the evaluator on a real-model knoldr environment →  bun run eval:golden');
  process.exit(0);
}

try {
  await main();
} catch (err) {
  logger.error({ err: (err as Error).message }, 'golden-set load failed');
  console.error(`load failed: ${(err as Error).message}`);
  process.exit(2);
}
