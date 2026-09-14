/**
 * @fileoverview Page Illustration Generation Configuration
 *
 * Centralized constants for the AI page illustration feature.
 * Both the cron job and lazy generation import from this file to prevent drift.
 *
 * Reference pattern: `src/config/ai-images.ts` (`AI_IMAGE_CONFIG`).
 */

/**
 * Importance threshold above which a page qualifies for illustration generation.
 * Pages with `imageImportance > THRESHOLD` are candidates for the cron job
 * and lazy generation.
 *
 * The backend ALREADY populates `pages.image_importance` (0.0–1.0) for every
 * AI-generated page via `generateNextPage(s)`. This threshold gates which
 * pages actually get images — only high-impact narrative moments.
 */
export const ILLUSTRATION_IMPORTANCE_THRESHOLD = 0.8;

/**
 * Maximum illustrations per book (cost cap). The cron job and lazy generation
 * stop generating once a book reaches this count.
 */
export const MAX_ILLUSTRATIONS_PER_BOOK = 15;

/**
 * Aspect ratio passed to `geminiGenerateImage()`. 16:9 matches the backdrop
 * layout (CSS `background-size: cover` on a wide viewport).
 */
export const ILLUSTRATION_ASPECT_RATIO = "16:9" as const;

/**
 * JPEG quality for generated illustrations (0–100). Lower = smaller files,
 * faster uploads. 80 is a good balance for CDN delivery.
 */
export const ILLUSTRATION_JPEG_QUALITY = 80;

/**
 * ImageKit folder for page illustrations. Keeps them separate from covers,
 * avatars, and Pen inline images for easier lifecycle management.
 */
export const ILLUSTRATION_IMAGEKIT_FOLDER = "page-illustrations";

/**
 * ImageKit format negotiation suffix. Appended to ImageKit URLs to enable
 * automatic WebP/AVIF conversion based on the client's Accept header.
 * Reduces bandwidth by 30-50% vs JPEG for modern browsers.
 * Example: https://ik.imagekit.io/.../illustration.jpg?f=auto
 */
export const ILLUSTRATION_FORMAT_SUFFIX = "?f=auto";
