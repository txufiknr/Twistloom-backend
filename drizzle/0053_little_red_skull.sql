CREATE TABLE "lore_entries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"book_id" uuid NOT NULL,
	"entry_type" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"trigger_keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"linked_character_id" uuid,
	"linked_place_id" uuid,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lore_entries" ADD CONSTRAINT "lore_entries_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lore_entries" ADD CONSTRAINT "lore_entries_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lore_entries_book_idx" ON "lore_entries" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "lore_entries_trigger_gin_idx" ON "lore_entries" USING gin ("trigger_keywords");