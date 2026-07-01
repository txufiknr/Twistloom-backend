ALTER TABLE "book_generations" ADD COLUMN "cancellation_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "book_generations" ADD COLUMN "ai_final_comment" text;