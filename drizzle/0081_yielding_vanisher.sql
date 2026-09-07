CREATE TABLE "help_article_feedback" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"article_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"vote" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "help_article_feedback_article_user_unique" UNIQUE("article_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "help_article_feedback" ADD CONSTRAINT "help_article_feedback_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "help_article_feedback_article_idx" ON "help_article_feedback" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "help_article_feedback_user_idx" ON "help_article_feedback" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "help_article_feedback_vote_idx" ON "help_article_feedback" USING btree ("vote");