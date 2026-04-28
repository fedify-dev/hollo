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
ALTER TABLE "posts" ADD COLUMN "quote_approval_policy" "quote_approval_policy" DEFAULT 'public' NOT NULL;--> statement-breakpoint
UPDATE "posts" AS "post"
SET
  "quote_target_iri" = "target"."iri",
  "quote_state" = 'accepted'
FROM "posts" AS "target"
WHERE "post"."quote_target_id" = "target"."id";--> statement-breakpoint
UPDATE "posts"
SET "quote_approval_policy" = 'nobody'
WHERE "visibility" IN ('private', 'direct');
