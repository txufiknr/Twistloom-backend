CREATE TABLE "user_story_anchors" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"page_number" integer DEFAULT 1 NOT NULL,
	"choice_prompt" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "book_testimonials" ADD COLUMN "curator_quill" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "prism_pages_remaining" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_story_anchors" ADD CONSTRAINT "user_story_anchors_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_story_anchors" ADD CONSTRAINT "user_story_anchors_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_story_anchors" ADD CONSTRAINT "user_story_anchors_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_story_anchors_user_book_idx" ON "user_story_anchors" USING btree ("user_id","book_id");