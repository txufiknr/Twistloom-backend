ALTER TABLE "user_page_progress" DROP CONSTRAINT "user_page_progress_user_id_users_user_id_fk";
--> statement-breakpoint
ALTER TABLE "user_page_progress" DROP CONSTRAINT "user_page_progress_book_id_books_id_fk";
--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "generation_status" text DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "generation_progress" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "generation_error" text;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "generation_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "generation_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_page_progress" ADD CONSTRAINT "user_page_progress_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_page_progress" ADD CONSTRAINT "user_page_progress_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "books_generation_status_idx" ON "books" USING btree ("generation_status");