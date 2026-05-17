CREATE TABLE "contact_snapshots" (
	"resource_name" text PRIMARY KEY NOT NULL,
	"fields" jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
