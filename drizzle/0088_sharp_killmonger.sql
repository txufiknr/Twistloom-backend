ALTER TABLE "pages" ADD COLUMN "image_url" text;--> statement-breakpoint
ALTER TABLE "pen_drafts" ADD COLUMN "image_url" text;--> statement-breakpoint
ALTER TABLE "uploaded_images" ADD COLUMN "entity_id" uuid;--> statement-breakpoint
CREATE INDEX "pages_image_url_idx" ON "pages" USING btree ("image_url") WHERE "pages"."image_url" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "uploaded_images_entity_idx" ON "uploaded_images" USING btree ("type","entity_id") WHERE "uploaded_images"."entity_id" IS NOT NULL;