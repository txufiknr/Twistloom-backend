CREATE TABLE "broadcast_reports" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"broadcast_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "broadcast_reports_unique" UNIQUE("broadcast_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "broadcasts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text DEFAULT 'user' NOT NULL,
	"type" text DEFAULT 'message' NOT NULL,
	"message" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"moderation_result" jsonb,
	"rejection_reason" text,
	"contains_spoiler" boolean DEFAULT false NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creator_earnings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"creator_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"page_id" uuid,
	"reader_id" uuid NOT NULL,
	"source" text DEFAULT 'thanks' NOT NULL,
	"gross_amount" integer NOT NULL,
	"platform_fee" integer NOT NULL,
	"creator_amount" integer NOT NULL,
	"currency" text DEFAULT 'IDR' NOT NULL,
	"stripe_session_id" text,
	"stripe_payment_intent" text,
	"stripe_event_id" text,
	"status" text DEFAULT 'completed' NOT NULL,
	"message" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creator_earnings_stripe_event_unique" UNIQUE("stripe_event_id"),
	CONSTRAINT "creator_earnings_stripe_session_unique" UNIQUE("stripe_session_id")
);
--> statement-breakpoint
CREATE TABLE "creator_payout_methods" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"creator_id" uuid NOT NULL,
	"method_type" text NOT NULL,
	"bank_name" text,
	"account_number_encrypted" text,
	"account_name" text,
	"is_default" boolean DEFAULT true NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creator_payouts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"creator_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"fee" integer DEFAULT 0 NOT NULL,
	"net_amount" integer NOT NULL,
	"currency" text DEFAULT 'IDR' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_payout_id" text,
	"provider_method" text,
	"provider_account_last4" text,
	"failure_reason" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creator_wallets" (
	"creator_id" uuid PRIMARY KEY NOT NULL,
	"available_amount" integer DEFAULT 0 NOT NULL,
	"pending_amount" integer DEFAULT 0 NOT NULL,
	"withdrawn_amount" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'IDR' NOT NULL,
	"payout_verified" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_appeals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"enforcement_action_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"appeal_reason" text NOT NULL,
	"user_evidence" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"admin_notes" text,
	"reviewed_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mod_appeals_action_unique" UNIQUE("enforcement_action_id")
);
--> statement-breakpoint
CREATE TABLE "moderation_reports" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"reporter_id" uuid,
	"target_type" text DEFAULT 'user' NOT NULL,
	"target_id" uuid NOT NULL,
	"reported_user_id" uuid,
	"report_type" text NOT NULL,
	"message" text,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_by" uuid,
	"resolution_notes" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_generation_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"book_id" uuid NOT NULL,
	"actioned_page_id" uuid NOT NULL,
	"action_text" text NOT NULL,
	"fate_index" integer DEFAULT 0 NOT NULL,
	"story_page_json" jsonb NOT NULL,
	"story_page_provider" text,
	"story_page_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_generation_checkpoints_action_fate_unique" UNIQUE("actioned_page_id","action_text","fate_index")
);
--> statement-breakpoint
CREATE TABLE "user_enforcement_actions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"violation_type" text NOT NULL,
	"severity" text DEFAULT 'low' NOT NULL,
	"reason" text NOT NULL,
	"internal_notes" text,
	"created_by" uuid,
	"expires_at" timestamp with time zone,
	"is_revoked" boolean DEFAULT false NOT NULL,
	"revoked_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_inventory" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"item_type" text NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"last_purchased_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_inventory_user_type_unique" UNIQUE("user_id","item_type")
);
--> statement-breakpoint
CREATE TABLE "user_trust_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"trust_score" integer DEFAULT 100 NOT NULL,
	"strike_count" integer DEFAULT 0 NOT NULL,
	"risk_tier" text DEFAULT 'low' NOT NULL,
	"probation_until" timestamp with time zone,
	"last_evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_violation_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid,
	"violation_type" text NOT NULL,
	"confidence_score" real DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"raw_input" text,
	"detection_details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_counters" ADD COLUMN "easter_eggs_found" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_counters" ADD COLUMN "creators_supported" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "broadcast_reports" ADD CONSTRAINT "broadcast_reports_broadcast_id_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_reports" ADD CONSTRAINT "broadcast_reports_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_earnings" ADD CONSTRAINT "creator_earnings_creator_id_users_user_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_earnings" ADD CONSTRAINT "creator_earnings_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_earnings" ADD CONSTRAINT "creator_earnings_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_earnings" ADD CONSTRAINT "creator_earnings_reader_id_users_user_id_fk" FOREIGN KEY ("reader_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_payout_methods" ADD CONSTRAINT "creator_payout_methods_creator_id_users_user_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_payouts" ADD CONSTRAINT "creator_payouts_creator_id_users_user_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_wallets" ADD CONSTRAINT "creator_wallets_creator_id_users_user_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_appeals" ADD CONSTRAINT "moderation_appeals_enforcement_action_id_user_enforcement_actions_id_fk" FOREIGN KEY ("enforcement_action_id") REFERENCES "public"."user_enforcement_actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_appeals" ADD CONSTRAINT "moderation_appeals_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_appeals" ADD CONSTRAINT "moderation_appeals_reviewed_by_users_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_reports" ADD CONSTRAINT "moderation_reports_reporter_id_users_user_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_reports" ADD CONSTRAINT "moderation_reports_reported_user_id_users_user_id_fk" FOREIGN KEY ("reported_user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_reports" ADD CONSTRAINT "moderation_reports_resolved_by_users_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_generation_checkpoints" ADD CONSTRAINT "page_generation_checkpoints_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_generation_checkpoints" ADD CONSTRAINT "page_generation_checkpoints_actioned_page_id_pages_id_fk" FOREIGN KEY ("actioned_page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_enforcement_actions" ADD CONSTRAINT "user_enforcement_actions_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_enforcement_actions" ADD CONSTRAINT "user_enforcement_actions_created_by_users_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_inventory" ADD CONSTRAINT "user_inventory_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_trust_profiles" ADD CONSTRAINT "user_trust_profiles_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_violation_events" ADD CONSTRAINT "user_violation_events_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "broadcast_reports_broadcast_idx" ON "broadcast_reports" USING btree ("broadcast_id");--> statement-breakpoint
