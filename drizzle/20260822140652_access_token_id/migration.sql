ALTER TABLE "access_tokens" ADD COLUMN "id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_id_key" UNIQUE("id");--> statement-breakpoint
CREATE INDEX "access_grants_application_id_index" ON "access_grants" ("application_id");--> statement-breakpoint
CREATE INDEX "access_tokens_application_id_created_id_index" ON "access_tokens" ("application_id","created","id");--> statement-breakpoint
CREATE INDEX "access_tokens_account_owner_id_index" ON "access_tokens" ("account_owner_id");--> statement-breakpoint
CREATE INDEX "access_tokens_created_id_index" ON "access_tokens" ("created","id");--> statement-breakpoint
-- Collapse repeated scopes recorded before `scopesSchema` deduplicated them.
-- `scope` is a set per RFC 6749, so this changes no token's authority; it only
-- keeps a single token from holding an arbitrarily long array that every
-- dashboard render would have to unnest.  Restricted to rows that actually
-- repeat one, so the rewrite touches nothing on a healthy instance.
UPDATE "access_tokens" SET "scopes" = ARRAY(SELECT DISTINCT unnest("scopes") ORDER BY 1)
WHERE cardinality("scopes") > (SELECT count(DISTINCT s) FROM unnest("scopes") AS s);--> statement-breakpoint
UPDATE "access_grants" SET "scopes" = ARRAY(SELECT DISTINCT unnest("scopes") ORDER BY 1)
WHERE cardinality("scopes") > (SELECT count(DISTINCT s) FROM unnest("scopes") AS s);
