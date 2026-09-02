CREATE TABLE "easter_egg_discoveries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"book_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"paragraph_index" integer,
	"kind" text DEFAULT 'easter_egg' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "easter_egg_discoveries_user_page_unique" UNIQUE("user_id","page_id")
);
--> statement-breakpoint
CREATE TABLE "easter_egg_roll_budget" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"last_roll_at" timestamp with time zone,
	"rolls_today" integer DEFAULT 0 NOT NULL,
	"day" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "easter_egg_discoveries" ADD CONSTRAINT "easter_egg_discoveries_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "easter_egg_discoveries" ADD CONSTRAINT "easter_egg_discoveries_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "easter_egg_discoveries" ADD CONSTRAINT "easter_egg_discoveries_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "easter_egg_roll_budget" ADD CONSTRAINT "easter_egg_roll_budget_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "easter_egg_discoveries_user_idx" ON "easter_egg_discoveries" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "easter_egg_discoveries_page_idx" ON "easter_egg_discoveries" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "easter_egg_discoveries_book_idx" ON "easter_egg_discoveries" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "easter_egg_roll_budget_day_idx" ON "easter_egg_roll_budget" USING btree ("day");