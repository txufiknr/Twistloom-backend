CREATE TABLE "user_consumable_effects" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"item_type" text NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_consumable_effects_user_type_unique" UNIQUE("user_id","item_type")
);
--> statement-breakpoint
ALTER TABLE "user_consumable_effects" ADD CONSTRAINT "user_consumable_effects_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_consumable_effects_user_idx" ON "user_consumable_effects" USING btree ("user_id");