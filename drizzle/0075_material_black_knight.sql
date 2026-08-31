ALTER TABLE "creator_wallets" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "creator_earnings_creator_status_idx" ON "creator_earnings" USING btree ("creator_id","status");--> statement-breakpoint
CREATE INDEX "creator_payouts_creator_status_idx" ON "creator_payouts" USING btree ("creator_id","status");