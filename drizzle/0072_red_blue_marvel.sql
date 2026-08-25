CREATE TABLE "companion_answers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"sources" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"suggested_follow_ups" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"question_hash" text NOT NULL,
	"ai_provider" text,
	"ai_model" text,
	"tokens_used" integer,
	"cost_credits" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companion_answers_user_book_page_hash_unique" UNIQUE("user_id","book_id","page_id","question_hash")
);
--> statement-breakpoint
ALTER TABLE "companion_answers" ADD CONSTRAINT "companion_answers_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion_answers" ADD CONSTRAINT "companion_answers_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companion_answers" ADD CONSTRAINT "companion_answers_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "companion_answers_user_book_idx" ON "companion_answers" USING btree ("user_id","book_id");--> statement-breakpoint
CREATE INDEX "companion_answers_page_idx" ON "companion_answers" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "companion_answers_created_idx" ON "companion_answers" USING btree ("created_at" DESC NULLS LAST);