/** Maximum generation duration before considering it stuck */
export const MAX_GENERATION_DURATION_MS = 30 * 60 * 1000; // 30 minutes

/** Maximum number of pending book covers to process per run */
/// Note: Automatic cover image AI generation is disabled to reduce cost and load, manual handcraft is encouraged
export const MAX_PENDING_BOOK_COVER_PER_RUN = 0;