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
export const MAX_PAGES_PER_TRANSLATION_RUN = 50;
