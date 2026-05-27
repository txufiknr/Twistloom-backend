ALTER TABLE "book_generations" ADD COLUMN "language" text;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "credits_price" integer;--> statement-breakpoint
ALTER TABLE "story_states" ADD COLUMN "future_notes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "referrer_id" uuid;