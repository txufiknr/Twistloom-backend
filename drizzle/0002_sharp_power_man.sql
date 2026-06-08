DROP INDEX "pages_pending_generation_idx";--> statement-breakpoint
ALTER TABLE "book_translations" ADD COLUMN "ai_model" text;--> statement-breakpoint
ALTER TABLE "page_translations" ADD COLUMN "time_of_day" text;--> statement-breakpoint
ALTER TABLE "page_translations" ADD COLUMN "mood" text;--> statement-breakpoint
ALTER TABLE "page_translations" ADD COLUMN "weather" text;--> statement-breakpoint
ALTER TABLE "page_translations" ADD COLUMN "context_history" text;--> statement-breakpoint
ALTER TABLE "page_translations" ADD COLUMN "ai_model" text;--> statement-breakpoint
ALTER TABLE "pages" DROP COLUMN "pending_generation_count";