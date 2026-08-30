-- CONCURRENTLY omitted: Drizzle migrator wraps pending PostgreSQL migrations
-- in a transaction, and CREATE INDEX CONCURRENTLY cannot run inside one.
-- Large installations can pre-create this index with CONCURRENTLY before
-- deployment; IF NOT EXISTS makes this step a no-op after a successful build.
CREATE INDEX IF NOT EXISTS "posts_url_index"
  ON "posts" USING hash ("url")
  WHERE ("url" IS NOT NULL);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS idx
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = idx.indexrelid
    JOIN pg_catalog.pg_am AS access_method
      ON access_method.oid = relation.relam
    WHERE relation.oid = 'public.posts_url_index'::regclass
      AND idx.indrelid = 'public.posts'::regclass
      AND idx.indisvalid
      AND idx.indnkeyatts = 1
      AND pg_get_indexdef(relation.oid, 1, false) = 'url'
      AND access_method.amname = 'hash'
  ) THEN
    RAISE EXCEPTION 'posts_url_index is missing or invalid';
  END IF;
END $$;
