CREATE TABLE "processed_emails" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text NOT NULL,
	"outcome_id" bigint,
	"error" text
);
--> statement-breakpoint
CREATE INDEX "processed_emails_outcome_idx" ON "processed_emails" USING btree ("outcome","last_processed_at");--> statement-breakpoint
CREATE INDEX "processed_emails_thread_idx" ON "processed_emails" USING btree ("thread_id");