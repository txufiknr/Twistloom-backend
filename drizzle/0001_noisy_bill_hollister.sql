ALTER TABLE "user_counters" ADD COLUMN "topup_credits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_counters" ADD COLUMN "referred_users" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_counters" ADD COLUMN "followers_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_counters" ADD COLUMN "active_checkin_streak" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_counters" ADD COLUMN "max_checkin_streak" integer DEFAULT 0 NOT NULL;