CREATE TYPE "public"."quote_state" AS ENUM(
  'pending',
  'accepted',
  'rejected',
  'revoked',
  'unauthorized'
);--> statement-breakpoint
CREATE TYPE "public"."quote_approval_policy" AS ENUM(
  'public',
  'followers',
  'nobody'
);--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "quote_target_iri" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "quote_state" "quote_state";--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "quote_authorization_iri" text;--> statement-breakpoint
-- Add this column as nullable and without an immediate default.  Existing
-- remote posts did not have quote policy data before this migration, and
-- defaulting every row to 'public' would make legacy remote posts
-- indistinguishable from cached FEP-044f public-policy posts.  The following
-- backfill intentionally touches only local posts, where Hollo owns the quote
-- policy and can derive it from existing visibility.
ALTER TABLE "posts" ADD COLUMN "quote_approval_policy" "quote_approval_policy";--> statement-breakpoint
UPDATE "posts" AS "post"
SET
  "quote_target_iri" = "target"."iri",
  "quote_state" = 'accepted'
FROM "posts" AS "target"
WHERE "post"."quote_target_id" = "target"."id";--> statement-breakpoint
UPDATE "posts"
SET "quote_approval_policy" = CASE
  WHEN "posts"."visibility" IN ('private', 'direct')
    THEN 'nobody'::"quote_approval_policy"
  ELSE 'public'::"quote_approval_policy"
END
FROM "account_owners"
WHERE "posts"."actor_id" = "account_owners"."id";--> statement-breakpoint
-- Set the default only after the local backfill.  New local posts keep the
-- public default, while persisted remote posts can still explicitly store NULL
-- when no FEP-044f interaction policy was observed.
ALTER TABLE "posts"
ALTER COLUMN "quote_approval_policy" SET DEFAULT 'public';
