CREATE TABLE "user_social_links" (
	"user_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"url" text NOT NULL,
	CONSTRAINT "user_social_links_user_id_platform_pk" PRIMARY KEY("user_id","platform")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "pinned_story_ids" uuid[];--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "featured_story_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "featured_story_note" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "favorite_story_ids" uuid[];--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "lore_status_text" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "lore_status_icon" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "lore_status_story_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "lore_status_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "lore_status_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_social_links" ADD CONSTRAINT "user_social_links_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_social_links_user_idx" ON "user_social_links" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_social_links_platform_idx" ON "user_social_links" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "users_featured_story_id_idx" ON "users" USING btree ("featured_story_id") WHERE "users"."featured_story_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "users_lore_status_expires_idx" ON "users" USING btree ("lore_status_expires_at") WHERE "users"."lore_status_expires_at" IS NOT NULL;