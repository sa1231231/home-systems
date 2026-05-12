CREATE TABLE "scraper_digests" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text NOT NULL,
	"ai_call_id" bigint
);
--> statement-breakpoint
CREATE TABLE "scraper_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"item_url" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"published_at" timestamp with time zone,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw_snippet" text
);
--> statement-breakpoint
CREATE INDEX "scraper_digests_kind_created_idx" ON "scraper_digests" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "scraper_items_kind_created_idx" ON "scraper_items" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "scraper_items_kind_url_idx" ON "scraper_items" USING btree ("kind","item_url");