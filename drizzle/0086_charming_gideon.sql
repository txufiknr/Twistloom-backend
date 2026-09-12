ALTER TABLE "books" ADD COLUMN "front_matter" jsonb;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "front_matter_seen" boolean DEFAULT false NOT NULL;