ALTER TABLE "story_states" DROP CONSTRAINT "story_states_user_id_book_id_page_id_pk";--> statement-breakpoint
ALTER TABLE "story_states" ADD CONSTRAINT "story_states_page_id_pk" PRIMARY KEY("page_id");--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_guest" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "story_states_book_idx" ON "story_states" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "users_is_guest_idx" ON "users" USING btree ("is_guest");--> statement-breakpoint
ALTER TABLE "story_states" DROP COLUMN "user_id";