ALTER TABLE "user_feedbacks" ADD COLUMN "admin_status" text DEFAULT 'unread' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "banned_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "user_feedbacks_admin_status_idx" ON "user_feedbacks" USING btree ("admin_status");