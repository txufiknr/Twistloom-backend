CREATE TABLE "books" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"total_pages" integer DEFAULT 150 NOT NULL,
	"language" text,
	"hook" text,
	"summary" text,
	"image" text,
	"image_id" text,
	"trending_score" real DEFAULT 0,
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active',
	"mc" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deleted_images" (
	"file_id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"parent_id" uuid,
	"branch_id" text DEFAULT 'main' NOT NULL,
	"book_id" uuid NOT NULL,
	"page" integer NOT NULL,
	"text" text NOT NULL,
	"mood" text,
	"place" text,
	"time_of_day" text,
	"characters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"key_events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"important_objects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"add_trauma_tag" text,
	"character_updates" jsonb,
	"place_updates" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "story_state_deltas" (
	"user_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"delta" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "story_state_deltas_user_id_book_id_page_id_pk" PRIMARY KEY("user_id","book_id","page_id")
);
--> statement-breakpoint
CREATE TABLE "story_state_snapshots" (
	"user_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"state" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_major_checkpoint" boolean DEFAULT false NOT NULL,
	"reason" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "story_state_snapshots_user_id_book_id_page_id_pk" PRIMARY KEY("user_id","book_id","page_id")
);
--> statement-breakpoint
CREATE TABLE "story_states" (
	"user_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"page" integer NOT NULL,
	"max_page" integer NOT NULL,
	"flags" jsonb NOT NULL,
	"trauma_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"psychological_profile" jsonb NOT NULL,
	"hidden_state" jsonb NOT NULL,
	"memory_integrity" text DEFAULT 'stable' NOT NULL,
	"difficulty" text DEFAULT 'low' NOT NULL,
	"ending" text,
	"characters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"places" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"page_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actions_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"context_history" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "story_states_user_id_book_id_page_id_pk" PRIMARY KEY("user_id","book_id","page_id")
);
--> statement-breakpoint
CREATE TABLE "usage" (
	"date" text NOT NULL,
	"provider" text NOT NULL,
	"requests" integer,
	"context" text,
	CONSTRAINT "usage_date_provider_context_pk" PRIMARY KEY("date","provider","context")
);
--> statement-breakpoint
CREATE TABLE "user_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"parent_comment_id" uuid,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_devices" (
	"user_id" uuid NOT NULL,
	"platform" text,
	"app_version" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_devices_user_id_platform_app_version_pk" PRIMARY KEY("user_id","platform","app_version")
);
--> statement-breakpoint
CREATE TABLE "user_favorites" (
	"user_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_favorites_user_id_book_id_pk" PRIMARY KEY("user_id","book_id")
);
--> statement-breakpoint
CREATE TABLE "user_likes" (
	"user_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_likes_user_id_target_type_target_id_pk" PRIMARY KEY("user_id","target_type","target_id")
);
--> statement-breakpoint
CREATE TABLE "user_page_progress" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"action" jsonb NOT NULL,
	"next_page_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_page_progress_user_book_page_unique" UNIQUE("user_id","book_id","page_id")
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"previous_page_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_sessions_user_book_unique" UNIQUE("user_id","book_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"name" text,
	"gender" text,
	"image" text,
	"image_id" text,
	"last_active" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "books_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_state_deltas" ADD CONSTRAINT "story_state_deltas_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_state_deltas" ADD CONSTRAINT "story_state_deltas_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_state_deltas" ADD CONSTRAINT "story_state_deltas_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_state_snapshots" ADD CONSTRAINT "story_state_snapshots_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_state_snapshots" ADD CONSTRAINT "story_state_snapshots_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_state_snapshots" ADD CONSTRAINT "story_state_snapshots_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_states" ADD CONSTRAINT "story_states_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_states" ADD CONSTRAINT "story_states_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_comments" ADD CONSTRAINT "user_comments_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_favorites" ADD CONSTRAINT "user_favorites_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_page_progress" ADD CONSTRAINT "user_page_progress_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_page_progress" ADD CONSTRAINT "user_page_progress_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "books_trending_score_idx" ON "books" USING btree ("trending_score");--> statement-breakpoint
CREATE INDEX "books_recent_idx" ON "books" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "books_trending_idx" ON "books" USING btree ("status" DESC NULLS LAST,"trending_score" DESC NULLS LAST,"updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "books_user_idx" ON "books" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "books_status_idx" ON "books" USING btree ("status");--> statement-breakpoint
CREATE INDEX "deleted_images_created_idx" ON "deleted_images" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "pages_book_page_idx" ON "pages" USING btree ("book_id","page");--> statement-breakpoint
CREATE INDEX "pages_book_order_idx" ON "pages" USING btree ("book_id","page" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "pages_created_at_idx" ON "pages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "story_state_deltas_user_book_idx" ON "story_state_deltas" USING btree ("user_id","book_id");--> statement-breakpoint
CREATE INDEX "story_state_deltas_page_idx" ON "story_state_deltas" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "story_state_deltas_created_idx" ON "story_state_deltas" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "story_state_snapshots_user_book_idx" ON "story_state_snapshots" USING btree ("user_id","book_id");--> statement-breakpoint
CREATE INDEX "story_state_snapshots_page_idx" ON "story_state_snapshots" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "story_state_snapshots_created_idx" ON "story_state_snapshots" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "story_state_snapshots_major_idx" ON "story_state_snapshots" USING btree ("is_major_checkpoint","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "story_state_snapshots_reason_idx" ON "story_state_snapshots" USING btree ("reason");--> statement-breakpoint
CREATE INDEX "story_states_page_idx" ON "story_states" USING btree ("page");--> statement-breakpoint
CREATE INDEX "story_states_difficulty_idx" ON "story_states" USING btree ("difficulty");--> statement-breakpoint
CREATE INDEX "story_states_progress_idx" ON "story_states" USING btree ("page" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_cache_payload_gin" ON "user_cache" USING gin ("payload");--> statement-breakpoint
CREATE INDEX "user_cache_updated_at_idx" ON "user_cache" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "user_comments_user_idx" ON "user_comments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_comments_book_idx" ON "user_comments" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "user_comments_parent_idx" ON "user_comments" USING btree ("parent_comment_id");--> statement-breakpoint
CREATE INDEX "user_comments_created_idx" ON "user_comments" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_comments_book_order_idx" ON "user_comments" USING btree ("book_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_devices_user_idx" ON "user_devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_devices_platform_idx" ON "user_devices" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "user_devices_version_idx" ON "user_devices" USING btree ("app_version");--> statement-breakpoint
CREATE INDEX "user_devices_first_seen_idx" ON "user_devices" USING btree ("first_seen_at");--> statement-breakpoint
CREATE INDEX "user_favorites_user_idx" ON "user_favorites" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_favorites_book_idx" ON "user_favorites" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "user_favorites_created_idx" ON "user_favorites" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_likes_user_idx" ON "user_likes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_likes_target_idx" ON "user_likes" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "user_likes_created_idx" ON "user_likes" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_page_progress_user_book_idx" ON "user_page_progress" USING btree ("user_id","book_id");--> statement-breakpoint
CREATE INDEX "user_page_progress_page_idx" ON "user_page_progress" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "user_sessions_status_idx" ON "user_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "user_sessions_user_active_idx" ON "user_sessions" USING btree ("user_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "users_gender_idx" ON "users" USING btree ("gender");--> statement-breakpoint
CREATE INDEX "users_created_at_idx" ON "users" USING btree ("created_at");