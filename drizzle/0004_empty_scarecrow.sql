CREATE TABLE "custom_actions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"book_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"original_text" text NOT NULL,
	"canonical_intent" text,
	"action_type" text,
	"hint_type" text,
	"outcome" text NOT NULL,
	"rejection_category" text,
	"plausibility_score" real,
	"progression_score" real,
	"credits_charged" integer DEFAULT 0 NOT NULL,
	"next_page_id" uuid,
	"language" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "story_states" ADD COLUMN "planned_characters" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "story_states" ADD COLUMN "health_status" jsonb;--> statement-breakpoint
ALTER TABLE "story_states" ADD COLUMN "sanity_state" jsonb;--> statement-breakpoint
ALTER TABLE "custom_actions" ADD CONSTRAINT "custom_actions_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_actions" ADD CONSTRAINT "custom_actions_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_actions" ADD CONSTRAINT "custom_actions_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "custom_actions_book_idx" ON "custom_actions" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "custom_actions_user_idx" ON "custom_actions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "custom_actions_outcome_idx" ON "custom_actions" USING btree ("outcome");