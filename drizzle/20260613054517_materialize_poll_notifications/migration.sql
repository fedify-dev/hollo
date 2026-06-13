CREATE INDEX "polls_expires_index" ON "polls" ("expires");--> statement-breakpoint

-- Keep at most one poll notification per owner and poll before adding the
-- partial unique index below.  `createPollNotifications()` was previously
-- unused, so this is normally a no-op, but it keeps patched instances robust
-- if a local build had already experimented with materialized poll
-- notifications.
WITH ranked_poll_notifications AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY account_owner_id, target_poll_id
      ORDER BY created ASC, id ASC
    ) AS duplicate_rank
  FROM notifications
  WHERE type = 'poll'
    AND target_poll_id IS NOT NULL
)
DELETE FROM notifications
USING ranked_poll_notifications
WHERE notifications.id = ranked_poll_notifications.id
  AND ranked_poll_notifications.duplicate_rank > 1;--> statement-breakpoint

-- Materialize already-expired poll notifications that v1 used to synthesize
-- dynamically.  Recipients are the local poll author and local accounts that
-- voted in the poll.
WITH poll_notification_candidates AS (
  SELECT DISTINCT
    polls.id AS poll_id,
    posts.id AS post_id,
    polls.expires AS created,
    author_owner.id AS account_owner_id
  FROM polls
  INNER JOIN posts ON posts.poll_id = polls.id
  INNER JOIN account_owners AS author_owner ON author_owner.id = posts.actor_id
  WHERE polls.expires <= CURRENT_TIMESTAMP

  UNION

  SELECT DISTINCT
    polls.id AS poll_id,
    posts.id AS post_id,
    polls.expires AS created,
    participant_owner.id AS account_owner_id
  FROM polls
  INNER JOIN posts ON posts.poll_id = polls.id
  INNER JOIN poll_votes ON poll_votes.poll_id = polls.id
  INNER JOIN account_owners AS participant_owner
    ON participant_owner.id = poll_votes.account_id
  WHERE polls.expires <= CURRENT_TIMESTAMP
),
intended_poll_notifications AS (
  SELECT DISTINCT ON (account_owner_id, poll_id)
    poll_id,
    post_id,
    created,
    account_owner_id
  FROM poll_notification_candidates
  ORDER BY account_owner_id, poll_id, created DESC, post_id
)
INSERT INTO notifications (
  id,
  account_owner_id,
  type,
  target_post_id,
  target_poll_id,
  group_key,
  created,
  read_at
)
SELECT
  gen_random_uuid(),
  intended_poll_notifications.account_owner_id,
  'poll'::notification_type,
  intended_poll_notifications.post_id,
  intended_poll_notifications.poll_id,
  intended_poll_notifications.account_owner_id::text || ':poll:' ||
    intended_poll_notifications.poll_id::text,
  intended_poll_notifications.created,
  NULL
FROM intended_poll_notifications
WHERE NOT EXISTS (
  SELECT 1
  FROM notifications
  WHERE notifications.account_owner_id =
      intended_poll_notifications.account_owner_id
    AND notifications.type = 'poll'
    AND notifications.target_poll_id = intended_poll_notifications.poll_id
);--> statement-breakpoint

-- Ensure v2 grouped notifications can see the materialized poll rows.
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
  notifications.group_key,
  notifications.account_owner_id,
  notifications.type,
  notifications.target_post_id,
  COUNT(*)::integer,
  (ARRAY_AGG(notifications.id ORDER BY notifications.created DESC))[1],
  COALESCE(
    ARRAY_AGG(DISTINCT notifications.actor_account_id)
      FILTER (WHERE notifications.actor_account_id IS NOT NULL),
    '{}'::uuid[]
  ),
  MAX(notifications.created),
  (ARRAY_AGG(notifications.id ORDER BY notifications.created ASC))[1],
  (ARRAY_AGG(notifications.id ORDER BY notifications.created DESC))[1],
  MIN(notifications.created),
  MAX(notifications.created)
FROM notifications
WHERE notifications.type = 'poll'
  AND notifications.target_poll_id IS NOT NULL
GROUP BY
  notifications.group_key,
  notifications.account_owner_id,
  notifications.type,
  notifications.target_post_id
ON CONFLICT (group_key) DO UPDATE SET
  notifications_count = EXCLUDED.notifications_count,
  most_recent_notification_id = EXCLUDED.most_recent_notification_id,
  sample_account_ids = EXCLUDED.sample_account_ids,
  latest_page_notification_at = EXCLUDED.latest_page_notification_at,
  page_min_id = EXCLUDED.page_min_id,
  page_max_id = EXCLUDED.page_max_id,
  updated = EXCLUDED.updated;--> statement-breakpoint

DELETE FROM notification_groups
WHERE type = 'poll'
  AND group_key NOT IN (SELECT DISTINCT group_key FROM notifications);--> statement-breakpoint

CREATE UNIQUE INDEX "notifications_poll_account_owner_id_target_poll_id_unique" ON "notifications" ("account_owner_id","target_poll_id") WHERE "type" = 'poll' AND "target_poll_id" IS NOT NULL;
