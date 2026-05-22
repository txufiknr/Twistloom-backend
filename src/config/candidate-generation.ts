/** Maximum generation duration before considering it stuck */
export const MAX_GENERATION_DURATION_MS = 30 * 60 * 1000; // 30 minutes
export const MAX_GENERATION_PARALLEL_DURATION_MS = 780_000; // 13 minutes for cron jobs (20s buffer)

/** Maximum number of pending book covers to process per run */
/// Note: Automatic cover image AI generation is disabled to reduce cost and load, manual handcraft is encouraged
export const MAX_PENDING_BOOK_COVER_PER_RUN = 0;

export const ALLOW_DEEPER_LEVEL_UNTIL_PAGE = 3;