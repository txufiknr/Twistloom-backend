CREATE TABLE "saved_paths" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"fork_page_id" uuid NOT NULL,
	"alternative_next_page_id" uuid NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_paths_user_book_fork_alt_unique" UNIQUE("user_id","book_id","fork_page_id","alternative_next_page_id")
);
--> statement-breakpoint
ALTER TABLE "saved_paths" ADD CONSTRAINT "saved_paths_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_paths" ADD CONSTRAINT "saved_paths_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_paths" ADD CONSTRAINT "saved_paths_fork_page_id_pages_id_fk" FOREIGN KEY ("fork_page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_paths" ADD CONSTRAINT "saved_paths_alternative_next_page_id_pages_id_fk" FOREIGN KEY ("alternative_next_page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saved_paths_user_idx" ON "saved_paths" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "saved_paths_book_idx" ON "saved_paths" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "saved_paths_created_idx" ON "saved_paths" USING btree ("created_at" DESC NULLS LAST);