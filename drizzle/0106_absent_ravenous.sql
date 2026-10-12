CREATE TABLE "announcements" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"body_html" text,
	"cta_url" text,
	"cta_text" text,
	"i18n_key" text,
	"i18n_params" jsonb,
	"status" text DEFAULT 'draft' NOT NULL,
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"broadcast_id" uuid,
	"email_sent_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "broadcasts" ADD COLUMN "announcement_id" uuid;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD COLUMN "severity" text;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD COLUMN "cta_url" text;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD COLUMN "cta_text" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_seen_announcement_id" uuid;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_created_by_users_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "announcements_one_published_unique" ON "announcements" USING btree (((1))) WHERE "announcements"."status" IN ('scheduled', 'active');--> statement-breakpoint
CREATE INDEX "announcements_status_idx" ON "announcements" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "announcements_status_expires_idx" ON "announcements" USING btree ("status","expires_at") WHERE "announcements"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "announcements_broadcast_idx" ON "announcements" USING btree ("broadcast_id") WHERE "announcements"."broadcast_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "broadcasts_announcement_idx" ON "broadcasts" USING btree ("announcement_id") WHERE "broadcasts"."announcement_id" IS NOT NULL;