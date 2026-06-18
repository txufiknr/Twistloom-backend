/**
 * Translation configuration
 */

/**
 * Maximum number of books to translate per cron job run
 * This prevents the job from taking too long and consuming too many API credits
 */
export const MAX_BOOKS_PER_TRANSLATION_RUN = 10;

/**
 * Maximum number of pages to translate per cron job run
 * This prevents the job from taking too long and consuming too many API credits
 */
export const MAX_PAGES_PER_TRANSLATION_RUN = 10;

/**
 * Number of books to translate in a single AI request (bulk processing)
 * Higher values are more cost-efficient but may hit token limits
 */
export const BOOKS_PER_BULK_TRANSLATION = 10;

/**
 * Number of pages to translate in a single AI request (bulk processing)
 * Higher values are more cost-efficient but may hit token limits
 */
export const PAGES_PER_BULK_TRANSLATION = 10;