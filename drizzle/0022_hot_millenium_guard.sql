CREATE TABLE "character_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"page_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"branch_id" text DEFAULT 'main' NOT NULL,
	"page" integer NOT NULL,
	"character_id" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"source_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "character_embeddings_unique" UNIQUE("page_id","character_id")
);
--> statement-breakpoint
CREATE TABLE "future_note_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"page_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"branch_id" text DEFAULT 'main' NOT NULL,
	"note_key" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"source_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "future_note_embeddings_unique" UNIQUE("book_id","branch_id","note_key")
);
--> statement-breakpoint
CREATE TABLE "page_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"page_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"branch_id" text DEFAULT 'main' NOT NULL,
	"page" integer NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"source_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_embeddings_page_unique" UNIQUE("page_id")
);
--> statement-breakpoint
CREATE TABLE "place_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"page_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"branch_id" text DEFAULT 'main' NOT NULL,
	"page" integer NOT NULL,
	"place_id" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"source_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "place_embeddings_unique" UNIQUE("page_id","place_id")
);
--> statement-breakpoint
ALTER TABLE "character_embeddings" ADD CONSTRAINT "character_embeddings_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_embeddings" ADD CONSTRAINT "character_embeddings_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "future_note_embeddings" ADD CONSTRAINT "future_note_embeddings_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "future_note_embeddings" ADD CONSTRAINT "future_note_embeddings_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_embeddings" ADD CONSTRAINT "page_embeddings_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_embeddings" ADD CONSTRAINT "page_embeddings_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_embeddings" ADD CONSTRAINT "place_embeddings_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_embeddings" ADD CONSTRAINT "place_embeddings_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "character_embeddings_hnsw_idx" ON "character_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "character_embeddings_book_char_idx" ON "character_embeddings" USING btree ("book_id","character_id");--> statement-breakpoint
CREATE INDEX "future_note_embeddings_hnsw_idx" ON "future_note_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "page_embeddings_hnsw_idx" ON "page_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "page_embeddings_book_branch_idx" ON "page_embeddings" USING btree ("book_id","branch_id");--> statement-breakpoint
CREATE INDEX "place_embeddings_hnsw_idx" ON "place_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "place_embeddings_book_place_idx" ON "place_embeddings" USING btree ("book_id","place_id");