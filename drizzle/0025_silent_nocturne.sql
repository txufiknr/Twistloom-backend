ALTER TABLE "book_generations" ADD COLUMN "generation_duration_ms" integer GENERATED ALWAYS AS (CASE
        WHEN generation_completed_at IS NOT NULL AND generation_started_at IS NOT NULL
        THEN EXTRACT(EPOCH FROM (generation_completed_at - generation_started_at))::int * 1000
      END) STORED;