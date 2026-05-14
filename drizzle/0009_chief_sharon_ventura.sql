CREATE TABLE "book_generations" (
	"book_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"theme" text,
	"mc_candidate" jsonb,
	"generate_cover_image" boolean DEFAULT false NOT NULL,
	"generation_status" text DEFAULT 'pending',
	"generation_step" text,
	"generation_error" text,
	"generation_started_at" timestamp with time zone,
	"generation_completed_at" timestamp with time zone,
	"is_refunded" timestamp,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "books_generation_status_idx";--> statement-breakpoint
ALTER TABLE "book_generations" ADD CONSTRAINT "book_generations_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "book_generations_book_idx" ON "book_generations" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "book_generations_user_idx" ON "book_generations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "book_generations_status_idx" ON "book_generations" USING btree ("generation_status");--> statement-breakpoint
CREATE INDEX "book_generations_active_idx" ON "book_generations" USING btree ("generation_status") WHERE "book_generations"."generation_status" = 'in_progress';--> statement-breakpoint
ALTER TABLE "books" DROP COLUMN "generation_status";--> statement-breakpoint
ALTER TABLE "books" DROP COLUMN "generation_progress";--> statement-breakpoint
ALTER TABLE "books" DROP COLUMN "generation_step";--> statement-breakpoint
ALTER TABLE "books" DROP COLUMN "generation_error";--> statement-breakpoint
ALTER TABLE "books" DROP COLUMN "generation_started_at";--> statement-breakpoint
ALTER TABLE "books" DROP COLUMN "generation_completed_at";