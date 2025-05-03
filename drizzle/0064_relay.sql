CREATE TYPE "public"."relay_state" AS ENUM('idle', 'pending', 'accepted', 'rejected');--> statement-breakpoint
CREATE TABLE "relays" (
	"relay_server_actor_id" uuid,
	"state" "relay_state" DEFAULT 'idle' NOT NULL,
	"follow_request_id" text NOT NULL,
	"inbox_url" text PRIMARY KEY NOT NULL,
	"relay_client_actor_id" uuid NOT NULL,
	CONSTRAINT "relays_follow_request_id_unique" UNIQUE("follow_request_id")
);
--> statement-breakpoint
ALTER TABLE "relays" ADD CONSTRAINT "relays_relay_server_actor_id_accounts_id_fk" FOREIGN KEY ("relay_server_actor_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relays" ADD CONSTRAINT "relays_relay_client_actor_id_accounts_id_fk" FOREIGN KEY ("relay_client_actor_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;