ALTER TABLE "book_translations" ADD COLUMN "provider_type" text;--> statement-breakpoint
ALTER TABLE "book_translations" ADD COLUMN "provider_name" text;--> statement-breakpoint
ALTER TABLE "page_translations" ADD COLUMN "provider_type" text;--> statement-breakpoint
ALTER TABLE "page_translations" ADD COLUMN "provider_name" text;--> statement-breakpoint
CREATE INDEX "books_slug_idx" ON "books" USING btree ("slug");