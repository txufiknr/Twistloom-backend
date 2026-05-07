CREATE TABLE "user_activity_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"activity_type" text NOT NULL,
	"target_type" text,
	"target_id" uuid,
	"metadata" jsonb,
	"ip_address" text,
	"user_agent" text,
	"platform" text,
	"app_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_devices" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "user_devices" CASCADE;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "credits" SET DEFAULT 50;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "visit_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_favorites" ADD COLUMN "collection" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "user_activity_logs" ADD CONSTRAINT "user_activity_logs_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_activity_logs_user_idx" ON "user_activity_logs" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_activity_logs_type_idx" ON "user_activity_logs" USING btree ("activity_type");--> statement-breakpoint
CREATE INDEX "user_activity_logs_target_idx" ON "user_activity_logs" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "user_activity_logs_created_idx" ON "user_activity_logs" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_stripe_customer_id_unique" UNIQUE("stripe_customer_id");