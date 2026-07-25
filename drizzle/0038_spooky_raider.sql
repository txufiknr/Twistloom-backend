CREATE TABLE "admin_users" (
	"user_id" text PRIMARY KEY NOT NULL,
	"email" text,
	"invited_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_preferences" jsonb;