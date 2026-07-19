CREATE TABLE "social_mentions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"platform" text NOT NULL,
	"author" text NOT NULL,
	"author_avatar" text,
	"title" text,
	"content" text NOT NULL,
	"url" text NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"sentiment_score" real DEFAULT 0 NOT NULL,
	"relevance_score" real DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "social_mentions_url_unique" UNIQUE("url")
);
--> statement-breakpoint
CREATE INDEX "social_mentions_status_idx" ON "social_mentions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "social_mentions_platform_idx" ON "social_mentions" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "social_mentions_filtering_idx" ON "social_mentions" USING btree ("status","relevance_score" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "social_mentions_featured_idx" ON "social_mentions" USING btree ("featured","relevance_score" DESC NULLS LAST);