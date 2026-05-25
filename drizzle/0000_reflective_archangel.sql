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
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"user_agent" text,
	"ip_address" text,
	"device_name" text,
	"last_active_at" timestamp with time zone DEFAULT now(),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "book_generations" (
	"book_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"theme" text,
	"mc_candidate" jsonb,
	"generate_cover_image" boolean DEFAULT false NOT NULL,
	"generation_status" text DEFAULT 'pending',
	"generation_step" text,
	"generation_error" text,
	"generation_started_at" timestamp with time zone,
	"generation_completed_at" timestamp with time zone,
	"is_refunded" timestamp,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "book_translations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"book_id" uuid NOT NULL,
	"language" text NOT NULL,
	"title" text,
	"hook" text,
	"summary" text,
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mc" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider_type" text,
	"provider_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_translations_book_language_unique" UNIQUE("book_id","language")
);
--> statement-breakpoint
CREATE TABLE "books" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"slug" text,
	"title" text NOT NULL,
	"total_pages" integer DEFAULT 80 NOT NULL,
	"language" text,
	"hook" text,
	"summary" text,
	"image" text,
	"image_id" text,
	"trending_score" real DEFAULT 0,
	"is_original" boolean DEFAULT false NOT NULL,
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active',
	"mc" jsonb NOT NULL,
	"likes_count" integer DEFAULT 0 NOT NULL,
	"read_count" integer DEFAULT 0 NOT NULL,
	"branches_count" integer DEFAULT 0 NOT NULL,
	"comments_count" integer DEFAULT 0 NOT NULL,
	"complete_count" integer DEFAULT 0 NOT NULL,
	"top_pick" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "books_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "deleted_images" (
	"file_id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_translations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"page_id" uuid NOT NULL,
	"language" text NOT NULL,
	"translated_text" text NOT NULL,
	"place" text,
	"key_events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"important_objects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider_type" text,
	"provider_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_translations_page_language_unique" UNIQUE("page_id","language")
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"parent_id" uuid,
	"branch_id" text DEFAULT 'main' NOT NULL,
	"book_id" uuid NOT NULL,
	"page" integer NOT NULL,
	"text" text NOT NULL,
	"mood" text,
	"place" text,
	"time_of_day" text,
	"characters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"key_events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"important_objects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"delta" jsonb NOT NULL,
	"ai_provider" text,
	"ai_model" text,
	"pending_generation_count" integer DEFAULT 0 NOT NULL,
	"is_generating_started_at" timestamp with time zone,
	"visit_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pages_parent_branch_unique" UNIQUE("parent_id","branch_id")
);
--> statement-breakpoint
CREATE TABLE "story_states" (
	"page_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"page" integer NOT NULL,
	"max_page" integer NOT NULL,
	"flags" jsonb NOT NULL,
	"trauma_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"plot_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inventory" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"psychological_profile" jsonb NOT NULL,
	"hidden_state" jsonb NOT NULL,
	"memory_integrity" text DEFAULT 'stable' NOT NULL,
	"difficulty" text DEFAULT 'low' NOT NULL,
	"viable_ending" jsonb,
	"characters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"places" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"threads" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actions_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"injuries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"context_history" text DEFAULT '' NOT NULL,
	"is_major_event" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "story_states_page_id_pk" PRIMARY KEY("page_id")
);
--> statement-breakpoint
CREATE TABLE "subscription_transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subscription_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"credits_allocated" integer NOT NULL,
	"stripe_invoice_id" text,
	"stripe_event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_transactions_stripe_invoice_id_unique" UNIQUE("stripe_invoice_id"),
	CONSTRAINT "subscription_transactions_stripe_event_id_unique" UNIQUE("stripe_event_id"),
	CONSTRAINT "subscription_transactions_invoice_unique" UNIQUE("stripe_invoice_id")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"stripe_price_id" text NOT NULL,
	"status" text NOT NULL,
	"current_period_start" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"canceled_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id"),
	CONSTRAINT "subscriptions_stripe_subscription_unique" UNIQUE("stripe_subscription_id")
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"credits" integer NOT NULL,
	"amount_usd" real,
	"context" text,
	"metadata" jsonb,
	"payment_intent_id" text,
	"stripe_event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_payment_intent_id_unique" UNIQUE("payment_intent_id"),
	CONSTRAINT "transactions_stripe_event_id_unique" UNIQUE("stripe_event_id"),
	CONSTRAINT "transactions_payment_intent_unique" UNIQUE("payment_intent_id"),
	CONSTRAINT "transactions_stripe_event_unique" UNIQUE("stripe_event_id")
);
--> statement-breakpoint
CREATE TABLE "usage" (
	"date" text NOT NULL,
	"provider" text NOT NULL,
	"requests" integer,
	"context" text,
	CONSTRAINT "usage_date_provider_context_pk" PRIMARY KEY("date","provider","context")
);
--> statement-breakpoint
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
CREATE TABLE "user_auth" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"failed_login_attempts" integer DEFAULT 0,
	"lock_until" timestamp with time zone,
	"password_reset_token" text,
	"password_reset_expires" timestamp with time zone,
	"email_verified" timestamp with time zone,
	"email_verification_token" text,
	"email_verification_expires" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_auth_password_reset_token_unique" UNIQUE("password_reset_token"),
	CONSTRAINT "user_auth_email_verification_token_unique" UNIQUE("email_verification_token")
);
--> statement-breakpoint
CREATE TABLE "user_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "user_comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"page_id" uuid,
	"parent_comment_id" uuid,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_completed_books" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_completed_books_user_book_unique" UNIQUE("user_id","book_id")
);
--> statement-breakpoint
CREATE TABLE "user_favorites" (
	"user_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"collection" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_favorites_user_id_book_id_pk" PRIMARY KEY("user_id","book_id")
);
--> statement-breakpoint
CREATE TABLE "user_follows" (
	"follower_id" uuid NOT NULL,
	"following_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_follows_follower_id_following_id_pk" PRIMARY KEY("follower_id","following_id")
);
--> statement-breakpoint
CREATE TABLE "user_likes" (
	"user_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_likes_user_id_target_type_target_id_pk" PRIMARY KEY("user_id","target_type","target_id")
);
--> statement-breakpoint
CREATE TABLE "user_notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"data" jsonb,
	"read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_page_progress" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"actioned_page_id" uuid NOT NULL,
	"next_page_id" uuid NOT NULL,
	"action" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_page_progress_user_book_page_unique" UNIQUE("user_id","book_id","actioned_page_id")
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"previous_page_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_sessions_user_book_unique" UNIQUE("user_id","book_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"name" text,
	"username" text,
	"email" text,
	"password_hash" text,
	"stripe_customer_id" text,
	"credits" integer DEFAULT 50 NOT NULL,
	"pen_name" text,
	"bio" text,
	"gender" text,
	"image" text,
	"image_id" text,
	"tier" text,
	"is_new_user" boolean DEFAULT true NOT NULL,
	"subscription_id" uuid,
	"vip_expires_at" timestamp with time zone,
	"token_version" integer DEFAULT 0 NOT NULL,
	"last_active" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_stripe_customer_id_unique" UNIQUE("stripe_customer_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"delivered_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp,
	"status" text DEFAULT 'retrying' NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_event_unique" UNIQUE("event_id")
);
--> statement-breakpoint
ALTER TABLE "action_progress" ADD CONSTRAINT "action_progress_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_generations" ADD CONSTRAINT "book_generations_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_translations" ADD CONSTRAINT "book_translations_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "books_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_translations" ADD CONSTRAINT "page_translations_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_states" ADD CONSTRAINT "story_states_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_states" ADD CONSTRAINT "story_states_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_transactions" ADD CONSTRAINT "subscription_transactions_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_transactions" ADD CONSTRAINT "subscription_transactions_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_activity_logs" ADD CONSTRAINT "user_activity_logs_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_auth" ADD CONSTRAINT "user_auth_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_checkins" ADD CONSTRAINT "user_checkins_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_comments" ADD CONSTRAINT "user_comments_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_comments" ADD CONSTRAINT "user_comments_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_comments" ADD CONSTRAINT "user_comments_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_completed_books" ADD CONSTRAINT "user_completed_books_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_completed_books" ADD CONSTRAINT "user_completed_books_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_completed_books" ADD CONSTRAINT "user_completed_books_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_favorites" ADD CONSTRAINT "user_favorites_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_favorites" ADD CONSTRAINT "user_favorites_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_follows" ADD CONSTRAINT "user_follows_follower_id_users_user_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_follows" ADD CONSTRAINT "user_follows_following_id_users_user_id_fk" FOREIGN KEY ("following_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_likes" ADD CONSTRAINT "user_likes_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_notifications" ADD CONSTRAINT "user_notifications_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_page_progress" ADD CONSTRAINT "user_page_progress_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_page_progress" ADD CONSTRAINT "user_page_progress_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "action_progress_page_idx" ON "action_progress" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "action_progress_status_idx" ON "action_progress" USING btree ("status");--> statement-breakpoint
CREATE INDEX "action_progress_active_idx" ON "action_progress" USING btree ("status") WHERE "action_progress"."status" = 'started';--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_id_idx" ON "auth_sessions" USING btree ("id");--> statement-breakpoint
CREATE INDEX "auth_sessions_last_active_idx" ON "auth_sessions" USING btree ("last_active_at");--> statement-breakpoint
CREATE INDEX "book_generations_book_idx" ON "book_generations" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "book_generations_user_idx" ON "book_generations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "book_generations_status_idx" ON "book_generations" USING btree ("generation_status");--> statement-breakpoint
CREATE INDEX "book_generations_active_idx" ON "book_generations" USING btree ("generation_status") WHERE "book_generations"."generation_status" = 'in_progress';--> statement-breakpoint
CREATE INDEX "book_translations_book_idx" ON "book_translations" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "book_translations_language_idx" ON "book_translations" USING btree ("language");--> statement-breakpoint
CREATE INDEX "book_translations_created_idx" ON "book_translations" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "books_trending_score_idx" ON "books" USING btree ("trending_score" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "books_created_at_idx" ON "books" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "books_top_pick_idx" ON "books" USING btree ("top_pick" DESC NULLS LAST) WHERE "books"."top_pick" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "books_is_original_idx" ON "books" USING btree ("is_original","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "books_recent_idx" ON "books" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "books_user_idx" ON "books" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "books_status_idx" ON "books" USING btree ("status");--> statement-breakpoint
CREATE INDEX "books_language_idx" ON "books" USING btree ("language");--> statement-breakpoint
CREATE INDEX "books_slug_idx" ON "books" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "books_keywords_gin_idx" ON "books" USING gin ("keywords");--> statement-breakpoint
CREATE INDEX "books_title_gin_idx" ON "books" USING gin (title gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "books_hook_gin_idx" ON "books" USING gin (hook gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "books_summary_gin_idx" ON "books" USING gin (summary gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "deleted_images_created_idx" ON "deleted_images" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "page_translations_page_idx" ON "page_translations" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "page_translations_language_idx" ON "page_translations" USING btree ("language");--> statement-breakpoint
CREATE INDEX "page_translations_created_idx" ON "page_translations" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "pages_book_page_idx" ON "pages" USING btree ("book_id","page");--> statement-breakpoint
CREATE INDEX "pages_book_order_idx" ON "pages" USING btree ("book_id","page" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "pages_created_at_idx" ON "pages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "pages_book_branch_idx" ON "pages" USING btree ("book_id","branch_id");--> statement-breakpoint
CREATE INDEX "pages_pending_generation_idx" ON "pages" USING btree ("pending_generation_count");--> statement-breakpoint
CREATE INDEX "story_states_book_idx" ON "story_states" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "story_states_page_idx" ON "story_states" USING btree ("page");--> statement-breakpoint
CREATE INDEX "story_states_difficulty_idx" ON "story_states" USING btree ("difficulty");--> statement-breakpoint
CREATE INDEX "story_states_progress_idx" ON "story_states" USING btree ("page" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "subscription_transactions_subscription_idx" ON "subscription_transactions" USING btree ("subscription_id");--> statement-breakpoint
CREATE INDEX "subscription_transactions_user_idx" ON "subscription_transactions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "subscription_transactions_type_idx" ON "subscription_transactions" USING btree ("type");--> statement-breakpoint
CREATE INDEX "subscriptions_user_idx" ON "subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "subscriptions_status_idx" ON "subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "subscriptions_period_end_idx" ON "subscriptions" USING btree ("current_period_end");--> statement-breakpoint
CREATE INDEX "transactions_user_idx" ON "transactions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "transactions_type_idx" ON "transactions" USING btree ("type");--> statement-breakpoint
CREATE INDEX "transactions_created_idx" ON "transactions" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transactions_context_idx" ON "transactions" USING btree ("context");--> statement-breakpoint
CREATE INDEX "user_activity_logs_user_idx" ON "user_activity_logs" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_activity_logs_type_idx" ON "user_activity_logs" USING btree ("activity_type");--> statement-breakpoint
CREATE INDEX "user_activity_logs_target_idx" ON "user_activity_logs" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "user_activity_logs_created_idx" ON "user_activity_logs" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_auth_lock_until_idx" ON "user_auth" USING btree ("lock_until") WHERE "user_auth"."lock_until" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "user_auth_password_reset_token_idx" ON "user_auth" USING btree ("password_reset_token") WHERE "user_auth"."password_reset_token" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "user_auth_email_verification_token_idx" ON "user_auth" USING btree ("email_verification_token") WHERE "user_auth"."email_verification_token" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "user_cache_payload_gin" ON "user_cache" USING gin ("payload");--> statement-breakpoint
CREATE INDEX "user_cache_updated_at_idx" ON "user_cache" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "user_checkins_user_idx" ON "user_checkins" USING btree ("user_id","date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_checkins_date_idx" ON "user_checkins" USING btree ("date");--> statement-breakpoint
CREATE INDEX "user_checkins_created_idx" ON "user_checkins" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_comments_user_idx" ON "user_comments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_comments_book_idx" ON "user_comments" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "user_comments_parent_idx" ON "user_comments" USING btree ("parent_comment_id");--> statement-breakpoint
CREATE INDEX "user_comments_book_parent_idx" ON "user_comments" USING btree ("book_id","parent_comment_id");--> statement-breakpoint
CREATE INDEX "user_comments_created_idx" ON "user_comments" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_comments_book_order_idx" ON "user_comments" USING btree ("book_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_completed_books_user_idx" ON "user_completed_books" USING btree ("user_id","completed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_completed_books_book_idx" ON "user_completed_books" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "user_completed_books_branch_idx" ON "user_completed_books" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "user_completed_books_page_idx" ON "user_completed_books" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "user_favorites_user_idx" ON "user_favorites" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_favorites_book_idx" ON "user_favorites" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "user_favorites_created_idx" ON "user_favorites" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_follows_following_idx" ON "user_follows" USING btree ("following_id");--> statement-breakpoint
CREATE INDEX "user_follows_follower_idx" ON "user_follows" USING btree ("follower_id");--> statement-breakpoint
CREATE INDEX "user_follows_created_idx" ON "user_follows" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_likes_user_idx" ON "user_likes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_likes_target_idx" ON "user_likes" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "user_likes_created_idx" ON "user_likes" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_notifications_user_idx" ON "user_notifications" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_notifications_unread_idx" ON "user_notifications" USING btree ("user_id","read");--> statement-breakpoint
CREATE INDEX "user_notifications_type_idx" ON "user_notifications" USING btree ("type");--> statement-breakpoint
CREATE INDEX "user_notifications_created_idx" ON "user_notifications" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_page_progress_user_book_idx" ON "user_page_progress" USING btree ("user_id","book_id");--> statement-breakpoint
CREATE INDEX "user_page_progress_page_idx" ON "user_page_progress" USING btree ("actioned_page_id");--> statement-breakpoint
CREATE INDEX "user_page_progress_book_actioned_idx" ON "user_page_progress" USING btree ("book_id","actioned_page_id");--> statement-breakpoint
CREATE INDEX "user_sessions_status_idx" ON "user_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "user_sessions_user_active_idx" ON "user_sessions" USING btree ("user_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "users_gender_idx" ON "users" USING btree ("gender");--> statement-breakpoint
CREATE INDEX "users_created_at_idx" ON "users" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "users_vip_expires_idx" ON "users" USING btree ("vip_expires_at") WHERE "users"."vip_expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_event_idx" ON "webhook_deliveries" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_status_idx" ON "webhook_deliveries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_created_idx" ON "webhook_deliveries" USING btree ("created_at" DESC NULLS LAST);