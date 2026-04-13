ALTER TABLE "books" ALTER COLUMN "total_pages" SET DEFAULT 120;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "ai_provider" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "ai_model" text;--> statement-breakpoint
CREATE INDEX "books_language_idx" ON "books" USING btree ("language");--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_parent_branch_unique" UNIQUE("parent_id","branch_id");