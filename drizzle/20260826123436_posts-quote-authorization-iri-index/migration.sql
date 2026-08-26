-- CONCURRENTLY omitted: Drizzle migrator wraps pending PostgreSQL migrations
-- in a transaction, and CREATE INDEX CONCURRENTLY cannot run inside one.
-- Large installations can pre-create this index with CONCURRENTLY before
-- deployment; IF NOT EXISTS makes this step a no-op after a successful build.
CREATE INDEX IF NOT EXISTS "posts_quote_authorization_iri_index"
  ON "posts" USING hash ("quote_authorization_iri")
  WHERE ("quote_authorization_iri" IS NOT NULL);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS idx
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = idx.indexrelid
    WHERE relation.oid =
        'public.posts_quote_authorization_iri_index'::regclass
      AND idx.indrelid = 'public.posts'::regclass
      AND idx.indisvalid
  ) THEN
    RAISE EXCEPTION
      'posts_quote_authorization_iri_index is missing or invalid';
  END IF;
END $$;
