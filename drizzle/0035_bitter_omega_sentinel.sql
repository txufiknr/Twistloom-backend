CREATE TABLE "canon_validations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"book_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"violation_type" text,
	"description" text DEFAULT '' NOT NULL,
	"severity_score" real,
	"violations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"was_revised" boolean DEFAULT false NOT NULL,
	"rewrite_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "canon_validations" ADD CONSTRAINT "canon_validations_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canon_validations" ADD CONSTRAINT "canon_validations_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "canon_validations_book_idx" ON "canon_validations" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "canon_validations_page_idx" ON "canon_validations" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "canon_validations_outcome_idx" ON "canon_validations" USING btree ("outcome");