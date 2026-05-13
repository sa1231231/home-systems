CREATE TABLE "contact_groups" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_groups_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE INDEX "contact_groups_name_idx" ON "contact_groups" USING btree ("name");