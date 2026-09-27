-- Reject incompatible pre-built indexes before taking write-blocking locks
-- to build any missing indexes.  Validate again after creation in case another
-- session creates a same-name index between this check and CREATE INDEX.
DO $$
DECLARE
  expected record;
BEGIN
  FOR expected IN
    SELECT * FROM (VALUES
      ('list_posts_post_id_index', 'list_posts', 'post_id'),
      ('timeline_posts_post_id_index', 'timeline_posts', 'post_id'),
      ('remote_reply_scrape_jobs_post_id_index', 'remote_reply_scrape_jobs', 'post_id'),
      ('notifications_target_post_id_index', 'notifications', 'target_post_id'),
      ('notification_groups_target_post_id_index', 'notification_groups', 'target_post_id')
    ) AS indexes(index_name, table_name, column_name)
  LOOP
    IF to_regclass(expected.index_name) IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_index AS idx
      JOIN pg_catalog.pg_class AS relation ON relation.oid = idx.indexrelid
      JOIN pg_catalog.pg_am AS access_method ON access_method.oid = relation.relam
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = idx.indrelid AND attribute.attnum = idx.indkey[0]
      WHERE idx.indexrelid = to_regclass(expected.index_name)
        AND idx.indrelid = to_regclass(expected.table_name)
        AND idx.indisvalid AND idx.indisready
        AND NOT idx.indisunique
        AND idx.indnkeyatts = 1 AND idx.indnatts = 1
        AND idx.indpred IS NULL AND idx.indexprs IS NULL
        AND attribute.attname = expected.column_name
        AND access_method.amname = 'btree'
    ) THEN
      RAISE EXCEPTION '% is missing, invalid, or has an unexpected definition',
        expected.index_name;
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
-- Drizzle runs PostgreSQL migrations in a transaction, so CONCURRENTLY cannot
-- be used here.  Large installations can build these indexes concurrently
-- before upgrading; reuse them only after checking their definitions below.
CREATE INDEX IF NOT EXISTS "list_posts_post_id_index" ON "list_posts" ("post_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_groups_target_post_id_index" ON "notification_groups" ("target_post_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_target_post_id_index" ON "notifications" ("target_post_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "remote_reply_scrape_jobs_post_id_index" ON "remote_reply_scrape_jobs" ("post_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "timeline_posts_post_id_index" ON "timeline_posts" ("post_id");
--> statement-breakpoint
DO $$
DECLARE
  expected record;
BEGIN
  FOR expected IN
    SELECT * FROM (VALUES
      ('list_posts_post_id_index', 'list_posts', 'post_id'),
      ('timeline_posts_post_id_index', 'timeline_posts', 'post_id'),
      ('remote_reply_scrape_jobs_post_id_index', 'remote_reply_scrape_jobs', 'post_id'),
      ('notifications_target_post_id_index', 'notifications', 'target_post_id'),
      ('notification_groups_target_post_id_index', 'notification_groups', 'target_post_id')
    ) AS indexes(index_name, table_name, column_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_index AS idx
      JOIN pg_catalog.pg_class AS relation ON relation.oid = idx.indexrelid
      JOIN pg_catalog.pg_am AS access_method ON access_method.oid = relation.relam
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = idx.indrelid AND attribute.attnum = idx.indkey[0]
      WHERE idx.indexrelid = to_regclass(expected.index_name)
        AND idx.indrelid = to_regclass(expected.table_name)
        AND idx.indisvalid AND idx.indisready
        AND NOT idx.indisunique
        AND idx.indnkeyatts = 1 AND idx.indnatts = 1
        AND idx.indpred IS NULL AND idx.indexprs IS NULL
        AND attribute.attname = expected.column_name
        AND access_method.amname = 'btree'
    ) THEN
      RAISE EXCEPTION '% is missing, invalid, or has an unexpected definition',
        expected.index_name;
    END IF;
  END LOOP;
END $$;
