ALTER TABLE "creator_payouts" ADD COLUMN "payout_method_id" uuid;--> statement-breakpoint
ALTER TABLE "creator_tax_profiles" ADD COLUMN "signature_name" text;--> statement-breakpoint
ALTER TABLE "creator_tax_profiles" ADD COLUMN "signer_ip_address" text;--> statement-breakpoint
ALTER TABLE "creator_tax_profiles" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "creator_payouts" ADD CONSTRAINT "creator_payouts_payout_method_id_creator_payout_methods_id_fk" FOREIGN KEY ("payout_method_id") REFERENCES "public"."creator_payout_methods"("id") ON DELETE set null ON UPDATE no action;