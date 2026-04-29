ALTER TABLE "posts"
ALTER COLUMN "quote_approval_policy" DROP NOT NULL;--> statement-breakpoint
-- Migration 0086 defaulted every existing post to 'public', so cached remote
-- legacy posts and cached remote FEP-044f public posts are indistinguishable
-- here.  Prefer preserving legacy interoperability for old cached remote
-- posts; limited FEP policies such as 'followers' and 'nobody' remain intact.
UPDATE "posts"
SET "quote_approval_policy" = NULL
WHERE "quote_approval_policy" = 'public'
AND "actor_id" NOT IN (
  SELECT "id"
  FROM "account_owners"
);
