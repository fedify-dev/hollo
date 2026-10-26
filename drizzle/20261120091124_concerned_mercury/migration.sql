DROP INDEX "custom_emoji_import_jobs_status_processing_started_idx";--> statement-breakpoint
ALTER TABLE "custom_emoji_import_jobs" ADD COLUMN "attempt_token" uuid;--> statement-breakpoint
ALTER TABLE "custom_emoji_import_jobs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "custom_emoji_import_jobs" ADD COLUMN "next_dispatch_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL;--> statement-breakpoint
CREATE INDEX "custom_emoji_import_jobs_status_lease_expires_at_idx" ON "custom_emoji_import_jobs" ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "custom_emoji_import_jobs_next_dispatch_at_idx" ON "custom_emoji_import_jobs" ("next_dispatch_at") WHERE "status" = 'pending';