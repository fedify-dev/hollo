CREATE TYPE "remote_reply_scrape_kind" AS ENUM('replies', 'context');--> statement-breakpoint
ALTER TYPE "remote_reply_scrape_job_status" ADD VALUE 'waiting';--> statement-breakpoint
CREATE TABLE "remote_context_scrape_aliases" (
	"iri" text PRIMARY KEY,
	"job_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "remote_reply_scrape_jobs" DROP CONSTRAINT "remote_reply_scrape_jobs_replies_iri_unique";--> statement-breakpoint
ALTER TABLE "remote_reply_scrape_jobs" ADD COLUMN "kind" "remote_reply_scrape_kind" DEFAULT 'replies'::"remote_reply_scrape_kind" NOT NULL;--> statement-breakpoint
ALTER TABLE "remote_reply_scrape_jobs" ADD COLUMN "blocked_by_job_id" uuid;--> statement-breakpoint
ALTER TABLE "remote_reply_scrape_jobs" ADD COLUMN "partial" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "remote_reply_scrape_jobs" ADD COLUMN "yielded_items" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "remote_reply_scrape_jobs" ADD COLUMN "request_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "remote_reply_scrape_jobs" ADD COLUMN "skipped_items" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "remote_reply_scrape_jobs" ADD COLUMN "host_requeues" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "remote_reply_scrape_origins" ADD COLUMN "cooldown_until" timestamp with time zone DEFAULT 'epoch' NOT NULL;--> statement-breakpoint
CREATE INDEX "remote_context_scrape_aliases_job_id_index" ON "remote_context_scrape_aliases" ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "remote_reply_scrape_jobs_kind_collection_unique" ON "remote_reply_scrape_jobs" ("kind","replies_iri");--> statement-breakpoint
CREATE INDEX "remote_reply_scrape_jobs_blocked_by_job_id_index" ON "remote_reply_scrape_jobs" ("blocked_by_job_id");--> statement-breakpoint
ALTER TABLE "remote_context_scrape_aliases" ADD CONSTRAINT "remote_context_scrape_aliases_t0fqdOkRvVea_fkey" FOREIGN KEY ("job_id") REFERENCES "remote_reply_scrape_jobs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "remote_reply_scrape_jobs" ADD CONSTRAINT "remote_reply_scrape_jobs_FpYh7OnicGJo_fkey" FOREIGN KEY ("blocked_by_job_id") REFERENCES "remote_reply_scrape_jobs"("id") ON DELETE SET NULL;