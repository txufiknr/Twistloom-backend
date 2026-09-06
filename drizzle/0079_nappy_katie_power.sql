ALTER TABLE "creator_earnings" ADD COLUMN "intake_amount" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "creator_earnings" ADD COLUMN "intake_currency" text DEFAULT 'IDR' NOT NULL;--> statement-breakpoint
ALTER TABLE "creator_earnings" ADD COLUMN "fx_rate" real DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "creator_earnings" ADD COLUMN "settlement_amount" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "creator_earnings" ADD COLUMN "gateway" text DEFAULT 'stripe' NOT NULL;--> statement-breakpoint
ALTER TABLE "creator_earnings" ADD COLUMN "provider_payment_id" text;--> statement-breakpoint
ALTER TABLE "creator_earnings" ADD COLUMN "provider_event_id" text;--> statement-breakpoint
ALTER TABLE "creator_payout_methods" ADD COLUMN "bank_code" text;--> statement-breakpoint
ALTER TABLE "creator_payout_methods" ADD COLUMN "currency" text DEFAULT 'IDR' NOT NULL;--> statement-breakpoint
ALTER TABLE "creator_payout_methods" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "creator_payouts" ADD COLUMN "provider" text DEFAULT 'xendit';--> statement-breakpoint
ALTER TABLE "creator_wallets" ADD COLUMN "stripe_connect_account_id" text;--> statement-breakpoint
ALTER TABLE "creator_earnings" ADD CONSTRAINT "creator_earnings_provider_event_unique" UNIQUE("gateway","provider_event_id");