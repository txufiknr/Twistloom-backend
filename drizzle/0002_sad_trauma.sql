CREATE TABLE "user_checkins" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"date" text NOT NULL,
	"credits_claimed" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_checkins_user_date_unique" UNIQUE("user_id","date")
);
--> statement-breakpoint
ALTER TABLE "user_comments" ADD COLUMN "page_id" uuid;--> statement-breakpoint
ALTER TABLE "user_checkins" ADD CONSTRAINT "user_checkins_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_checkins_user_idx" ON "user_checkins" USING btree ("user_id","date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_checkins_date_idx" ON "user_checkins" USING btree ("date");--> statement-breakpoint
CREATE INDEX "user_checkins_created_idx" ON "user_checkins" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "user_comments" ADD CONSTRAINT "user_comments_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;