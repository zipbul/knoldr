// claim_feedback MCP tool — claim-level structured feedback (v0.4).
//
// Distinct from the entry-level `feedback` skill. This one targets a
// specific claim (by ULID) and accepts the v0.4 structured shape:
// application_method × outcome × failure_dimension × counter-evidence.
// The reporter must declare HOW they applied the claim and what the
// outcome was; failure_dimension narrows partial truths to one of the
// five distortion categories established in the design.
//
// This pass records only. Authority / verdict state changes flow

import { eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { z } from 'zod';

import { getDb } from '../../db/connection';
import { claim, claimFeedback } from '../../db/schema';
import { logger } from '../../observability/logger';
import { ApplicationMethod, FailureDimension, Outcome } from '../../score/enums';
import { computeFeedbackEvidenceStrength } from '../../score/feedback-strength';

const claimFeedbackInputShape = {
  // Self-declared caller id for attribution (trusted ecosystem; no auth).
  agentId: z.string().min(1).max(100).optional(),
  // When set, the call updates an existing row instead of inserting
  // a new one. Used by reporters that learned more after their
  // initial submission. The row's reporter_agent_id must match.
  feedbackId: z.string().min(1).max(200).optional(),

  claimId: z.string().min(1).max(200),
  applicationMethod: z.enum(ApplicationMethod),
  outcome: z.enum(Outcome),

  failureDimension: z.enum(FailureDimension).optional(),
  partialTruth: z.number().min(0).max(1).optional(),
  contextDomain: z.string().max(100).optional(),
  contextTimeFrom: z.iso.datetime().optional(),
  contextTimeUntil: z.iso.datetime().optional(),
  contextScope: z.record(z.string(), z.unknown()).optional(),
  counterSourceUrl: z.url().max(2000).optional(),
  counterClaimText: z.string().max(2000).optional(),
  counterNliScore: z.number().min(0).max(1).optional(),
  auditNote: z.string().max(4000).optional(),
};

// Held outcomes can't carry a failure dimension — the claim worked
// as advertised. Failed/partial may but aren't required to.
const claimFeedbackInputSchema = z
  .object(claimFeedbackInputShape)
  .refine(v => !(v.outcome === Outcome.Held && v.failureDimension !== undefined), {
    message: `failureDimension must not be set when outcome='${Outcome.Held}'`,
    path: ['failureDimension'],
  });

type ClaimFeedbackInput = z.infer<typeof claimFeedbackInputSchema>;

type ClaimFeedbackResult =
  | {
      ok: true;
      feedbackId: string;
      claimId: string;
      evidenceStrength: number;
      updated: boolean;
    }
  | {
      ok: false;
      error: 'invalid_input' | 'claim_not_found' | 'feedback_not_found' | 'reporter_mismatch' | 'rate_limited';
      message: string;
      missingRequired?: string[];
    };

/**
 * Insert-path strength: delegates to the shared scorer with only
 * direct fields populated (inferred slots are always empty at the
 * point a brand-new feedback row is being inserted).
 */
function computeEvidenceStrength(input: ClaimFeedbackInput): number {
  return computeFeedbackEvidenceStrength({
    counterSourceUrl: input.counterSourceUrl ?? null,
    counterNliScore: input.counterNliScore ?? null,
    failureDimension: input.failureDimension ?? null,
    contextDomain: input.contextDomain ?? null,
    contextScope: input.contextScope ?? null,
    partialTruth: input.partialTruth ?? null,
  });
}

async function handleClaimFeedback(input: Record<string, unknown>, callerAgentId: string): Promise<ClaimFeedbackResult> {
  let validated: ClaimFeedbackInput;
  try {
    validated = claimFeedbackInputSchema.parse(input);
  } catch (err) {
    const zerr = err as z.ZodError;
    // zod v4 emits "Invalid input: expected ..., received undefined"
    // for missing fields. v4 ZodIssue doesn't expose a `received`
    // property (only `expected`/`message`/`code`/`path`), so message-
    // text matching is the only reliable signal. The earlier filter
    // checked an `i.received` that doesn't exist, which caused every
    // invalid_type — including wrong-shape inputs — to be classified
    // as missing. Now we restrict to issues whose message clearly
    // names "undefined" as the received value.
    const missing = zerr.issues
      ?.filter(i => {
        if (i.code !== 'invalid_type') {
          return false;
        }
        return typeof i.message === 'string' && /received\s+undefined/i.test(i.message);
      })
      .map(i => i.path.join('.'));
    return {
      ok: false,
      error: 'invalid_input',
      message: zerr.message,
      missingRequired: missing && missing.length > 0 ? missing : undefined,
    };
  }

  // Confirm the claim exists. FK would catch this at INSERT but
  // doing it up-front lets us return a clean error code rather
  // than a generic 500 from a constraint violation.
  const [claimRow] = await getDb().select({ id: claim.id }).from(claim).where(eq(claim.id, validated.claimId)).limit(1);

  if (!claimRow) {
    return {
      ok: false,
      error: 'claim_not_found',
      message: `claim ${validated.claimId} does not exist`,
    };
  }

  // Update mode: an existing row owned by this reporter gets its
  // NULL direct fields filled. Set fields are preserved — a reporter
  // cannot overwrite their own past direct answers. Strength + status
  // are recomputed off the merged view.
  if (validated.feedbackId) {
    return await updateExistingFeedback(validated, callerAgentId);
  }

  const evidenceStrength = computeEvidenceStrength(validated);

  const feedbackId = ulid();

  // Rate limits mirror entry-level feedback (score/feedback.ts): they
  // guard the authority EMA against runaway agent loops, not attackers.
  // 1 insert per agent+claim per hour; 10 inserts per claim per hour.
  const [limits] = (await getDb().execute(sql`
    SELECT
      count(*) FILTER (WHERE reporter_agent_id = ${callerAgentId})::int AS by_agent,
      count(*)::int AS by_claim
    FROM claim_feedback
    WHERE claim_id = ${validated.claimId}
      AND created_at > NOW() - INTERVAL '1 hour'
  `)) as unknown as Array<{ by_agent: number; by_claim: number }>;
  if ((limits?.by_agent ?? 0) >= 1) {
    return { ok: false, error: 'rate_limited', message: 'same agent+claim feedback limited to 1 per hour' };
  }
  if ((limits?.by_claim ?? 0) >= 10) {
    return { ok: false, error: 'rate_limited', message: 'claim feedback limited to 10 per hour' };
  }

  // Both mutations (feedback row, claim authority) happen inside one
  // transaction so a failure can't move authority for a row that
  // never persisted.
  await getDb().transaction(async tx => {
    await tx.insert(claimFeedback).values({
      id: feedbackId,
      claimId: validated.claimId,
      reporterAgentId: callerAgentId,
      applicationMethod: validated.applicationMethod,
      outcome: validated.outcome,
      failureDimension: validated.failureDimension ?? null,
      partialTruth: validated.partialTruth ?? null,
      contextDomain: validated.contextDomain ?? null,
      contextTimeFrom: validated.contextTimeFrom ? new Date(validated.contextTimeFrom) : null,
      contextTimeUntil: validated.contextTimeUntil ? new Date(validated.contextTimeUntil) : null,
      contextScope: validated.contextScope ?? null,
      counterSourceUrl: validated.counterSourceUrl ?? null,
      counterClaimText: validated.counterClaimText ?? null,
      counterNliScore: validated.counterNliScore ?? null,
      auditNote: validated.auditNote ?? null,
      evidenceStrength,
    });

    await adjustClaimAuthorityTx(tx, validated.claimId, evidenceStrength, validated.outcome);
  });

  logger.info(
    {
      feedbackId,
      claimId: validated.claimId,
      reporter: callerAgentId,
      outcome: validated.outcome,
      evidenceStrength,
    },
    'claim_feedback recorded',
  );

  return {
    ok: true,
    feedbackId,
    claimId: validated.claimId,
    evidenceStrength,
    updated: false,
  };
}

async function updateExistingFeedback(input: ClaimFeedbackInput, callerAgentId: string): Promise<ClaimFeedbackResult> {
  const [row] = await getDb()
    .select({
      id: claimFeedback.id,
      claimId: claimFeedback.claimId,
      reporterAgentId: claimFeedback.reporterAgentId,
      outcome: claimFeedback.outcome,
      evidenceStrength: claimFeedback.evidenceStrength,
      failureDimension: claimFeedback.failureDimension,
      partialTruth: claimFeedback.partialTruth,
      counterSourceUrl: claimFeedback.counterSourceUrl,
      counterClaimText: claimFeedback.counterClaimText,
      counterNliScore: claimFeedback.counterNliScore,
      contextDomain: claimFeedback.contextDomain,
      contextScope: claimFeedback.contextScope,
    })
    .from(claimFeedback)
    .where(eq(claimFeedback.id, input.feedbackId!))
    .limit(1);

  if (!row) {
    return {
      ok: false,
      error: 'feedback_not_found',
      message: `feedback ${input.feedbackId} does not exist`,
    };
  }
  if (row.reporterAgentId !== callerAgentId) {
    return {
      ok: false,
      error: 'reporter_mismatch',
      message: 'feedbackId belongs to a different reporter',
    };
  }
  // Defense against a reporter sending feedbackId for claim A with
  // claimId for claim B — without this check the row updates with
  // claim A's data but the authority delta lands on claim B.
  if (row.claimId !== input.claimId) {
    return {
      ok: false,
      error: 'reporter_mismatch',
      message: "claimId does not match the feedback row's recorded claim",
    };
  }
  // The stored outcome is immutable for authority direction; allowing
  // a reporter to switch outcome on update would let them flip the
  // sign of the EMA adjustment retroactively. We use row.outcome (the
  // truth at submit time) regardless of what input.outcome says.
  const effectiveOutcome = row.outcome as Outcome;

  // Fill NULL direct fields only; preserve set values so a reporter
  // can't rewrite their own history.
  const merged = {
    failureDimension: row.failureDimension ?? input.failureDimension ?? null,
    partialTruth: row.partialTruth ?? input.partialTruth ?? null,
    counterSourceUrl: row.counterSourceUrl ?? input.counterSourceUrl ?? null,
    counterClaimText: row.counterClaimText ?? input.counterClaimText ?? null,
    counterNliScore: row.counterNliScore ?? input.counterNliScore ?? null,
  };

  // Recompute strength from the merged direct fields.
  const newStrength = computeFeedbackEvidenceStrength({
    counterSourceUrl: merged.counterSourceUrl,
    counterNliScore: merged.counterNliScore,
    failureDimension: merged.failureDimension,
    contextDomain: row.contextDomain,
    contextScope: row.contextScope && typeof row.contextScope === 'object' ? (row.contextScope as Record<string, unknown>) : null,
    partialTruth: merged.partialTruth,
  });

  // Both writes inside one transaction: feedback row update and
  // claim authority adjustment commit together or not at all.
  // Without this a successful row update followed by a failed
  // authority adjust leaves the row's evidenceStrength advanced
  // but no matching authority movement — silent drift over time.
  const strengthDelta = newStrength - row.evidenceStrength;
  await getDb().transaction(async tx => {
    await tx
      .update(claimFeedback)
      .set({
        failureDimension: merged.failureDimension,
        partialTruth: merged.partialTruth,
        counterSourceUrl: merged.counterSourceUrl,
        counterClaimText: merged.counterClaimText,
        counterNliScore: merged.counterNliScore,
        evidenceStrength: newStrength,
      })
      .where(eq(claimFeedback.id, row.id));

    if (strengthDelta !== 0) {
      await adjustClaimAuthorityTx(tx, row.claimId, strengthDelta, effectiveOutcome);
    }
  });

  logger.info(
    {
      feedbackId: row.id,
      claimId: input.claimId,
      reporter: callerAgentId,
      newStrength,
    },
    'claim_feedback updated by reporter',
  );

  return {
    ok: true,
    feedbackId: row.id,
    claimId: input.claimId,
    evidenceStrength: newStrength,
    updated: true,
  };
}

/**
 * Move `claim.authority` based on a fresh feedback row. Held →
 * gentle bump up; failed/partial → gentle bump down. Magnitude is
 * bounded by evidence_strength × LEARNING_RATE so a single noisy
 * signal can't whiplash the score. Clamped to [0,1] at the SQL
 * level so concurrent updates stay safe.
 */
const FEEDBACK_LEARNING_RATE = 0.05;

// `executor` covers both the top-level db and a drizzle transaction
// handle. We type loosely so callers from a `getDb().transaction(tx => ...)`
// callback can pass `tx` directly without TS complaining about the
// `$client` property that lives only on the top-level instance.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AuthorityExecutor = any;

async function adjustClaimAuthorityTx(
  executor: AuthorityExecutor,
  claimId: string,
  strengthDelta: number,
  outcome: Outcome,
): Promise<void> {
  if (strengthDelta === 0) {
    return;
  }

  const sign = outcome === Outcome.Held ? 1 : -1;
  const delta = sign * strengthDelta * FEEDBACK_LEARNING_RATE;
  if (delta === 0) {
    return;
  }

  await executor.execute(sql`
    UPDATE claim
    SET authority = GREATEST(0::double precision,
                             LEAST(1::double precision, authority + ${delta}))
    WHERE id = ${claimId}
  `);
}

export { handleClaimFeedback, claimFeedbackInputShape };
