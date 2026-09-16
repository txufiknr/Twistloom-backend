CREATE TABLE "session_weave" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"book_id" uuid NOT NULL,
	"story_strand" integer DEFAULT 0 NOT NULL,
	"choice_strand" integer DEFAULT 0 NOT NULL,
	"discovery_strand" integer DEFAULT 0 NOT NULL,
	"is_complete" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp with time zone,
	"daily_bonus_claimed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_weave_user_session_unique" UNIQUE("user_id","session_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "profile_title" text;--> statement-breakpoint
ALTER TABLE "session_weave" ADD CONSTRAINT "session_weave_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_weave" ADD CONSTRAINT "session_weave_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_weave_user_idx" ON "session_weave" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_weave_completed_idx" ON "session_weave" USING btree ("user_id","completed_at");