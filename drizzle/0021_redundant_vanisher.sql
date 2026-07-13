ALTER TABLE "transactions" ADD COLUMN "amount_cents" integer;--> statement-breakpoint
ALTER TABLE "transactions" DROP COLUMN "amount_usd";