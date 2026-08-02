ALTER TABLE "books" ADD COLUMN "rating" real;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "rating_count" integer;--> statement-breakpoint
CREATE INDEX "books_rating_idx" ON "books" USING btree ("rating" DESC NULLS LAST) WHERE "books"."rating" IS NOT NULL;