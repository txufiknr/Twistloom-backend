CREATE TABLE "book_place_bgm" (
	"book_id" uuid NOT NULL,
	"place_id" text NOT NULL,
	"primary_url" text,
	"primary_file_id" text,
	"variant_url" text,
	"variant_file_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_place_bgm_book_id_place_id_pk" PRIMARY KEY("book_id","place_id")
);
--> statement-breakpoint
CREATE TABLE "post_comments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"post_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"parent_id" uuid,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"client_request_id" uuid,
	"wall_user_id" uuid,
	"channel_id" uuid,
	"type" text DEFAULT 'text' NOT NULL,
	"content" text NOT NULL,
	"flair" text,
	"book_id" uuid,
	"page_id" uuid,
	"achievement_id" text,
	"attachment_snapshot" jsonb,
	"is_spoiler" boolean DEFAULT false NOT NULL,
	"is_locked" boolean DEFAULT false NOT NULL,
	"pinned_at" timestamp with time zone,
	"pinned_by_user_id" uuid,
	"hidden_by_wall_owner_at" timestamp with time zone,
	"likes_count" integer DEFAULT 0 NOT NULL,
	"comments_count" integer DEFAULT 0 NOT NULL,
	"saves_count" integer DEFAULT 0 NOT NULL,
	"reaction_counts" jsonb DEFAULT '{"heart":0,"candle":0,"mind":0,"magnifier":0,"broken_heart":0}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_audio_library" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"file_url" text NOT NULL,
	"file_id" text NOT NULL,
	"file_name" text,
	"file_size" integer,
	"duration_sec" real,
	"mime_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_saved_posts" (
	"user_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_saved_posts_user_id_post_id_pk" PRIMARY KEY("user_id","post_id")
);
--> statement-breakpoint
ALTER TABLE "books" ALTER COLUMN "total_pages" SET DEFAULT 60;--> statement-breakpoint
ALTER TABLE "books" ADD COLUMN "bgm_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "lore_entries" ADD COLUMN "bgm_primary_library_id" uuid;--> statement-breakpoint
ALTER TABLE "lore_entries" ADD COLUMN "bgm_primary_url" text;--> statement-breakpoint
ALTER TABLE "lore_entries" ADD COLUMN "bgm_primary_file_id" text;--> statement-breakpoint
ALTER TABLE "lore_entries" ADD COLUMN "bgm_variant_library_id" uuid;--> statement-breakpoint
ALTER TABLE "lore_entries" ADD COLUMN "bgm_variant_url" text;--> statement-breakpoint
ALTER TABLE "lore_entries" ADD COLUMN "bgm_variant_file_id" text;--> statement-breakpoint
ALTER TABLE "story_states" ADD COLUMN "scene_anchor" jsonb;--> statement-breakpoint
ALTER TABLE "user_counters" ADD COLUMN "wall_notes_posted" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_counters" ADD COLUMN "wall_note_likes_received" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_counters" ADD COLUMN "endings_shared_to_wall" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_likes" ADD COLUMN "reaction" text;--> statement-breakpoint
ALTER TABLE "book_place_bgm" ADD CONSTRAINT "book_place_bgm_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_comments" ADD CONSTRAINT "post_comments_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_comments" ADD CONSTRAINT "post_comments_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_comments" ADD CONSTRAINT "post_comments_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."post_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_wall_user_id_users_user_id_fk" FOREIGN KEY ("wall_user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_pinned_by_user_id_users_user_id_fk" FOREIGN KEY ("pinned_by_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_audio_library" ADD CONSTRAINT "user_audio_library_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_saved_posts" ADD CONSTRAINT "user_saved_posts_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_saved_posts" ADD CONSTRAINT "user_saved_posts_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "book_place_bgm_book_idx" ON "book_place_bgm" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "post_comments_post_created_idx" ON "post_comments" USING btree ("post_id","created_at","id") WHERE "post_comments"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "post_comments_user_created_idx" ON "post_comments" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "posts_user_feed_idx" ON "posts" USING btree ("user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "posts"."wall_user_id" IS NULL AND "posts"."channel_id" IS NULL AND "posts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "posts_discover_idx" ON "posts" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "posts"."wall_user_id" IS NULL AND "posts"."channel_id" IS NULL AND "posts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "posts_profile_wall_idx" ON "posts" USING btree ("wall_user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "posts"."wall_user_id" IS NOT NULL AND "posts"."channel_id" IS NULL AND "posts"."deleted_at" IS NULL AND "posts"."hidden_by_wall_owner_at" IS NULL;--> statement-breakpoint
CREATE INDEX "posts_book_idx" ON "posts" USING btree ("book_id") WHERE "posts"."book_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "posts_flair_created_idx" ON "posts" USING btree ("flair","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "posts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "posts_user_client_request_unique" ON "posts" USING btree ("user_id","client_request_id") WHERE "posts"."client_request_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "posts_profile_pinned_unique" ON "posts" USING btree (COALESCE("wall_user_id", "user_id")) WHERE "posts"."pinned_at" IS NOT NULL AND "posts"."deleted_at" IS NULL AND "posts"."hidden_by_wall_owner_at" IS NULL;--> statement-breakpoint
CREATE INDEX "user_audio_library_user_idx" ON "user_audio_library" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_saved_posts_user_created_idx" ON "user_saved_posts" USING btree ("user_id","created_at" DESC NULLS LAST,"post_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_saved_posts_post_idx" ON "user_saved_posts" USING btree ("post_id");