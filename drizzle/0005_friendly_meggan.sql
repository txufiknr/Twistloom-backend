CREATE TABLE "uploaded_images" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"image_id" text NOT NULL,
	"image_url" text NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uploaded_images_image_id_unique" UNIQUE("image_id")
);
--> statement-breakpoint
ALTER TABLE "users" RENAME COLUMN "image" TO "image_url";--> statement-breakpoint
ALTER TABLE "uploaded_images" ADD CONSTRAINT "uploaded_images_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "uploaded_images_user_idx" ON "uploaded_images" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "uploaded_images_type_idx" ON "uploaded_images" USING btree ("type");--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "books_image_id_uploaded_images_image_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."uploaded_images"("image_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "books" DROP COLUMN "image";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "image_id";