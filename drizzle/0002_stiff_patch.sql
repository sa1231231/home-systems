CREATE TABLE "ai_calls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"classifier" text NOT NULL,
	"caller" text NOT NULL,
	"model" text NOT NULL,
	"system_prompt" text NOT NULL,
	"input" text NOT NULL,
	"raw_output" text NOT NULL,
	"parsed_output" jsonb,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_input_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_input_tokens" integer DEFAULT 0 NOT NULL,
	"effort" text NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"intent" text
);
--> statement-breakpoint
CREATE INDEX "ai_calls_classifier_created_idx" ON "ai_calls" USING btree ("classifier","created_at");--> statement-breakpoint
CREATE INDEX "ai_calls_status_created_idx" ON "ai_calls" USING btree ("status","created_at");