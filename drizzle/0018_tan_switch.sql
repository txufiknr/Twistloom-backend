CREATE TABLE "usage" (
	"date" text NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"requests" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"total_tokens" integer,
	"cached_tokens" integer,
	"duration_ms" integer,
	"context" text,
	CONSTRAINT "usage_date_provider_context_model_pk" PRIMARY KEY("date","provider","context","model")
);
