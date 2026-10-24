ALTER TABLE "user_notifications" ADD COLUMN "i18n_key" text;--> statement-breakpoint
ALTER TABLE "user_notifications" ADD COLUMN "i18n_params" jsonb;