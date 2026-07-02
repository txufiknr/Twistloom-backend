/** Maximum generation duration before considering it stuck */
export const MAX_GENERATION_DURATION_MS = 30 * 60 * 1000; // 30 minutes

/** Maximum number of pending book covers to process per run */
export const MAX_PENDING_BOOK_COVER_PER_RUN = 0;

/** Maximum length of final congratulatory comment from AI */
export const MAX_FINAL_COMMENT_LENGTH = 500;

/** Maximum number of pending/failed book generations to retry per hourly routine */
export const HOURLY_RETRY_BATCH_SIZE = 5;

/** Timeout thresholds for stale generation detection */
export const PENDING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes for pending status