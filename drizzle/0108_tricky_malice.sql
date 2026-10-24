ALTER TABLE "book_testimonials" ADD COLUMN "likes_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "last_guest_import_id" uuid;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "last_guest_import_hash" text;