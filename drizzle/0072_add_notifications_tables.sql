CREATE TYPE "public"."notification_type" AS ENUM('mention', 'status', 'reblog', 'follow', 'follow_request', 'favourite', 'emoji_reaction', 'poll', 'update', 'admin.sign_up', 'admin.report');--> statement-breakpoint
CREATE TABLE "notification_groups" (
	"group_key" text PRIMARY KEY NOT NULL,
	"account_owner_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"target_post_id" uuid,
	"notifications_count" integer DEFAULT 0 NOT NULL,
	"most_recent_notification_id" uuid,
	"sample_account_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"latest_page_notification_at" timestamp with time zone,
	"page_min_id" uuid,
	"page_max_id" uuid,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_owner_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"actor_account_id" uuid,
	"target_post_id" uuid,
	"target_account_id" uuid,
	"target_poll_id" uuid,
	"group_key" text NOT NULL,
	"created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "notification_groups" ADD CONSTRAINT "notification_groups_account_owner_id_account_owners_id_fk" FOREIGN KEY ("account_owner_id") REFERENCES "public"."account_owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_groups" ADD CONSTRAINT "notification_groups_target_post_id_posts_id_fk" FOREIGN KEY ("target_post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_groups" ADD CONSTRAINT "notification_groups_most_recent_notification_id_notifications_id_fk" FOREIGN KEY ("most_recent_notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_account_owner_id_account_owners_id_fk" FOREIGN KEY ("account_owner_id") REFERENCES "public"."account_owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_target_post_id_posts_id_fk" FOREIGN KEY ("target_post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_target_account_id_accounts_id_fk" FOREIGN KEY ("target_account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_target_poll_id_polls_id_fk" FOREIGN KEY ("target_poll_id") REFERENCES "public"."polls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_groups_account_owner_id_updated_index" ON "notification_groups" USING btree ("account_owner_id","updated");--> statement-breakpoint
CREATE INDEX "notification_groups_account_owner_id_type_index" ON "notification_groups" USING btree ("account_owner_id","type");--> statement-breakpoint
CREATE INDEX "notifications_account_owner_id_created_index" ON "notifications" USING btree ("account_owner_id","created");--> statement-breakpoint
CREATE INDEX "notifications_account_owner_id_read_at_index" ON "notifications" USING btree ("account_owner_id","read_at");--> statement-breakpoint
CREATE INDEX "notifications_group_key_index" ON "notifications" USING btree ("group_key");--> statement-breakpoint
CREATE INDEX "notifications_created_index" ON "notifications" USING btree ("created");