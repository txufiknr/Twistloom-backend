ALTER TABLE "pages" ADD COLUMN "pending_generation_count" integer GENERATED ALWAYS AS ((
        jsonb_array_length(actions) -
        jsonb_array_length(
          jsonb_path_query_array(
            actions,
            '$[*] ? (exists(@.destinationPageIds) && @.destinationPageIds.type() == "array" && @.destinationPageIds.size() > 0)'
          )
        )
      )) STORED NOT NULL;--> statement-breakpoint
CREATE INDEX "pages_pending_generation_idx" ON "pages" USING btree ("pending_generation_count");