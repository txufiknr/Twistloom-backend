CREATE TABLE "pen_notes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"book_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"text" text NOT NULL,
	"annotation" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pen_notes" ADD CONSTRAINT "pen_notes_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pen_notes" ADD CONSTRAINT "pen_notes_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pen_notes_book_idx" ON "pen_notes" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "pen_notes_user_idx" ON "pen_notes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "pen_notes_created_idx" ON "pen_notes" USING btree ("created_at" DESC NULLS LAST);