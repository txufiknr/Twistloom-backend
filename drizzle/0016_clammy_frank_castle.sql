CREATE TABLE "user_completed_books" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_completed_books_user_book_unique" UNIQUE("user_id","book_id")
);
--> statement-breakpoint
ALTER TABLE "user_completed_books" ADD CONSTRAINT "user_completed_books_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_completed_books" ADD CONSTRAINT "user_completed_books_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_completed_books" ADD CONSTRAINT "user_completed_books_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_completed_books_user_idx" ON "user_completed_books" USING btree ("user_id","completed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_completed_books_book_idx" ON "user_completed_books" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "user_completed_books_branch_idx" ON "user_completed_books" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "user_completed_books_page_idx" ON "user_completed_books" USING btree ("page_id");