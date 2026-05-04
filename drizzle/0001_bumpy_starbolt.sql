CREATE TABLE "page_translations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"page_id" uuid NOT NULL,
	"language" text NOT NULL,
	"translated_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_translations_page_language_unique" UNIQUE("page_id","language")
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "context" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "page_translations" ADD CONSTRAINT "page_translations_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_translations_page_idx" ON "page_translations" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "page_translations_language_idx" ON "page_translations" USING btree ("language");--> statement-breakpoint
CREATE INDEX "page_translations_created_idx" ON "page_translations" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transactions_context_idx" ON "transactions" USING btree ("context");