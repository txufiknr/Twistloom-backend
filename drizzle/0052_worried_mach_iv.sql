ALTER TABLE "books" ADD COLUMN "is_pen_book" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "authoring_status" text DEFAULT 'draft' NOT NULL;