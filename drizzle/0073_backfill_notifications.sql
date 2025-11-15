-- Backfill recent notifications from existing data
-- This creates notifications for recent activities so users don't see an empty notification list after upgrade

-- 1. Create follow notifications (most recent 100 approved follows)
INSERT INTO notifications (id, account_owner_id, type, actor_account_id, target_account_id, group_key, created, read_at)
SELECT
  gen_random_uuid() as id,
  ao.id as account_owner_id,
  'follow' as type,
  f.follower_id as actor_account_id,
  f.following_id as target_account_id,
  ao.id || ':follow:' || f.following_id as group_key,
  f.approved as created,
  NULL as read_at
FROM follows f
JOIN accounts a ON f.following_id = a.id
JOIN account_owners ao ON a.id = ao.id
WHERE f.approved IS NOT NULL
ORDER BY f.approved DESC
LIMIT 100
ON CONFLICT DO NOTHING;

-- 2. Create follow_request notifications (most recent 50 pending follows)
INSERT INTO notifications (id, account_owner_id, type, actor_account_id, target_account_id, group_key, created, read_at)
SELECT
  gen_random_uuid() as id,
  ao.id as account_owner_id,
  'follow_request' as type,
  f.follower_id as actor_account_id,
  f.following_id as target_account_id,
  'ungrouped:' || gen_random_uuid() as group_key,
  f.created as created,
  NULL as read_at
FROM follows f
JOIN accounts a ON f.following_id = a.id
JOIN account_owners ao ON a.id = ao.id
WHERE f.approved IS NULL
ORDER BY f.created DESC
LIMIT 50
ON CONFLICT DO NOTHING;

-- 3. Create favourite notifications (most recent 100 likes on local users' posts)
INSERT INTO notifications (id, account_owner_id, type, actor_account_id, target_post_id, group_key, created, read_at)
SELECT
  gen_random_uuid() as id,
  ao.id as account_owner_id,
  'favourite' as type,
  l.account_id as actor_account_id,
  l.post_id as target_post_id,
  ao.id || ':favourite:' || l.post_id as group_key,
  l.created as created,
  NULL as read_at
FROM likes l
JOIN posts liked_post ON l.post_id = liked_post.id
JOIN accounts a ON liked_post.actor_id = a.id
JOIN account_owners ao ON a.id = ao.id
WHERE l.account_id != ao.id  -- Don't notify about own likes
ORDER BY l.created DESC
LIMIT 100
ON CONFLICT DO NOTHING;

-- 4. Create emoji_reaction notifications (most recent 100 reactions on local users' posts)
INSERT INTO notifications (id, account_owner_id, type, actor_account_id, target_post_id, group_key, created, read_at)
SELECT
  gen_random_uuid() as id,
  ao.id as account_owner_id,
  'emoji_reaction' as type,
  r.account_id as actor_account_id,
  r.post_id as target_post_id,
  ao.id || ':emoji_reaction:' || r.post_id as group_key,
  r.created as created,
  NULL as read_at
FROM reactions r
JOIN posts reacted_post ON r.post_id = reacted_post.id
JOIN accounts a ON reacted_post.actor_id = a.id
JOIN account_owners ao ON a.id = ao.id
WHERE r.account_id != ao.id  -- Don't notify about own reactions
ORDER BY r.created DESC
LIMIT 100
ON CONFLICT DO NOTHING;

-- 5. Create mention notifications (most recent 100 mentions of local users)
INSERT INTO notifications (id, account_owner_id, type, actor_account_id, target_post_id, group_key, created, read_at)
SELECT
  gen_random_uuid() as id,
  ao.id as account_owner_id,
  'mention' as type,
  post.actor_id as actor_account_id,
  post.id as target_post_id,
  'ungrouped:' || gen_random_uuid() as group_key,
  COALESCE(post.published, post.updated) as created,
  NULL as read_at
FROM mentions m
JOIN posts post ON m.post_id = post.id
JOIN accounts a ON m.account_id = a.id
JOIN account_owners ao ON a.id = ao.id
WHERE post.actor_id != ao.id  -- Don't notify about own mentions
ORDER BY COALESCE(post.published, post.updated) DESC
LIMIT 100
ON CONFLICT DO NOTHING;

-- 6. Create reblog notifications (most recent 100 shares of local users' posts)
INSERT INTO notifications (id, account_owner_id, type, actor_account_id, target_post_id, group_key, created, read_at)
SELECT
  gen_random_uuid() as id,
  ao.id as account_owner_id,
  'reblog' as type,
  share.actor_id as actor_account_id,
  share.sharing_id as target_post_id,
  ao.id || ':reblog:' || share.sharing_id as group_key,
  COALESCE(share.published, share.updated) as created,
  NULL as read_at
FROM posts share
JOIN posts original ON share.sharing_id = original.id
JOIN accounts a ON original.actor_id = a.id
JOIN account_owners ao ON a.id = ao.id
WHERE share.sharing_id IS NOT NULL
  AND share.actor_id != ao.id  -- Don't notify about own shares
ORDER BY COALESCE(share.published, share.updated) DESC
LIMIT 100
ON CONFLICT DO NOTHING;

-- 7. Build notification groups from the created notifications
INSERT INTO notification_groups (
  group_key,
  account_owner_id,
  type,
  target_post_id,
  notifications_count,
  most_recent_notification_id,
  sample_account_ids,
  latest_page_notification_at,
  page_min_id,
  page_max_id,
  created,
  updated
)
SELECT
  n.group_key,
  n.account_owner_id,
  n.type,
  n.target_post_id,
  COUNT(*)::integer as notifications_count,
  (ARRAY_AGG(n.id ORDER BY n.created DESC))[1] as most_recent_notification_id,
  ARRAY_AGG(DISTINCT n.actor_account_id ORDER BY n.actor_account_id) FILTER (WHERE n.actor_account_id IS NOT NULL) as sample_account_ids,
  MAX(n.created) as latest_page_notification_at,
  (ARRAY_AGG(n.id ORDER BY n.created ASC))[1] as page_min_id,
  (ARRAY_AGG(n.id ORDER BY n.created DESC))[1] as page_max_id,
  MIN(n.created) as created,
  MAX(n.created) as updated
FROM notifications n
GROUP BY n.group_key, n.account_owner_id, n.type, n.target_post_id
ON CONFLICT (group_key) DO UPDATE SET
  notifications_count = EXCLUDED.notifications_count,
  most_recent_notification_id = EXCLUDED.most_recent_notification_id,
  sample_account_ids = EXCLUDED.sample_account_ids,
  latest_page_notification_at = EXCLUDED.latest_page_notification_at,
  page_min_id = EXCLUDED.page_min_id,
  page_max_id = EXCLUDED.page_max_id,
  updated = EXCLUDED.updated;
