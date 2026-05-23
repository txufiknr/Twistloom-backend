CREATE TABLE "session_data_associations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"session_id" uuid,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"migrated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "temporary_sessions" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"ip_address" text,
	"user_agent" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"migrated_at" timestamp with time zone,
	"page_views" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb
);
--> statement-breakpoint
ALTER TABLE "session_data_associations" ADD CONSTRAINT "session_data_associations_session_id_temporary_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."temporary_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_data_associations" ADD CONSTRAINT "session_data_associations_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temporary_sessions" ADD CONSTRAINT "temporary_sessions_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_data_associations_session_idx" ON "session_data_associations" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "session_data_associations_user_idx" ON "session_data_associations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_data_associations_entity_idx" ON "session_data_associations" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "temporary_sessions_ip_idx" ON "temporary_sessions" USING btree ("ip_address");--> statement-breakpoint
CREATE INDEX "temporary_sessions_last_seen_idx" ON "temporary_sessions" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "temporary_sessions_user_id_idx" ON "temporary_sessions" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "user_comments" ADD CONSTRAINT "user_comments_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_favorites" ADD CONSTRAINT "user_favorites_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_likes" ADD CONSTRAINT "user_likes_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;