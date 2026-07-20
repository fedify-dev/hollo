ALTER TABLE "media" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;

WITH "ranked_media" AS (
	SELECT
		"id",
		(row_number() OVER (
			PARTITION BY "post_id"
			ORDER BY "created", "id"
		) - 1)::integer AS "position"
	FROM "media"
	WHERE "post_id" IS NOT NULL
)
UPDATE "media"
SET "position" = "ranked_media"."position"
FROM "ranked_media"
WHERE "media"."id" = "ranked_media"."id";
