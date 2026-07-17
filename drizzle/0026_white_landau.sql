ALTER TABLE "user_comments" ADD COLUMN "paragraph_number" integer;--> statement-breakpoint
CREATE INDEX "user_comments_book_page_idx" ON "user_comments" USING btree ("book_id","page_id");--> statement-breakpoint
CREATE INDEX "user_comments_book_page_para_idx" ON "user_comments" USING btree ("book_id","page_id","paragraph_number");