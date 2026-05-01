CREATE TABLE "calibration_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"nli_support_threshold" double precision DEFAULT 0.7 NOT NULL,
	"nli_refute_threshold" double precision DEFAULT 0.7 NOT NULL,
	"sample_size" integer DEFAULT 0 NOT NULL,
	"best_f1" double precision DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim" (
	"id" text PRIMARY KEY NOT NULL,
	"entry_id" text NOT NULL,
	"entry_created_at" timestamp with time zone NOT NULL,
	"statement" text NOT NULL,
	"type" text NOT NULL,
	"verdict" text DEFAULT 'unverified' NOT NULL,
	"certainty" double precision DEFAULT 0 NOT NULL,
	"evidence" jsonb,
	"embedding" vector(384) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_drift_check_at" timestamp with time zone,
	CONSTRAINT "claim_type_values" CHECK ("claim"."type" IN ('factual', 'subjective', 'predictive', 'normative')),
	CONSTRAINT "claim_verdict_values" CHECK ("claim"."verdict" IN ('verified', 'disputed', 'unverified', 'not_applicable')),
	CONSTRAINT "claim_certainty_range" CHECK ("claim"."certainty" >= 0 AND "claim"."certainty" <= 1),
	CONSTRAINT "claim_statement_len" CHECK (length("claim"."statement") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "entity" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"metadata" jsonb,
	"embedding" vector(384) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_name_len" CHECK (length("entity"."name") <= 200),
	CONSTRAINT "entity_type_len" CHECK (length("entity"."type") <= 50)
);
--> statement-breakpoint
CREATE TABLE "entry" (
	"id" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"metadata" jsonb,
	"authority" double precision DEFAULT 0 NOT NULL,
	"decay_rate" double precision DEFAULT 0.01 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"embedding" vector(384) NOT NULL,
	CONSTRAINT "entry_id_created_at_pk" PRIMARY KEY("id","created_at"),
	CONSTRAINT "entry_title_len" CHECK (length("entry"."title") <= 500),
	CONSTRAINT "entry_content_len" CHECK (length("entry"."content") <= 50000),
	CONSTRAINT "entry_authority_range" CHECK ("entry"."authority" >= 0 AND "entry"."authority" <= 1),
	CONSTRAINT "entry_decay_rate_range" CHECK ("entry"."decay_rate" >= 0 AND "entry"."decay_rate" <= 1),
	CONSTRAINT "entry_status_values" CHECK ("entry"."status" IN ('draft', 'active')),
	CONSTRAINT "entry_metadata_size" CHECK (pg_column_size("entry"."metadata") <= 1048576)
);
--> statement-breakpoint
CREATE TABLE "entry_domain" (
	"entry_id" text NOT NULL,
	"entry_created_at" timestamp with time zone NOT NULL,
	"domain" text NOT NULL,
	CONSTRAINT "entry_domain_entry_id_entry_created_at_domain_pk" PRIMARY KEY("entry_id","entry_created_at","domain"),
	CONSTRAINT "entry_domain_len" CHECK (length("entry_domain"."domain") <= 50)
);
--> statement-breakpoint
CREATE TABLE "entry_score" (
	"entry_id" text NOT NULL,
	"entry_created_at" timestamp with time zone NOT NULL,
	"dimension" text NOT NULL,
	"value" double precision NOT NULL,
	"scored_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scored_by" text DEFAULT 'system' NOT NULL,
	CONSTRAINT "entry_score_entry_id_entry_created_at_dimension_pk" PRIMARY KEY("entry_id","entry_created_at","dimension"),
	CONSTRAINT "entry_score_dimension_values" CHECK ("entry_score"."dimension" IN ('factuality', 'novelty', 'actionability', 'signal')),
	CONSTRAINT "entry_score_value_range" CHECK ("entry_score"."value" >= 0 AND "entry_score"."value" <= 1)
);
--> statement-breakpoint
CREATE TABLE "entry_source" (
	"entry_id" text NOT NULL,
	"entry_created_at" timestamp with time zone NOT NULL,
	"url" text NOT NULL,
	"source_type" text NOT NULL,
	"trust" double precision DEFAULT 0 NOT NULL,
	CONSTRAINT "entry_source_entry_id_entry_created_at_url_pk" PRIMARY KEY("entry_id","entry_created_at","url"),
	CONSTRAINT "entry_source_trust_range" CHECK ("entry_source"."trust" >= 0 AND "entry_source"."trust" <= 1)
);
--> statement-breakpoint
CREATE TABLE "entry_tag" (
	"entry_id" text NOT NULL,
	"entry_created_at" timestamp with time zone NOT NULL,
	"tag" text NOT NULL,
	CONSTRAINT "entry_tag_entry_id_entry_created_at_tag_pk" PRIMARY KEY("entry_id","entry_created_at","tag"),
	CONSTRAINT "entry_tag_len" CHECK (length("entry_tag"."tag") <= 50)
);
--> statement-breakpoint
CREATE TABLE "feedback_log" (
	"id" text PRIMARY KEY NOT NULL,
	"entry_id" text NOT NULL,
	"entry_created_at" timestamp with time zone NOT NULL,
	"signal" text NOT NULL,
	"reason" text,
	"agent_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_log_signal_values" CHECK ("feedback_log"."signal" IN ('positive', 'negative'))
);
--> statement-breakpoint
CREATE TABLE "ingest_log" (
	"id" text PRIMARY KEY NOT NULL,
	"url_hash" text,
	"entry_id" text,
	"entry_created_at" timestamp with time zone,
	"action" text NOT NULL,
	"reason" text,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingest_log_action_values" CHECK ("ingest_log"."action" IN ('stored', 'duplicate', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "kg_relation" (
	"id" text PRIMARY KEY NOT NULL,
	"source_entity_id" text NOT NULL,
	"target_entity_id" text NOT NULL,
	"relation_type" text NOT NULL,
	"claim_id" text,
	"weight" double precision DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kg_relation_weight_range" CHECK ("kg_relation"."weight" >= 0 AND "kg_relation"."weight" <= 1),
	CONSTRAINT "kg_relation_no_self_loop" CHECK ("kg_relation"."source_entity_id" <> "kg_relation"."target_entity_id")
);
--> statement-breakpoint
CREATE TABLE "retry_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"raw_content" text NOT NULL,
	"source_url" text,
	"error_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_retry_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verdict_log" (
	"id" text PRIMARY KEY NOT NULL,
	"claim_id" text NOT NULL,
	"verdict" text NOT NULL,
	"certainty" double precision NOT NULL,
	"evidence_source" text,
	"grounder_model" text,
	"trigger" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verdict_log_verdict_values" CHECK ("verdict_log"."verdict" IN ('verified', 'disputed', 'unverified', 'not_applicable')),
	CONSTRAINT "verdict_log_certainty_range" CHECK ("verdict_log"."certainty" >= 0 AND "verdict_log"."certainty" <= 1),
	CONSTRAINT "verdict_log_trigger_values" CHECK ("verdict_log"."trigger" IN ('auto', 'feedback', 'drift', 'reverify', 'cove', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "verify_queue" (
	"claim_id" text PRIMARY KEY NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "claim" ADD CONSTRAINT "claim_entry_id_entry_created_at_entry_id_created_at_fk" FOREIGN KEY ("entry_id","entry_created_at") REFERENCES "public"."entry"("id","created_at") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_domain" ADD CONSTRAINT "entry_domain_entry_id_entry_created_at_entry_id_created_at_fk" FOREIGN KEY ("entry_id","entry_created_at") REFERENCES "public"."entry"("id","created_at") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_score" ADD CONSTRAINT "entry_score_entry_id_entry_created_at_entry_id_created_at_fk" FOREIGN KEY ("entry_id","entry_created_at") REFERENCES "public"."entry"("id","created_at") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_source" ADD CONSTRAINT "entry_source_entry_id_entry_created_at_entry_id_created_at_fk" FOREIGN KEY ("entry_id","entry_created_at") REFERENCES "public"."entry"("id","created_at") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_tag" ADD CONSTRAINT "entry_tag_entry_id_entry_created_at_entry_id_created_at_fk" FOREIGN KEY ("entry_id","entry_created_at") REFERENCES "public"."entry"("id","created_at") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_log" ADD CONSTRAINT "feedback_log_entry_id_entry_created_at_entry_id_created_at_fk" FOREIGN KEY ("entry_id","entry_created_at") REFERENCES "public"."entry"("id","created_at") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kg_relation" ADD CONSTRAINT "kg_relation_source_entity_id_entity_id_fk" FOREIGN KEY ("source_entity_id") REFERENCES "public"."entity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kg_relation" ADD CONSTRAINT "kg_relation_target_entity_id_entity_id_fk" FOREIGN KEY ("target_entity_id") REFERENCES "public"."entity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kg_relation" ADD CONSTRAINT "kg_relation_claim_id_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claim"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verdict_log" ADD CONSTRAINT "verdict_log_claim_id_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claim"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verify_queue" ADD CONSTRAINT "verify_queue_claim_id_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claim"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_claim_entry" ON "claim" USING btree ("entry_id","entry_created_at");--> statement-breakpoint
CREATE INDEX "idx_claim_type_verdict" ON "claim" USING btree ("type","verdict");--> statement-breakpoint
CREATE INDEX "idx_entity_name" ON "entity" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_entity_type" ON "entity" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_entry_status" ON "entry" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_entry_authority" ON "entry" USING btree ("authority" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_entry_language" ON "entry" USING btree ("language");--> statement-breakpoint
CREATE INDEX "idx_entry_created_at" ON "entry" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_entry_domain_domain" ON "entry_domain" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "idx_entry_score_dimension" ON "entry_score" USING btree ("dimension","value");--> statement-breakpoint
CREATE INDEX "idx_entry_source_type" ON "entry_source" USING btree ("source_type");--> statement-breakpoint
CREATE INDEX "idx_entry_tag_tag" ON "entry_tag" USING btree ("tag");--> statement-breakpoint
CREATE INDEX "idx_feedback_log_entry" ON "feedback_log" USING btree ("entry_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_feedback_log_agent_entry" ON "feedback_log" USING btree ("agent_id","entry_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ingest_log_url_hash" ON "ingest_log" USING btree ("url_hash") WHERE "ingest_log"."url_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_ingest_log_ingested_at" ON "ingest_log" USING btree ("ingested_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_kg_relation_edge" ON "kg_relation" USING btree ("source_entity_id","target_entity_id","relation_type","claim_id");--> statement-breakpoint
CREATE INDEX "idx_kg_relation_source" ON "kg_relation" USING btree ("source_entity_id");--> statement-breakpoint
CREATE INDEX "idx_kg_relation_target" ON "kg_relation" USING btree ("target_entity_id");--> statement-breakpoint
CREATE INDEX "idx_retry_queue_next" ON "retry_queue" USING btree ("next_retry_at") WHERE "retry_queue"."attempts" < 3;--> statement-breakpoint
CREATE INDEX "idx_verdict_log_claim" ON "verdict_log" USING btree ("claim_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_verdict_log_created" ON "verdict_log" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_verify_queue_next" ON "verify_queue" USING btree ("priority" DESC NULLS LAST,"next_attempt_at") WHERE "verify_queue"."attempts" < 3;