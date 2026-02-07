ALTER TABLE "posts" ADD COLUMN "quotes_count" bigint DEFAULT 0;--> statement-breakpoint
UPDATE "posts" SET "quotes_count" = (
  SELECT COUNT(*) FROM "posts" AS q WHERE q."quote_target_id" = "posts"."id"
);
