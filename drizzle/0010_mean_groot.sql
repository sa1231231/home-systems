-- Disable all-but-the-oldest of each duplicate (domain, match) group so the
-- unique index below can be created. Keeps the oldest enabled rule of each
-- group; this also cleans up duplicate rules created before this safeguard.
UPDATE "rules" r SET "enabled" = false, "updated_at" = now()
WHERE r."enabled" = true AND EXISTS (
  SELECT 1 FROM "rules" r2
  WHERE r2."domain" = r."domain" AND r2."match" = r."match"
    AND r2."enabled" = true AND r2."id" < r."id"
);--> statement-breakpoint
CREATE UNIQUE INDEX "rules_domain_match_unique" ON "rules" USING btree ("domain","match") WHERE "rules"."enabled";--> statement-breakpoint
ALTER TABLE "processed_emails" DROP CONSTRAINT "processed_emails_pkey";--> statement-breakpoint
ALTER TABLE "processed_emails" ADD COLUMN "account" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "processed_emails" ADD CONSTRAINT "processed_emails_account_id_pk" PRIMARY KEY("account","id");
