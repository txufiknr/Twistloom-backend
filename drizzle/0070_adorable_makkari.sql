CREATE TABLE "credit_voucher_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"internal_purpose" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"grant_type" text DEFAULT 'credit_grant' NOT NULL,
	"credits_per_redemption" integer NOT NULL,
	"max_redemptions" integer DEFAULT 0 NOT NULL,
	"max_redemptions_per_user" integer DEFAULT 1 NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"eligibility_policy" text DEFAULT 'open' NOT NULL,
	"distribution_type" text DEFAULT 'single_use_batch' NOT NULL,
	"user_id" uuid NOT NULL,
	"approved_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_voucher_campaigns_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "credit_voucher_codes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"code_hmac" text NOT NULL,
	"hmac_key_version" integer DEFAULT 1 NOT NULL,
	"public_prefix" text DEFAULT '' NOT NULL,
	"last_four" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'issued' NOT NULL,
	"assigned_user_id" uuid,
	"max_redemptions" integer DEFAULT 1 NOT NULL,
	"redeemed_count" integer DEFAULT 0 NOT NULL,
	"activated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_voucher_codes_hmac_unique" UNIQUE("code_hmac")
);
--> statement-breakpoint
CREATE TABLE "credit_voucher_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"code_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"credits_granted" integer NOT NULL,
	"transaction_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"eligibility_snapshot" jsonb,
	CONSTRAINT "credit_voucher_redemptions_idempotency_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "credit_voucher_redemptions_transaction_unique" UNIQUE("transaction_id")
);
--> statement-breakpoint
ALTER TABLE "credit_voucher_campaigns" ADD CONSTRAINT "credit_voucher_campaigns_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_voucher_codes" ADD CONSTRAINT "credit_voucher_codes_campaign_id_credit_voucher_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."credit_voucher_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_voucher_redemptions" ADD CONSTRAINT "credit_voucher_redemptions_campaign_id_credit_voucher_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."credit_voucher_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_voucher_redemptions" ADD CONSTRAINT "credit_voucher_redemptions_code_id_credit_voucher_codes_id_fk" FOREIGN KEY ("code_id") REFERENCES "public"."credit_voucher_codes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_voucher_redemptions" ADD CONSTRAINT "credit_voucher_redemptions_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_voucher_redemptions" ADD CONSTRAINT "credit_voucher_redemptions_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_voucher_campaigns_status_idx" ON "credit_voucher_campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "credit_voucher_campaigns_slug_idx" ON "credit_voucher_campaigns" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "credit_voucher_campaigns_created_idx" ON "credit_voucher_campaigns" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "credit_voucher_codes_campaign_idx" ON "credit_voucher_codes" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "credit_voucher_codes_status_idx" ON "credit_voucher_codes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "credit_voucher_codes_assigned_user_idx" ON "credit_voucher_codes" USING btree ("assigned_user_id");--> statement-breakpoint
CREATE INDEX "credit_voucher_redemptions_campaign_idx" ON "credit_voucher_redemptions" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "credit_voucher_redemptions_code_idx" ON "credit_voucher_redemptions" USING btree ("code_id");--> statement-breakpoint
CREATE INDEX "credit_voucher_redemptions_user_idx" ON "credit_voucher_redemptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "credit_voucher_redemptions_redeemed_idx" ON "credit_voucher_redemptions" USING btree ("redeemed_at" DESC NULLS LAST);