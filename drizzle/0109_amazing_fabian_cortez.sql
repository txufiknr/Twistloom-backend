ALTER TABLE "user_notifications" ADD COLUMN "group_key" text;--> statement-breakpoint
WITH ranked AS (
  SELECT "id",
         "user_id",
         "data"->>'testimonialId' AS testimonial_id,
         row_number() OVER (
           PARTITION BY "user_id", "data"->>'testimonialId'
           ORDER BY "updated_at" DESC, "created_at" DESC, "id" DESC
         ) AS position
  FROM "user_notifications"
  WHERE "type" = 'testimonial_like'
    AND "read" = false
    AND "data" ? 'testimonialId'
    AND "data"->>'testimonialId' IS NOT NULL
)
UPDATE "user_notifications" AS notification
SET "read" = (ranked.position > 1),
    "group_key" = CASE
      WHEN ranked.position = 1 THEN 'testimonial:' || ranked.testimonial_id
      ELSE NULL
    END
FROM ranked
WHERE notification."id" = ranked."id";--> statement-breakpoint
CREATE UNIQUE INDEX "user_notifications_unread_group_unique"
  ON "user_notifications" USING btree ("user_id", "type", "group_key")
  WHERE "read" = false AND "group_key" IS NOT NULL;--> statement-breakpoint
DELETE FROM "user_likes" AS likes
WHERE likes."target_type" = 'testimonial'
  AND NOT EXISTS (
    SELECT 1 FROM "book_testimonials" AS testimonial WHERE testimonial."id" = likes."target_id"
  );--> statement-breakpoint
DELETE FROM "user_notifications" AS notification
WHERE notification."type" = 'testimonial_like'
  AND notification."data"->>'testimonialId' IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "book_testimonials" AS testimonial
    WHERE testimonial."id"::text = notification."data"->>'testimonialId'
  );--> statement-breakpoint
CREATE OR REPLACE FUNCTION cleanup_book_testimonial_references()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM "user_likes"
  WHERE "target_type" = 'testimonial' AND "target_id" = OLD."id";

  DELETE FROM "user_notifications"
  WHERE "type" = 'testimonial_like'
    AND (
      "group_key" = 'testimonial:' || OLD."id"::text
      OR "data"->>'testimonialId' = OLD."id"::text
    );

  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "book_testimonial_cleanup_references"
AFTER DELETE ON "book_testimonials"
FOR EACH ROW
EXECUTE FUNCTION cleanup_book_testimonial_references();
