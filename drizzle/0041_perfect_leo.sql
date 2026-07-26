CREATE TABLE "portal_blog_posts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"excerpt" text,
	"body_html" text NOT NULL,
	"cover_url" text,
	"author_name" text,
	"author_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_blog_posts_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "permissions" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "portal_blog_posts" ADD CONSTRAINT "portal_blog_posts_author_id_users_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portal_blog_posts_status_idx" ON "portal_blog_posts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "portal_blog_posts_published_idx" ON "portal_blog_posts" USING btree ("status","published_at" DESC NULLS LAST);