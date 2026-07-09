CREATE TABLE "branches" (
	"branch_id" text PRIMARY KEY NOT NULL,
	"book_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"slug" text GENERATED ALWAYS AS (lower(regexp_replace(regexp_replace(display_name, '[^a-zA-Z0-9\s]', '', 'g'), '\s+', '-', 'g'))) STORED NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branches_book_name_unique" UNIQUE("book_id","display_name"),
	CONSTRAINT "branches_book_slug_unique" UNIQUE("book_id","slug")
);
--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "branches_book_idx" ON "branches" USING btree ("book_id");