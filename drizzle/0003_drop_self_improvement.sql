-- Data+schema migration: remove the unproven self-improvement layer.
--
-- Deleted features (owner decision): FQA enrichment (LLM analysis of
-- feedback notes — no consumer), auto-calibration (tuned NLI thresholds
-- against the pipeline's own verdicts — circular), reporter
-- authority learning (per-agent trust EMA — scale overkill for a
-- trusted ecosystem), smoke-eval (redundant with the golden eval),
-- finetune sidecar (unmeasured benefit).
--
-- 0000 still CREATEs these objects (frozen baseline; 0001's enum
-- rewrites touch enrichment_status), so a fresh install creates-then-
-- drops — idempotent and cheap.

DROP TABLE IF EXISTS "agent_feedback_authority";
--> statement-breakpoint
DROP TABLE IF EXISTS "calibration_state";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_claim_feedback_enrichment_status";
--> statement-breakpoint
ALTER TABLE "claim_feedback" DROP CONSTRAINT IF EXISTS "claim_feedback_failure_dimension_inferred_values";
--> statement-breakpoint
ALTER TABLE "claim_feedback" DROP CONSTRAINT IF EXISTS "claim_feedback_partial_truth_inferred_range";
--> statement-breakpoint
ALTER TABLE "claim_feedback" DROP CONSTRAINT IF EXISTS "claim_feedback_enrichment_status_values";
--> statement-breakpoint
ALTER TABLE "claim_feedback" DROP CONSTRAINT IF EXISTS "claim_feedback_reporter_responded_values";
--> statement-breakpoint
ALTER TABLE "claim_feedback" DROP COLUMN IF EXISTS "failure_dimension_inferred";
--> statement-breakpoint
ALTER TABLE "claim_feedback" DROP COLUMN IF EXISTS "partial_truth_inferred";
--> statement-breakpoint
ALTER TABLE "claim_feedback" DROP COLUMN IF EXISTS "counter_source_url_inferred";
--> statement-breakpoint
ALTER TABLE "claim_feedback" DROP COLUMN IF EXISTS "enriched_at";
--> statement-breakpoint
ALTER TABLE "claim_feedback" DROP COLUMN IF EXISTS "enriched_by";
--> statement-breakpoint
ALTER TABLE "claim_feedback" DROP COLUMN IF EXISTS "enrichment_llm_version";
--> statement-breakpoint
ALTER TABLE "claim_feedback" DROP COLUMN IF EXISTS "reporter_responded";
--> statement-breakpoint
ALTER TABLE "claim_feedback" DROP COLUMN IF EXISTS "enrichment_status";
--> statement-breakpoint
ALTER TABLE "entry_score" DROP CONSTRAINT IF EXISTS "entry_score_dimension_values";
--> statement-breakpoint
ALTER TABLE "entry_score" ADD CONSTRAINT "entry_score_dimension_values" CHECK ("dimension" IN ('factuality'));
