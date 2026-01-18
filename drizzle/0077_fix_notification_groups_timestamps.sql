-- Fix notification_groups with NULL timestamps
-- This updates groups that were created by earlier migrations without proper timestamp values

-- Update latest_page_notification_at from the most recent notification in the group
UPDATE notification_groups ng
SET
  latest_page_notification_at = (
    SELECT MAX(n.created) FROM notifications n WHERE n.group_key = ng.group_key
  ),
  page_min_id = COALESCE(
    ng.page_min_id,
    (SELECT n.id FROM notifications n WHERE n.group_key = ng.group_key ORDER BY n.created ASC LIMIT 1)
  ),
  page_max_id = COALESCE(
    ng.page_max_id,
    (SELECT n.id FROM notifications n WHERE n.group_key = ng.group_key ORDER BY n.created DESC LIMIT 1)
  )
WHERE ng.latest_page_notification_at IS NULL;

-- Add expression index for efficient ordering with COALESCE fallback
-- This index supports the v2 notifications API ordering:
-- ORDER BY COALESCE(latest_page_notification_at, created) DESC
CREATE INDEX IF NOT EXISTS "notification_groups_coalesce_timestamp_index"
  ON "notification_groups" (COALESCE(latest_page_notification_at, created) DESC);
