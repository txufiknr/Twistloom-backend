CREATE TABLE "admin_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb DEFAULT 'false'::jsonb NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
