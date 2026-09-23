CREATE TABLE "refresh_families" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"token_version" integer DEFAULT 0 NOT NULL,
	"refresh_hash" text NOT NULL,
	"used_hashes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"replaced_by_refresh_hash" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE "user_consumable_effects" CASCADE;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "danger_sight_from_page" integer;--> statement-breakpoint
ALTER TABLE "refresh_families" ADD CONSTRAINT "refresh_families_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_families" ADD CONSTRAINT "refresh_families_session_id_auth_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."auth_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_families_hash_uq" ON "refresh_families" USING btree ("refresh_hash");--> statement-breakpoint
CREATE INDEX "refresh_families_user_idx" ON "refresh_families" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "refresh_families_session_idx" ON "refresh_families" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "refresh_families_used_hashes_gin" ON "refresh_families" USING gin ("used_hashes");