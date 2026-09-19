CREATE TABLE "creator_tax_profiles" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"creator_id" uuid NOT NULL,
	"form_type" text NOT NULL,
	"tax_country" text DEFAULT 'ID' NOT NULL,
	"tax_id_encrypted" text,
	"tax_id_last4" text,
	"tax_id_blind_index" text,
	"legal_name" text NOT NULL,
	"treaty_benefit_claimed" boolean DEFAULT false NOT NULL,
	"treaty_country" text,
	"treaty_article" text,
	"withholding_rate" real DEFAULT 0 NOT NULL,
	"certified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"failure_reason" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creator_tax_profiles_creator_unique" UNIQUE("creator_id")
);
--> statement-breakpoint
ALTER TABLE "creator_tax_profiles" ADD CONSTRAINT "creator_tax_profiles_creator_id_users_user_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "creator_tax_profiles_creator_idx" ON "creator_tax_profiles" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "creator_tax_profiles_blind_idx" ON "creator_tax_profiles" USING btree ("tax_id_blind_index");--> statement-breakpoint
CREATE INDEX "creator_tax_profiles_status_idx" ON "creator_tax_profiles" USING btree ("status");