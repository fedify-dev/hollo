-- Repair historically double-encoded JSON columns before enforcing the
-- json_typeof() = 'object' CHECK constraints below.
--
-- Older Drizzle ORM (<= 0.30.x) pre-stringified `json` column values in
-- PgJson.mapToDriverValue(), and postgres.js then stringified them again in
-- its json serializer.  This double `JSON.stringify()` stored the value as a
-- JSON *string* (json_typeof = 'string') instead of a JSON *object*.  Older
-- Drizzle hid this on read by re-parsing string values, but Drizzle 1.0's
-- codec-based json/jsonb columns no longer do, so `Object.entries()` over such
-- a value now explodes it into one entry per character (issue #504).
--
-- `col #>> '{}'` extracts the JSON string's text content (the original
-- once-stringified object), and casting it back to json/jsonb restores the
-- object.  Only the legacy `json` column path was affected; the `jsonb`
-- (emojis) and account_owners.fields updates are harmless no-ops on instances
-- that were never corrupted.
UPDATE "accounts" SET "field_htmls" = ("field_htmls" #>> '{}')::json WHERE json_typeof("field_htmls") = 'string';--> statement-breakpoint
UPDATE "accounts" SET "emojis" = ("emojis" #>> '{}')::jsonb WHERE jsonb_typeof("emojis") = 'string';--> statement-breakpoint
UPDATE "account_owners" SET "fields" = ("fields" #>> '{}')::json WHERE json_typeof("fields") = 'string';--> statement-breakpoint
ALTER TABLE "account_owners" ADD CONSTRAINT "ck_account_owners_fields_object" CHECK (json_typeof("fields") = 'object');--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "ck_accounts_field_htmls_object" CHECK (json_typeof("field_htmls") = 'object');--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "ck_accounts_emojis_object" CHECK (jsonb_typeof("emojis") = 'object');
