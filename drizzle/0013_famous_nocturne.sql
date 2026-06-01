CREATE TABLE "notification_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"ref_year" integer NOT NULL,
	"lookahead_days" integer NOT NULL,
	"channel" text NOT NULL,
	"payload" jsonb,
	"delivery_status" text NOT NULL,
	"delivery_error" text
);
--> statement-breakpoint
CREATE INDEX "notification_log_dedup_idx" ON "notification_log" USING btree ("kind","subject_kind","subject_id","ref_year","lookahead_days","delivery_status");