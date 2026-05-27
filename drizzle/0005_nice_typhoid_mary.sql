ALTER TABLE "story_prompts" ADD COLUMN "user_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "story_prompts" ADD COLUMN "language" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "story_prompts" ADD CONSTRAINT "story_prompts_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "story_prompts_language_idx" ON "story_prompts" USING btree ("language");--> statement-breakpoint
CREATE INDEX "story_prompts_initiator_idx" ON "story_prompts" USING btree ("user_id");