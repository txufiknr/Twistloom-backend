CREATE TABLE "user_feedbacks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"category" text NOT NULL,
	"message" text NOT NULL,
	"image_id" text,
	"image_url" text,
	"status" text DEFAULT 'idle' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_feedbacks" ADD CONSTRAINT "user_feedbacks_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_feedbacks_user_idx" ON "user_feedbacks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_feedbacks_category_idx" ON "user_feedbacks" USING btree ("category");--> statement-breakpoint
CREATE INDEX "user_feedbacks_created_idx" ON "user_feedbacks" USING btree ("created_at" DESC NULLS LAST);