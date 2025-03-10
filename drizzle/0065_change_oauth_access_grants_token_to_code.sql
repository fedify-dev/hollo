ALTER TABLE "access_grants" RENAME COLUMN "token" TO "code";--> statement-breakpoint
ALTER TABLE "access_grants" DROP CONSTRAINT "access_grants_token_unique";--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_code_unique" UNIQUE("code");