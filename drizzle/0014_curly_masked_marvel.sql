CREATE TABLE "book_translations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"book_id" uuid NOT NULL,
	"language" text NOT NULL,
	"title" text,
	"hook" text,
	"summary" text,
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_translations_book_language_unique" UNIQUE("book_id","language")
);
--> statement-breakpoint
ALTER TABLE "books" ALTER COLUMN "total_pages" SET DEFAULT 80;--> statement-breakpoint
ALTER TABLE "page_translations" ADD COLUMN "place" text;--> statement-breakpoint
ALTER TABLE "page_translations" ADD COLUMN "key_events" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "page_translations" ADD COLUMN "important_objects" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "page_translations" ADD COLUMN "actions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "book_translations" ADD CONSTRAINT "book_translations_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "book_translations_book_idx" ON "book_translations" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "book_translations_language_idx" ON "book_translations" USING btree ("language");--> statement-breakpoint
CREATE INDEX "book_translations_created_idx" ON "book_translations" USING btree ("created_at" DESC NULLS LAST);