CREATE TABLE "user_beta_duties" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"duty_id" text NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"completed_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_beta_duties_user_duty_unique" UNIQUE("user_id","duty_id")
);
--> statement-breakpoint
ALTER TABLE "user_beta_duties" ADD CONSTRAINT "user_beta_duties_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_beta_duties_user_idx" ON "user_beta_duties" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_beta_duties_status_idx" ON "user_beta_duties" USING btree ("status");