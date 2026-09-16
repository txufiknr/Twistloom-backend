CREATE TABLE "creator_kyc_verifications" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"creator_id" uuid NOT NULL,
	"payout_method_id" uuid,
	"verification_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"inquiry_holder_name" text,
	"registered_name" text,
	"name_match_score" real,
	"confidence" text,
	"failure_reason" text,
	"external_reference_id" text,
	"metadata" jsonb,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "creator_payout_methods" ADD COLUMN "account_last4" text;--> statement-breakpoint
ALTER TABLE "creator_payout_methods" ADD COLUMN "account_number_blind_index" text;--> statement-breakpoint
ALTER TABLE "creator_payout_methods" ADD COLUMN "routing_number" text;--> statement-breakpoint
ALTER TABLE "creator_payout_methods" ADD COLUMN "swift_bic" text;--> statement-breakpoint
ALTER TABLE "creator_payout_methods" ADD COLUMN "country_code" text DEFAULT 'ID' NOT NULL;--> statement-breakpoint
ALTER TABLE "creator_kyc_verifications" ADD CONSTRAINT "creator_kyc_verifications_creator_id_users_user_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_kyc_verifications" ADD CONSTRAINT "creator_kyc_verifications_payout_method_id_creator_payout_methods_id_fk" FOREIGN KEY ("payout_method_id") REFERENCES "public"."creator_payout_methods"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "creator_kyc_creator_idx" ON "creator_kyc_verifications" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "creator_kyc_status_idx" ON "creator_kyc_verifications" USING btree ("status");--> statement-breakpoint
CREATE INDEX "creator_payout_methods_blind_idx" ON "creator_payout_methods" USING btree ("account_number_blind_index");