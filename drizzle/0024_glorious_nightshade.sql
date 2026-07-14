CREATE TABLE "clue_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"page_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"branch_id" text DEFAULT 'main' NOT NULL,
	"page" integer NOT NULL,
	"thread_id" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"source_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clue_embeddings_unique" UNIQUE("page_id","thread_id")
);
--> statement-breakpoint
ALTER TABLE "clue_embeddings" ADD CONSTRAINT "clue_embeddings_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clue_embeddings" ADD CONSTRAINT "clue_embeddings_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clue_embeddings_hnsw_idx" ON "clue_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "clue_embeddings_book_thread_idx" ON "clue_embeddings" USING btree ("book_id","thread_id");