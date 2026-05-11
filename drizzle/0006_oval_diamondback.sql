CREATE TABLE "processed_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text NOT NULL,
	"outcome_id" bigint,
	"error" text
);
--> statement-breakpoint
CREATE INDEX "processed_transactions_outcome_idx" ON "processed_transactions" USING btree ("outcome","last_processed_at");