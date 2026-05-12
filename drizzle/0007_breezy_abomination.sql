CREATE TABLE "triage_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"caller" text NOT NULL,
	"session_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"summary" jsonb,
	"error" text
);
--> statement-breakpoint
CREATE INDEX "triage_runs_domain_started_idx" ON "triage_runs" USING btree ("domain","started_at");--> statement-breakpoint
CREATE INDEX "triage_runs_status_idx" ON "triage_runs" USING btree ("status","started_at");