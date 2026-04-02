/**
 * @overview Pagination Configuration
 * 
 * Provides configurable pagination settings for the application.
 * These settings control default behavior and limits across all paginated endpoints.
 */

/**
 * Default number of items per page for pagination
 * 
 * This setting provides a balance between performance and user experience.
 * Can be overridden per endpoint or by client request.
 */
export const DEFAULT_ITEMS_PER_PAGE = 10;

/**
 * Maximum number of items per page allowed
 * 
 * Prevents excessive database queries and large response payloads.
 * Clients can request up to this many items per page.
 */
export const MAX_ITEMS_PER_PAGE = 100;
