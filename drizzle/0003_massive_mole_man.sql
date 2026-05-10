CREATE TABLE "needs_review" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"domain" text NOT NULL,
	"subject" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"ai_call_id" bigint,
	"proposed_action" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decision" jsonb,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"promoted_to_rule_id" bigint,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"domain" text NOT NULL,
	"name" text NOT NULL,
	"match" jsonb NOT NULL,
	"action" jsonb NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_from_review_id" bigint,
	"created_by" text NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE INDEX "needs_review_domain_status_created_idx" ON "needs_review" USING btree ("domain","status","created_at");--> statement-breakpoint
CREATE INDEX "needs_review_subject_idx" ON "needs_review" USING btree ("subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "needs_review_ai_call_idx" ON "needs_review" USING btree ("ai_call_id");--> statement-breakpoint
CREATE INDEX "rules_domain_enabled_priority_idx" ON "rules" USING btree ("domain","enabled","priority");--> statement-breakpoint
CREATE INDEX "rules_from_review_idx" ON "rules" USING btree ("created_from_review_id");