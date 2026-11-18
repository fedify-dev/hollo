CREATE TYPE "custom_emoji_import_result_enum" AS ENUM('duplicate_existing', 'duplicate_in_pack');--> statement-breakpoint
CREATE TABLE "custom_emoji_import_results" (
	"id" uuid PRIMARY KEY,
	"job_id" uuid NOT NULL,
	"entry_index" integer NOT NULL,
	"original_shortcode" text NOT NULL,
	"normalized_shortcode" text NOT NULL,
	"reason" "custom_emoji_import_result_enum" NOT NULL,
	"conflicting_entry_index" integer,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX "custom_emoji_import_results_job_id_idx" ON "custom_emoji_import_results" ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_emoji_import_results_job_id_entry_index_idx" ON "custom_emoji_import_results" ("job_id","entry_index");--> statement-breakpoint
ALTER TABLE "custom_emoji_import_results" ADD CONSTRAINT "custom_emoji_import_results_axvwCIFtGtFX_fkey" FOREIGN KEY ("job_id") REFERENCES "custom_emoji_import_jobs"("id") ON DELETE CASCADE;