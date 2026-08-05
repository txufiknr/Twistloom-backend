CREATE TABLE "pen_edits" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"page_id" uuid,
	"edit_type" text NOT NULL,
	"author_input" text,
	"ai_output" text,
	"final_text" text,
	"context_page_id" uuid,
	"char_offset_start" integer,
	"char_offset_end" integer,
	"authoring_mode" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pen_sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"authoring_mode" text NOT NULL,
	"current_page_id" uuid,
	"draft_buffer" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assistance_level" real DEFAULT 0.5 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pen_sessions_user_book_unique" UNIQUE("user_id","book_id")
);
--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "canon_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "authorship_origin" text DEFAULT 'ai';--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "human_author_user_id" uuid;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "ai_contribution_percent" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "editor_prefs" jsonb DEFAULT '{"background":"default","fontFamily":"serif","fontSize":17,"textColor":"default","lineHeight":1.7,"contentWidth":"medium"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "pen_edits" ADD CONSTRAINT "pen_edits_session_id_pen_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."pen_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pen_edits" ADD CONSTRAINT "pen_edits_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pen_edits" ADD CONSTRAINT "pen_edits_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pen_edits" ADD CONSTRAINT "pen_edits_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pen_edits" ADD CONSTRAINT "pen_edits_context_page_id_pages_id_fk" FOREIGN KEY ("context_page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pen_sessions" ADD CONSTRAINT "pen_sessions_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pen_sessions" ADD CONSTRAINT "pen_sessions_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pen_sessions" ADD CONSTRAINT "pen_sessions_current_page_id_pages_id_fk" FOREIGN KEY ("current_page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pen_edits_session_idx" ON "pen_edits" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "pen_edits_book_idx" ON "pen_edits" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "pen_edits_page_idx" ON "pen_edits" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "pen_sessions_status_idx" ON "pen_sessions" USING btree ("status");--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_human_author_user_id_users_user_id_fk" FOREIGN KEY ("human_author_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;