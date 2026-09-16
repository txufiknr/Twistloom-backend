ALTER TABLE "broadcasts" ADD COLUMN "message_key" text;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD COLUMN "message_params" jsonb;