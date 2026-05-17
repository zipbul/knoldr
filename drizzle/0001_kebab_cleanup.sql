-- Snake → kebab data migration + bind the kebab CHECK whitelist.
--
-- Pre-v0.4 deployments stored enum values as snake_case
-- (e.g. 'not_applicable', 'official_docs'). The enum module is now
-- kebab-case. On fresh installs `0000_init.sql` already attached
-- every named *_values CHECK inline at CREATE TABLE, so this file's
-- UPDATEs match zero rows, the auto-named CHECK sweep matches
-- nothing, and the ADD CONSTRAINT statements are no-ops via
-- `IF NOT EXISTS`. On legacy installs `0000_init.sql`'s CREATE TABLE
-- was skipped, leaving the tables WITHOUT named *_values CHECKs;
-- this file rewrites every legacy snake row, drops any inline
-- auto-named CHECK still carrying snake values, then adds the
-- named CHECKs the rest of the codebase counts on.

-- 1. Drop pre-v0.4 auto-named `_check` siblings whose body still
--    carries snake values. Doing this BEFORE the UPDATEs means the
--    UPDATE statements don't fight the old CHECK definitions row-
--    by-row.
DO $$
DECLARE _r RECORD;
BEGIN
  FOR _r IN
    SELECT c.conname AS cname, t.relname AS tname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname IN ('claim','verdict_log','claim_relation','claim_feedback','golden_set_claim','entry_source')
      AND c.contype = 'c'
      AND c.conname LIKE '%_check'
      AND pg_get_constraintdef(c.oid) ~* '(not_applicable|derives_from|superseded_by|reasoned_over|fully_false|scope_too_broad|time_expired|modality_too_strong|context_mismatch|partially_correct|finalized_inferred|awaiting_pull|expired_reporter_unavailable|skipped_backpressure|not_needed|awaiting_reporter_push|official_docs|github_release|cve_db|official_blog|research_paper|established_blog|community_forum|personal_blog|ai_generated|reference_wiki)'
  LOOP
    EXECUTE 'ALTER TABLE ' || quote_ident(_r.tname) || ' DROP CONSTRAINT ' || quote_ident(_r.cname);
  END LOOP;
END $$;
--> statement-breakpoint

-- 2. Data migration. Single-statement UPDATEs land every enum
--    column on a row simultaneously so a row never sits in a
--    mixed snake/kebab state mid-migration.
UPDATE "claim" SET "verdict" = 'not-applicable' WHERE "verdict" = 'not_applicable';
--> statement-breakpoint
UPDATE "verdict_log" SET "verdict" = 'not-applicable' WHERE "verdict" = 'not_applicable';
--> statement-breakpoint
UPDATE "golden_set_claim" SET "expected_verdict" = 'not-applicable' WHERE "expected_verdict" = 'not_applicable';
--> statement-breakpoint
UPDATE "claim_relation" SET "relation_type" = 'derives-from' WHERE "relation_type" = 'derives_from';
--> statement-breakpoint
UPDATE "claim_relation" SET "relation_type" = 'superseded-by' WHERE "relation_type" = 'superseded_by';
--> statement-breakpoint

-- claim_feedback rewrites all four enum columns in one UPDATE so
-- a row never carries a mix of snake + kebab between statements.
UPDATE "claim_feedback" SET
  "application_method" = CASE "application_method"
    WHEN 'reasoned_over' THEN 'reasoned-over'
    ELSE "application_method"
  END,
  "failure_dimension" = CASE "failure_dimension"
    WHEN 'fully_false'         THEN 'fully-false'
    WHEN 'scope_too_broad'     THEN 'scope-too-broad'
    WHEN 'time_expired'        THEN 'time-expired'
    WHEN 'modality_too_strong' THEN 'modality-too-strong'
    WHEN 'context_mismatch'    THEN 'context-mismatch'
    WHEN 'partially_correct'   THEN 'partially-correct'
    ELSE "failure_dimension"
  END,
  "failure_dimension_inferred" = CASE "failure_dimension_inferred"
    WHEN 'fully_false'         THEN 'fully-false'
    WHEN 'scope_too_broad'     THEN 'scope-too-broad'
    WHEN 'time_expired'        THEN 'time-expired'
    WHEN 'modality_too_strong' THEN 'modality-too-strong'
    WHEN 'context_mismatch'    THEN 'context-mismatch'
    WHEN 'partially_correct'   THEN 'partially-correct'
    ELSE "failure_dimension_inferred"
  END,
  "enrichment_status" = CASE "enrichment_status"
    WHEN 'finalized_inferred'           THEN 'finalized-inferred'
    WHEN 'awaiting_pull'                THEN 'awaiting-pull'
    WHEN 'expired_reporter_unavailable' THEN 'expired-reporter-unavailable'
    WHEN 'skipped_backpressure'         THEN 'skipped-backpressure'
    WHEN 'not_needed'                   THEN 'not-needed'
    -- `awaiting_reporter_push` was retired entirely (push channel removed)
    WHEN 'awaiting_reporter_push'       THEN 'awaiting-pull'
    ELSE "enrichment_status"
  END
