ALTER TABLE "pages" ADD COLUMN "score_before" integer;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "score_after" integer;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "frontier_page_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "frontier_ancestor_ids" uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL;