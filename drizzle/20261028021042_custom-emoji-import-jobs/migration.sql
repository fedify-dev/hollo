CREATE TYPE "import_custom_emoji_status_enum" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "custom_emoji_import_jobs" (
	"id" uuid PRIMARY KEY,
	"archive_key" text NOT NULL,
	"status" "import_custom_emoji_status_enum" DEFAULT 'pending'::"import_custom_emoji_status_enum" NOT NULL,
	"imported_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"completed" timestamp with time zone
);
