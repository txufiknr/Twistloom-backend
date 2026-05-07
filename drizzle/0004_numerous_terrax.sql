ALTER TABLE "user_page_progress" RENAME COLUMN "page_id" TO "actioned_page_id";--> statement-breakpoint
ALTER TABLE "user_page_progress" DROP CONSTRAINT "user_page_progress_user_book_page_unique";--> statement-breakpoint
DROP INDEX "user_page_progress_page_idx";--> statement-breakpoint
ALTER TABLE "user_page_progress" ALTER COLUMN "next_page_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "user_page_progress_page_idx" ON "user_page_progress" USING btree ("actioned_page_id");--> statement-breakpoint
ALTER TABLE "user_page_progress" ADD CONSTRAINT "user_page_progress_user_book_page_unique" UNIQUE("user_id","book_id","actioned_page_id");