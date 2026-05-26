CREATE TABLE "story_prompts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"ai_provider" text,
	"ai_model" text,
	"quality_score" real DEFAULT 1,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"unique_user_count" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone,
	"last_served_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_action_hints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"action_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_action_hints_user_page_action_unique" UNIQUE("user_id","page_id","action_text")
);
--> statement-breakpoint
CREATE TABLE "user_prompt_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"prompt_id" uuid NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_for_book" boolean DEFAULT false NOT NULL,
	"book_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_prompt_history_user_prompt_unique" UNIQUE("user_id","prompt_id")
);
--> statement-breakpoint
ALTER TABLE "book_generations" ADD COLUMN "is_generating_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_action_hints" ADD CONSTRAINT "user_action_hints_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_action_hints" ADD CONSTRAINT "user_action_hints_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_prompt_history" ADD CONSTRAINT "user_prompt_history_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_prompt_history" ADD CONSTRAINT "user_prompt_history_prompt_id_story_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."story_prompts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_prompt_history" ADD CONSTRAINT "user_prompt_history_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "story_prompts_active_idx" ON "story_prompts" USING btree ("is_active") WHERE "story_prompts"."is_active" = true;--> statement-breakpoint
CREATE INDEX "story_prompts_expires_idx" ON "story_prompts" USING btree ("expires_at") WHERE "story_prompts"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "story_prompts_quality_idx" ON "story_prompts" USING btree ("quality_score" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "story_prompts_usage_idx" ON "story_prompts" USING btree ("usage_count" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "story_prompts_last_served_idx" ON "story_prompts" USING btree ("last_served_at");--> statement-breakpoint
CREATE INDEX "story_prompts_content_gin_idx" ON "story_prompts" USING gin (content gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "user_action_hints_user_idx" ON "user_action_hints" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_action_hints_page_idx" ON "user_action_hints" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "user_action_hints_created_idx" ON "user_action_hints" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_prompt_history_user_idx" ON "user_prompt_history" USING btree ("user_id","viewed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_prompt_history_prompt_idx" ON "user_prompt_history" USING btree ("prompt_id");--> statement-breakpoint
CREATE INDEX "user_prompt_history_used_idx" ON "user_prompt_history" USING btree ("used_for_book");--> statement-breakpoint
CREATE INDEX "book_generations_locking_idx" ON "book_generations" USING btree ("is_generating_started_at");