-- Phase 4 cleanup (PEN_DRAFT_SHELF_ROADMAP.md §9.4): drop the legacy
-- `pen_sessions` draft columns. They are no longer read or written — the payload
-- exposes them as a view of the active `pen_drafts` row (toPenSessionPayload).
--
-- ⚠️ MUST be applied AFTER the one-time backfill (`bun run db:backfill-pen-drafts`),
-- or the stranded legacy draft data in these columns is permanently lost.
ALTER TABLE "pen_sessions" DROP COLUMN "draft_buffer";--> statement-breakpoint
ALTER TABLE "pen_sessions" DROP COLUMN "draft_html";--> statement-breakpoint
ALTER TABLE "pen_sessions" DROP COLUMN "draft_characters_present";--> statement-breakpoint
ALTER TABLE "pen_sessions" DROP COLUMN "draft_scene_essentials";