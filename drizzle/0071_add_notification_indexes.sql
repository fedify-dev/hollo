CREATE INDEX "follows_following_id_approved_index" ON "follows" USING btree ("following_id","approved") WHERE "follows"."approved" is not null;--> statement-breakpoint
CREATE INDEX "follows_following_id_created_index" ON "follows" USING btree ("following_id","created");--> statement-breakpoint
CREATE INDEX "likes_created_index" ON "likes" USING btree ("created");--> statement-breakpoint
CREATE INDEX "mutes_account_id_index" ON "mutes" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "reactions_created_index" ON "reactions" USING btree ("created");