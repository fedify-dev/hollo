DROP INDEX "posts_id_index";--> statement-breakpoint
DROP INDEX "timeline_posts_account_id_post_id_index";--> statement-breakpoint
CREATE INDEX "posts_id_index" ON "posts" USING btree ("id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "timeline_posts_account_id_post_id_index" ON "timeline_posts" USING btree ("account_id","post_id" DESC NULLS FIRST);