CREATE INDEX "broadcasts_status_starts_idx" ON "broadcasts" USING btree ("status","starts_at");--> statement-breakpoint
CREATE INDEX "broadcasts_starts_idx" ON "broadcasts" USING btree ("starts_at");--> statement-breakpoint
CREATE INDEX "broadcasts_user_idx" ON "broadcasts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "creator_earnings_creator_idx" ON "creator_earnings" USING btree ("creator_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "creator_earnings_book_idx" ON "creator_earnings" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "creator_earnings_reader_idx" ON "creator_earnings" USING btree ("reader_id");--> statement-breakpoint
CREATE INDEX "creator_earnings_source_idx" ON "creator_earnings" USING btree ("source");--> statement-breakpoint
CREATE INDEX "creator_payout_methods_creator_idx" ON "creator_payout_methods" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "creator_payouts_creator_idx" ON "creator_payouts" USING btree ("creator_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "creator_payouts_status_idx" ON "creator_payouts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "mod_appeals_status_idx" ON "moderation_appeals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "mod_appeals_user_idx" ON "moderation_appeals" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mod_reports_status_idx" ON "moderation_reports" USING btree ("status");--> statement-breakpoint
CREATE INDEX "mod_reports_target_idx" ON "moderation_reports" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "mod_reports_reported_user_idx" ON "moderation_reports" USING btree ("reported_user_id");--> statement-breakpoint
CREATE INDEX "mod_reports_created_idx" ON "moderation_reports" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "page_generation_checkpoints_book_idx" ON "page_generation_checkpoints" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "enforcement_user_active_idx" ON "user_enforcement_actions" USING btree ("user_id","expires_at") WHERE is_revoked = false;--> statement-breakpoint
CREATE INDEX "enforcement_action_idx" ON "user_enforcement_actions" USING btree ("action");--> statement-breakpoint
CREATE INDEX "enforcement_created_at_idx" ON "user_enforcement_actions" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_inventory_user_idx" ON "user_inventory" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "trust_profiles_score_idx" ON "user_trust_profiles" USING btree ("trust_score");--> statement-breakpoint
CREATE INDEX "trust_profiles_tier_idx" ON "user_trust_profiles" USING btree ("risk_tier");--> statement-breakpoint
CREATE INDEX "violation_events_user_idx" ON "user_violation_events" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "violation_events_type_idx" ON "user_violation_events" USING btree ("violation_type");--> statement-breakpoint
CREATE INDEX "violation_events_created_idx" ON "user_violation_events" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "companion_answers_book_page_hash_idx" ON "companion_answers" USING btree ("book_id","page_id","question_hash");--> statement-breakpoint
CREATE INDEX "companion_answers_book_page_created_idx" ON "companion_answers" USING btree ("book_id","page_id","created_at" DESC NULLS LAST);