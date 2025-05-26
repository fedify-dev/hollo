ALTER TABLE "access_grants" ADD COLUMN "code_challenge" text;--> statement-breakpoint
ALTER TABLE "access_grants" ADD COLUMN "code_challenge_method" varchar(256);