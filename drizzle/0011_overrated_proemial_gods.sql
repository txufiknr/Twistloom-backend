CREATE TABLE "action_progress" (
	"id" uuid PRIMARY KEY NOT NULL,
	"page_id" uuid NOT NULL,
	"action_text" text NOT NULL,
	"status" text DEFAULT 'started' NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "action_progress_page_action_unique" UNIQUE("page_id","action_text")
);
--> statement-breakpoint
ALTER TABLE "action_progress" ADD CONSTRAINT "action_progress_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "action_progress_page_idx" ON "action_progress" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "action_progress_status_idx" ON "action_progress" USING btree ("status");--> statement-breakpoint
CREATE INDEX "action_progress_active_idx" ON "action_progress" USING btree ("status") WHERE "action_progress"."status" = 'started';