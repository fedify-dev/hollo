-- Custom SQL migration file, put your code below! --

-- Clean up duplicate notifications
-- Keeps the earliest notification for each unique combination and deletes the rest

-- First, create a temporary table with the IDs to keep
CREATE TEMP TABLE notifications_to_keep AS
SELECT DISTINCT ON (account_owner_id, type, actor_account_id, target_post_id, target_account_id)
  id
FROM notifications
ORDER BY account_owner_id, type, actor_account_id, target_post_id, target_account_id, created ASC;

-- Delete notifications that are not in the keep list
DELETE FROM notifications
WHERE id NOT IN (SELECT id FROM notifications_to_keep);

-- Drop the temporary table
DROP TABLE notifications_to_keep;

-- Update notification_groups to reflect correct counts
-- Recalculate notifications_count for each group
UPDATE notification_groups
SET notifications_count = subquery.actual_count
FROM (
  SELECT group_key, COUNT(*) as actual_count
  FROM notifications
  GROUP BY group_key
) AS subquery
WHERE notification_groups.group_key = subquery.group_key
  AND notification_groups.notifications_count != subquery.actual_count;

-- Delete orphaned notification groups (groups with no notifications)
DELETE FROM notification_groups
WHERE group_key NOT IN (SELECT DISTINCT group_key FROM notifications);