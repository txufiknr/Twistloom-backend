/**
 * Bulk-like request contract (POST /api/books/likes/bulk).
 *
 * Pure, DB-free parsing of the `bookIds` batch so the route's failure
 * boundary (400 responses) is unit-testable without importing the books
 * route module. Kept in `utils/` as shared request-shape logic rather than
 * inlined in a route handler for the same reason.
 *
 * Limits:
 * - raw array ≤ {@link BULK_LIKE_MAX_RAW_IDS} entries (bounds parse work)
 * - entries must be non-empty strings
 * - after dedupe, ≤ {@link BULK_LIKE_MAX_IDS} unique ids (batch size)
 *
 * Dedupe preserves first-seen order so responses stay deterministic for a
 * given request.
 */

/** Unique book ids accepted per bulk-like request (wizard batch size). */
export const BULK_LIKE_MAX_IDS = 20;

/** Raw array ceiling — bounds parse work before dedupe. */
export const BULK_LIKE_MAX_RAW_IDS = 100;

/** Result of {@link parseBulkLikeIds}: ids to like, or a 400-safe message. */
export type BulkLikeIdsResult =
  | { ok: true; ids: string[] }
  | { ok: false; error: string };

/**
 * Validates and deduplicates a raw `bookIds` request value.
 *
 * @param raw - Untrusted request value (any type from parsed JSON)
 * @returns Deduplicated ids in first-seen order, or the error message to
 *          return as a 400 validation error
 */
export function parseBulkLikeIds(raw: unknown): BulkLikeIdsResult {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "bookIds must be a non-empty array" };
  }
  if (raw.length > BULK_LIKE_MAX_RAW_IDS) {
    return {
      ok: false,
      error: `bookIds may contain at most ${BULK_LIKE_MAX_RAW_IDS} entries`,
    };
  }
  if (raw.some((id) => typeof id !== "string" || id.length === 0)) {
    return { ok: false, error: "bookIds must contain non-empty strings" };
  }
  const ids = [...new Set(raw as string[])];
  if (ids.length > BULK_LIKE_MAX_IDS) {
    return {
      ok: false,
      error: `A maximum of ${BULK_LIKE_MAX_IDS} unique bookIds is allowed per request`,
    };
  }
  return { ok: true, ids };
}
