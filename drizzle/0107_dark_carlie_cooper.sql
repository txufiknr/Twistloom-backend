CREATE TABLE "email_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"announcement_id" uuid,
	"request_key" text NOT NULL,
	"type" text NOT NULL,
	"audience" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"title" text NOT NULL,
	"templates" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"audience_cursor" uuid,
	"audience_complete" boolean DEFAULT false NOT NULL,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"pending_count" integer DEFAULT 0 NOT NULL,
	"sent" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"needs_review" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_dispatch_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_messages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"campaign_id" uuid,
	"user_id" uuid,
	"request_key" text NOT NULL,
	"type" text NOT NULL,
	"priority" integer NOT NULL,
	"payload_encrypted" text,
	"recipient_encrypted" text,
	"credential_hash" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"locale" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"first_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"ambiguous" boolean DEFAULT false NOT NULL,
	"provider_id" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "broadcasts_announcement_idx";--> statement-breakpoint
ALTER TABLE "email_campaigns" ADD CONSTRAINT "email_campaigns_announcement_id_announcements_id_fk" FOREIGN KEY ("announcement_id") REFERENCES "public"."announcements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_campaigns" ADD CONSTRAINT "email_campaigns_created_by_users_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_campaign_id_email_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."email_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_request_unique" ON "email_campaigns" USING btree ("request_key");--> statement-breakpoint
CREATE UNIQUE INDEX "email_one_open_unique" ON "email_campaigns" USING btree ("announcement_id") WHERE "email_campaigns"."announcement_id" IS NOT NULL AND "email_campaigns"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "email_due_idx" ON "email_campaigns" USING btree ("next_run_at","created_at","id") WHERE "email_campaigns"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "email_campaign_dispatch_idx" ON "email_campaigns" USING btree ("next_dispatch_at","id") WHERE "email_campaigns"."pending_count" > 0;--> statement-breakpoint
CREATE UNIQUE INDEX "email_message_request_unique" ON "email_messages" USING btree ("request_key");--> statement-breakpoint
CREATE INDEX "email_message_due_idx" ON "email_messages" USING btree ("priority","next_attempt_at","id") WHERE "email_messages"."status" = 'pending' AND "email_messages"."campaign_id" IS NULL;--> statement-breakpoint
CREATE INDEX "email_message_campaign_due_idx" ON "email_messages" USING btree ("campaign_id","next_attempt_at","id") WHERE "email_messages"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "email_message_lease_idx" ON "email_messages" USING btree ("lease_expires_at","id") WHERE "email_messages"."status" = 'sending';--> statement-breakpoint
CREATE INDEX "email_message_campaign_idx" ON "email_messages" USING btree ("campaign_id","status","id");--> statement-breakpoint
CREATE INDEX "email_message_retention_idx" ON "email_messages" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "email_message_provider_idx" ON "email_messages" USING btree ("provider_id") WHERE "email_messages"."provider_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "broadcasts_status_expires_idx" ON "broadcasts" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "broadcasts_announcement_unique" ON "broadcasts" USING btree ("announcement_id") WHERE "broadcasts"."announcement_id" IS NOT NULL;