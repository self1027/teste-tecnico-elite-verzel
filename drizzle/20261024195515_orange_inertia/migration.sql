ALTER TABLE "audit_events" ADD COLUMN "hash_version" integer;
--> statement-breakpoint
UPDATE "audit_events" SET "hash_version" = 0;
--> statement-breakpoint
ALTER TABLE "audit_events" ALTER COLUMN "hash_version" SET NOT NULL;
