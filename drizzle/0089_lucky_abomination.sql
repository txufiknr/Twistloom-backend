ALTER TABLE "user_counters" ADD COLUMN "stories_completed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_counters" ADD COLUMN "alternate_endings_discovered" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_counters" ADD COLUMN "deep_branch_completions" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_counters" ADD COLUMN "distinct_ending_types_reached" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_counters" ADD COLUMN "rare_endings_found" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_counters" ADD COLUMN "branch_points_explored" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_counters" ADD COLUMN "high_risk_choices_taken" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_counters" ADD COLUMN "clues_uncovered" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_counters" ADD COLUMN "threads_resolved" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_counters" ADD COLUMN "consequence_experienced" integer DEFAULT 0 NOT NULL;