ALTER TYPE "public"."notification_type" ADD VALUE 'quote';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'quoted_update';--> statement-breakpoint
COMMIT;--> statement-breakpoint

-- Backfill notifications for existing quote posts
INSERT INTO notifications (id, account_owner_id, type, actor_account_id, target_post_id, group_key, created)
SELECT
  gen_random_uuid(),
  ao.id as account_owner_id,
  'quote'::notification_type as type,
  p.actor_id as actor_account_id,
  p.id as target_post_id,
  'ungrouped:' || gen_random_uuid() as group_key,
  p.published as created
FROM posts p
INNER JOIN posts target ON p.quote_target_id = target.id
INNER JOIN accounts target_account ON target.actor_id = target_account.id
INNER JOIN account_owners ao ON target_account.id = ao.id
WHERE p.quote_target_id IS NOT NULL
  AND p.actor_id != target.actor_id  -- Exclude self-quotes
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Create notification groups for backfilled quote notifications
INSERT INTO notification_groups (group_key, account_owner_id, type, notifications_count, most_recent_notification_id, sample_account_ids)
SELECT DISTINCT
  n.group_key,
  n.account_owner_id,
  'quote'::notification_type,
  1,
  n.id,
  ARRAY[n.actor_account_id]
FROM notifications n
WHERE n.type = 'quote'
  AND NOT EXISTS (
    SELECT 1 FROM notification_groups ng WHERE ng.group_key = n.group_key
  )
ON CONFLICT DO NOTHING;--> statement-breakpoint

CREATE INDEX "posts_quote_target_id_index" ON "posts" USING btree ("quote_target_id") WHERE "posts"."quote_target_id" is not null;