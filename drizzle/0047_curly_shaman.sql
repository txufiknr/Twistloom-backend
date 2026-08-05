CREATE TABLE "page_reactions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"book_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_reactions_user_page_unique" UNIQUE("user_id","page_id")
);
--> statement-breakpoint
ALTER TABLE "page_reactions" ADD CONSTRAINT "page_reactions_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_reactions" ADD CONSTRAINT "page_reactions_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_reactions" ADD CONSTRAINT "page_reactions_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_reactions_page_emoji_idx" ON "page_reactions" USING btree ("page_id","emoji");--> statement-breakpoint
CREATE INDEX "page_reactions_book_idx" ON "page_reactions" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "page_reactions_user_idx" ON "page_reactions" USING btree ("user_id");