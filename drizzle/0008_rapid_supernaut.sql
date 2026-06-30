ALTER TABLE "user_checkins" DROP CONSTRAINT "user_checkins_user_date_unique";--> statement-breakpoint
ALTER TABLE "user_checkins" ADD COLUMN "claim_type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "user_checkins" ADD CONSTRAINT "user_checkins_user_date_type_unique" UNIQUE("user_id","date","claim_type");