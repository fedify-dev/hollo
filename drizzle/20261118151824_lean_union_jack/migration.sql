ALTER TABLE "custom_emoji_import_results" ALTER COLUMN "reason" SET DATA TYPE text;--> statement-breakpoint
UPDATE "custom_emoji_import_results"
SET "reason" = CASE "reason"
  WHEN 'unsafe_path' THEN 'unsafe_file_path'
  WHEN 'missing_file' THEN 'image_missing'
  WHEN 'unsupported_image' THEN 'unsupported_image_type'
  WHEN 'invalid_image' THEN 'invalid_or_corrupt_image'
  ELSE "reason"
END;
--> statement-breakpoint
DROP TYPE "custom_emoji_import_result_enum";--> statement-breakpoint
CREATE TYPE "custom_emoji_import_result_enum" AS ENUM('duplicate_existing', 'duplicate_in_pack', 'not_downloaded', 'unsafe_file_path', 'image_missing', 'invalid_shortcode', 'unsupported_image_type', 'image_too_large', 'invalid_or_corrupt_image', 'import_failed');--> statement-breakpoint
ALTER TABLE "custom_emoji_import_results" ALTER COLUMN "reason" SET DATA TYPE "custom_emoji_import_result_enum" USING "reason"::"custom_emoji_import_result_enum";