WHERE "application_method" = 'reasoned_over'
   OR "failure_dimension" IN ('fully_false','scope_too_broad','time_expired','modality_too_strong','context_mismatch','partially_correct')
   OR "failure_dimension_inferred" IN ('fully_false','scope_too_broad','time_expired','modality_too_strong','context_mismatch','partially_correct')
   OR "enrichment_status" IN ('finalized_inferred','awaiting_pull','expired_reporter_unavailable','skipped_backpressure','not_needed','awaiting_reporter_push');
--> statement-breakpoint

UPDATE "entry_source" SET "source_type" = CASE "source_type"
  WHEN 'official_docs'    THEN 'official-docs'
  WHEN 'github_release'   THEN 'github-release'
  WHEN 'cve_db'           THEN 'cve-db'
  WHEN 'official_blog'    THEN 'official-blog'
  WHEN 'research_paper'   THEN 'research-paper'
  WHEN 'established_blog' THEN 'established-blog'
  WHEN 'community_forum'  THEN 'community-forum'
  WHEN 'personal_blog'    THEN 'personal-blog'
  WHEN 'ai_generated'     THEN 'ai-generated'
  WHEN 'reference_wiki'   THEN 'reference-wiki'
  ELSE "source_type"
END
WHERE "source_type" IN (
  'official_docs','github_release','cve_db','official_blog','research_paper',
  'established_blog','community_forum','personal_blog','ai_generated','reference_wiki'
);
--> statement-breakpoint

-- 3. Attach every named *_values CHECK. Fresh installs already
--    have them from the inline CONSTRAINT clauses in 0000_init.sql,
--    so the IF NOT EXISTS guard makes this a no-op there. Legacy
--    installs had no kebab CHECKs at all and get them attached
--    cleanly now that every row carries kebab values.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_verdict_values') THEN
    ALTER TABLE "claim" ADD CONSTRAINT "claim_verdict_values"
      CHECK ("verdict" IN ('verified', 'disputed', 'unverified', 'not-applicable'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verdict_log_verdict_values') THEN
    ALTER TABLE "verdict_log" ADD CONSTRAINT "verdict_log_verdict_values"
      CHECK ("verdict" IN ('verified', 'disputed', 'unverified', 'not-applicable'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'golden_set_expected_verdict_values') THEN
    ALTER TABLE "golden_set_claim" ADD CONSTRAINT "golden_set_expected_verdict_values"
      CHECK ("expected_verdict" IN ('verified', 'disputed', 'unverified', 'not-applicable'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_relation_type_values') THEN
    ALTER TABLE "claim_relation" ADD CONSTRAINT "claim_relation_type_values"
      CHECK ("relation_type" IN ('supports','contradicts','derives-from','superseded-by','refines'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_feedback_application_method_values') THEN
    ALTER TABLE "claim_feedback" ADD CONSTRAINT "claim_feedback_application_method_values"
      CHECK ("application_method" IN ('verified','applied','cited','reasoned-over'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_feedback_failure_dimension_values') THEN
    ALTER TABLE "claim_feedback" ADD CONSTRAINT "claim_feedback_failure_dimension_values"
      CHECK ("failure_dimension" IS NULL OR "failure_dimension" IN
        ('fully-false','scope-too-broad','time-expired','modality-too-strong','context-mismatch','partially-correct'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_feedback_failure_dimension_inferred_values') THEN
    ALTER TABLE "claim_feedback" ADD CONSTRAINT "claim_feedback_failure_dimension_inferred_values"
      CHECK ("failure_dimension_inferred" IS NULL OR "failure_dimension_inferred" IN
        ('fully-false','scope-too-broad','time-expired','modality-too-strong','context-mismatch','partially-correct'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_feedback_enrichment_status_values') THEN
    ALTER TABLE "claim_feedback" ADD CONSTRAINT "claim_feedback_enrichment_status_values"
      CHECK ("enrichment_status" IN (
        'pending','finalized-inferred','awaiting-pull','enriched',
        'expired-reporter-unavailable','skipped-backpressure','not-needed'
      ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entry_source_source_type_values') THEN
    ALTER TABLE "entry_source" ADD CONSTRAINT "entry_source_source_type_values"
      CHECK ("source_type" IN (
        'official-docs','github-release','cve-db','official-blog','research-paper',
        'established-blog','community-forum','personal-blog','ai-generated',
        'reference-wiki','unknown'
      ));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feedback_log_signal_values') THEN
    ALTER TABLE "feedback_log" ADD CONSTRAINT "feedback_log_signal_values"
      CHECK ("signal" IN ('positive', 'negative'));
  END IF;
END $$;
