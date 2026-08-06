ALTER TABLE "pen_edits" ADD COLUMN "authoring_pov" text DEFAULT null;--> statement-breakpoint
ALTER TABLE "pen_sessions" ADD COLUMN "draft_characters_present" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "pen_sessions" ADD COLUMN "authoring_pov" text DEFAULT null;