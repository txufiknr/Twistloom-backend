ALTER TABLE "books" ADD COLUMN "comments_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "complete_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "user_comments_book_parent_idx" ON "user_comments" USING btree ("book_id","parent_comment_id");--> statement-breakpoint
CREATE INDEX "user_page_progress_book_actioned_idx" ON "user_page_progress" USING btree ("book_id","actioned_page_id");