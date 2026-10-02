CREATE TABLE "import_job_effects" (
	"item_id" uuid PRIMARY KEY,
	"deliveries" jsonb DEFAULT '[]' NOT NULL,
	"delivered" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cleanup_job_items" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cleanup_job_items" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL;--> statement-breakpoint
ALTER TABLE "cleanup_job_items" ADD COLUMN "next_dispatch_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL;--> statement-breakpoint
ALTER TABLE "cleanup_jobs" ADD COLUMN "next_dispatch_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL;--> statement-breakpoint
ALTER TABLE "import_job_items" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_job_items" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL;--> statement-breakpoint
ALTER TABLE "import_job_items" ADD COLUMN "next_dispatch_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "next_dispatch_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL;--> statement-breakpoint
CREATE INDEX "cleanup_job_items_job_id_next_dispatch_at_index" ON "cleanup_job_items" ("job_id","next_dispatch_at") WHERE "status" IN ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "cleanup_job_items_proxy_key_index" ON "cleanup_job_items" ("job_id",("data"->>'key')) WHERE "data"->>'kind' = 'proxy_cache';--> statement-breakpoint
CREATE INDEX "cleanup_jobs_next_dispatch_at_index" ON "cleanup_jobs" ("next_dispatch_at") WHERE "status" IN ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "import_job_items_job_id_next_dispatch_at_index" ON "import_job_items" ("job_id","next_dispatch_at") WHERE "status" IN ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "import_jobs_next_dispatch_at_index" ON "import_jobs" ("next_dispatch_at") WHERE "status" IN ('pending', 'processing');--> statement-breakpoint
ALTER TABLE "import_job_effects" ADD CONSTRAINT "import_job_effects_item_id_import_job_items_id_fkey" FOREIGN KEY ("item_id") REFERENCES "import_job_items"("id") ON DELETE CASCADE;--> statement-breakpoint
-- Old workers counted claims, including abandoned processing items. Restore
-- terminal counters without changing completed or cancelled historical jobs.
UPDATE import_jobs j SET
  processed_items = s.successful + s.failed,
  successful_items = s.successful,
  failed_items = s.failed
FROM (
  SELECT job_id,
    count(*) FILTER (WHERE status = 'completed')::integer AS successful,
    count(*) FILTER (WHERE status = 'failed')::integer AS failed
  FROM import_job_items GROUP BY job_id
) s WHERE j.id = s.job_id AND j.status IN ('pending', 'processing');
--> statement-breakpoint
UPDATE cleanup_jobs j SET
  processed_items = s.successful + s.failed,
  successful_items = s.successful,
  failed_items = s.failed,
  total_items = CASE WHEN s.enumerating THEN s.total ELSE j.total_items END
FROM (
  SELECT job_id, count(*)::integer AS total,
    count(*) FILTER (WHERE status = 'completed')::integer AS successful,
    count(*) FILTER (WHERE status = 'failed')::integer AS failed,
    bool_or(data->>'kind' = 'enumerate_proxy_cache' AND status IN ('pending', 'processing')) AS enumerating
  FROM cleanup_job_items GROUP BY job_id
) s WHERE j.id = s.job_id AND j.status IN ('pending', 'processing');
--> statement-breakpoint
-- Diagnose partial legacy batches once, including already-started jobs. New
-- dispatches use counters and bounded index scans rather than repeated counts.
UPDATE import_jobs j SET status = 'failed', completed_at = clock_timestamp(),
  error_message = 'Incomplete legacy job batch; upload or schedule this job again'
WHERE status IN ('pending', 'processing') AND total_items > (
  SELECT count(*) FROM import_job_items i WHERE i.job_id = j.id
);
--> statement-breakpoint
UPDATE cleanup_jobs j SET status = 'failed', completed_at = clock_timestamp(),
  error_message = 'Incomplete legacy job batch; upload or schedule this job again'
WHERE status IN ('pending', 'processing') AND total_items > (
  SELECT count(*) FROM cleanup_job_items i WHERE i.job_id = j.id
);
