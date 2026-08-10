CREATE TABLE "platform_testimonials" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"rating" integer,
	"content" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_testimonials" ADD CONSTRAINT "platform_testimonials_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_testimonials_status_idx" ON "platform_testimonials" USING btree ("status");--> statement-breakpoint
CREATE INDEX "platform_testimonials_featured_idx" ON "platform_testimonials" USING btree ("featured","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "platform_testimonials_user_idx" ON "platform_testimonials" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "platform_testimonials_user_active_unique" ON "platform_testimonials" USING btree ("user_id") WHERE "platform_testimonials"."status" <> 'rejected';