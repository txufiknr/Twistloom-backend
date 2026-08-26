ALTER TABLE "companion_answers" ADD COLUMN "session_id" uuid;--> statement-breakpoint
CREATE INDEX "companion_answers_session_idx" ON "companion_answers" USING btree ("session_id");