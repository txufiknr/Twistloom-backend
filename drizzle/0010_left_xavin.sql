ALTER TABLE "book_generations" ADD COLUMN "advanced_options" jsonb;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "visibility" text DEFAULT 'private' NOT NULL;