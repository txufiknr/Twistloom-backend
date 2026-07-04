ALTER TABLE "user_completed_books" DROP CONSTRAINT "user_completed_books_user_book_unique";--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "completion_rate" real;--> statement-breakpoint
ALTER TABLE "user_completed_books" ADD CONSTRAINT "user_completed_books_user_book_page_unique" UNIQUE("user_id","book_id","page_id");