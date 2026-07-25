ALTER TABLE "subscription_transactions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "subscriptions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transactions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "subscription_transactions" CASCADE;--> statement-breakpoint
DROP TABLE "subscriptions" CASCADE;--> statement-breakpoint
DROP TABLE "transactions" CASCADE;--> statement-breakpoint
ALTER TABLE "users" RENAME COLUMN "stripe_customer_id" TO "customer_id";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_stripe_customer_id_unique";--> statement-breakpoint
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_event_unique";--> statement-breakpoint
ALTER TABLE "social_mentions" ADD COLUMN "related_book_id" uuid;--> statement-breakpoint
ALTER TABLE "social_mentions" ADD COLUMN "related_page_id" uuid;--> statement-breakpoint
ALTER TABLE "social_mentions" ADD COLUMN "related_book_source" text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "gateway" text DEFAULT 'stripe' NOT NULL;--> statement-breakpoint
ALTER TABLE "social_mentions" ADD CONSTRAINT "social_mentions_related_book_id_books_id_fk" FOREIGN KEY ("related_book_id") REFERENCES "public"."books"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_mentions" ADD CONSTRAINT "social_mentions_related_page_id_pages_id_fk" FOREIGN KEY ("related_page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "social_mentions_related_book_idx" ON "social_mentions" USING btree ("related_book_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_gateway_idx" ON "webhook_deliveries" USING btree ("gateway");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_customer_id_unique" UNIQUE("customer_id");--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_gateway_event_unique" UNIQUE("gateway","event_id");