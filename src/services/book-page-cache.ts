/**
 * Returns the cache policy for a reader-page response.
 *
 * Authenticated page projections can contain user-specific selections and
 * session state, so they must never enter a shared or browser cache. Anonymous
 * public page projections retain the short cache used by the reader.
 */
export function getBookPageCacheControl(userId?: string | null): string {
  return userId ? "private, no-store" : "public, max-age=60";
}