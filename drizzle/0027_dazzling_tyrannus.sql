ALTER TABLE "book_generations" ADD COLUMN "mode" text DEFAULT 'interactive' NOT NULL;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "mode" text DEFAULT 'interactive' NOT NULL;