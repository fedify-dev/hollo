UPDATE "posts"
SET "poll_id" = NULL
WHERE "sharing_id" IS NOT NULL AND "poll_id" IS NOT NULL;
--> statement-breakpoint
-- CONCURRENTLY omitted: Drizzle migrator wraps pending PostgreSQL migrations
-- in a transaction, and CREATE INDEX CONCURRENTLY cannot run inside one.
-- Large installations can run the UPDATE above and pre-create this index with
-- CONCURRENTLY before deployment; IF NOT EXISTS makes this step a no-op there.
CREATE UNIQUE INDEX IF NOT EXISTS "posts_poll_id_unique"
  ON "posts" ("poll_id");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "posts" ADD CONSTRAINT "posts_poll_id_unique"
 UNIQUE USING INDEX "posts_poll_id_unique";
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
