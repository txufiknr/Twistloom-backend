CREATE TABLE "creator_payout_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"payout_id" uuid NOT NULL,
	"previous_status" text,
	"new_status" text NOT NULL,
	"actor_type" text DEFAULT 'system' NOT NULL,
	"actor_id" uuid,
	"note" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "creator_earnings" ALTER COLUMN "status" SET DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "creator_earnings" ADD COLUMN "mature_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "creator_payout_events" ADD CONSTRAINT "creator_payout_events_payout_id_creator_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."creator_payouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_payout_events" ADD CONSTRAINT "creator_payout_events_actor_id_users_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "creator_payout_events_payout_idx" ON "creator_payout_events" USING btree ("payout_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "creator_payout_events_actor_idx" ON "creator_payout_events" USING btree ("actor_type","actor_id");--> statement-breakpoint
CREATE INDEX "creator_earnings_status_mature_idx" ON "creator_earnings" USING btree ("status","mature_at");