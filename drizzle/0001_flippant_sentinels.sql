CREATE TABLE "changelog" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"caller" text NOT NULL,
	"session_id" text NOT NULL,
	"operation" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"intent" text,
	"before_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"after_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"external_target" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"undone_by" bigint
);
--> statement-breakpoint
CREATE INDEX "changelog_session_idx" ON "changelog" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "changelog_operation_created_idx" ON "changelog" USING btree ("operation","created_at");--> statement-breakpoint
CREATE INDEX "changelog_target_idx" ON "changelog" USING btree ("target_kind","target_id","created_at");