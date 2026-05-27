CREATE TABLE "user_purchased_books" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"credits_price" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_purchased_books_user_book_unique" UNIQUE("user_id","book_id")
);
--> statement-breakpoint
ALTER TABLE "user_purchased_books" ADD CONSTRAINT "user_purchased_books_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_purchased_books" ADD CONSTRAINT "user_purchased_books_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_purchased_books_user_idx" ON "user_purchased_books" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_purchased_books_book_idx" ON "user_purchased_books" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "user_purchased_books_created_idx" ON "user_purchased_books" USING btree ("created_at" DESC NULLS LAST);