CREATE TABLE "pen_drafts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"session_id" uuid NOT NULL,
	"parent_page_id" uuid,
	"label" text,
	"draft_buffer" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"draft_html" text,
	"draft_characters_present" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"draft_scene_essentials" jsonb DEFAULT 'null'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pen_edits" ADD COLUMN "draft_id" uuid;--> statement-breakpoint
ALTER TABLE "pen_sessions" ADD COLUMN "active_draft_id" uuid;--> statement-breakpoint
ALTER TABLE "pen_drafts" ADD CONSTRAINT "pen_drafts_session_id_pen_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."pen_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pen_drafts" ADD CONSTRAINT "pen_drafts_parent_page_id_pages_id_fk" FOREIGN KEY ("parent_page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pen_drafts_session_idx" ON "pen_drafts" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "pen_drafts_parent_idx" ON "pen_drafts" USING btree ("parent_page_id");--> statement-breakpoint
ALTER TABLE "pen_edits" ADD CONSTRAINT "pen_edits_draft_id_pen_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."pen_drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pen_edits_draft_idx" ON "pen_edits" USING btree ("draft_id");