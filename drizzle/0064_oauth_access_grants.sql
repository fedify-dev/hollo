CREATE TABLE "access_grants" (
  "id" uuid PRIMARY KEY NOT NULL,
  "token" text NOT NULL,
  "expires_in" integer NOT NULL,
  "redirect_uri" text NOT NULL,
  "scopes" "scope" [] NOT NULL,
  "application_id" uuid NOT NULL,
  "resource_owner_id" uuid NOT NULL,
  "created" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "revoked" timestamp with time zone,
  CONSTRAINT "access_grants_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "access_grants"
ADD CONSTRAINT "access_grants_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "access_grants"
ADD CONSTRAINT "access_grants_resource_owner_id_account_owners_id_fk" FOREIGN KEY ("resource_owner_id") REFERENCES "public"."account_owners"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "access_grants_resource_owner_id_index" ON "access_grants" USING btree ("resource_owner_id");
