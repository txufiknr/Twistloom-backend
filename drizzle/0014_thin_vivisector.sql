CREATE TABLE "user_providers" (
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_providers_user_id_provider_pk" PRIMARY KEY("user_id","provider"),
	CONSTRAINT "user_providers_account_unique" UNIQUE("provider","provider_account_id")
);
--> statement-breakpoint
ALTER TABLE "user_providers" ADD CONSTRAINT "user_providers_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_providers_user_idx" ON "user_providers" USING btree ("user_id");