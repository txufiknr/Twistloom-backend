/**
 * Book read-authorization: the shared policy predicate, the authoritative
 * primary snapshot, and the two surface gates (reader page 401/403, book
 * detail 404 with admin bypass).
 *
 * As-built record with the status-code and cache-header contract:
 * docs/architecture/BOOK_ACCESS_AND_MODERATION_ARCHITECTURE.md §4.1-§4.3.
 */
import type { Context } from "hono";
import { eq } from "drizzle-orm";
import type { EnrichedBookData } from "../types/book.js";
import { dbWrite } from "../db/client.js";
import { books } from "../db/schema.js";
import { adminHasPermission, resolveAdminAccess } from "../middleware/admin-auth.js";
import { cForbiddenError, cNotFoundError, cUnauthorizedError } from "../utils/error.js";

/** The only fields the access policy depends on. */
export type BookAccessFields = Pick<EnrichedBookData, "userId" | "status" | "visibility">;

/**
 * Single source of truth for "this book is readable only by its owner".
 *
 * ## Policy matrix
 *
 * | `visibility` | `status` | Who can read |
 * |---|---|---|
 * | `public` / `unlisted` / `followers` | `active` | anyone (unlisted/followers keep their direct-link behaviour — they are *not* owner-restricted) |
 * | `private` | any | owner only |
 * | any | `archived` | owner only |
 * | any | `draft` | **not** restricted here — drafts get a slug only on first publish (see `updateBook`), so they are reachable at most by unguessable UUID, and the reader page path has always behaved the same way. Keep this deliberate: one policy, two surfaces, no drift. |
 *
 * Used by BOTH the reader page gate (`getBookPageAccessError`) and the book
 * detail gate (`getBookDetailAccessError`). Extend this predicate — never a
 * second, divergent copy — if the policy ever changes.
 *
 * @param book - Access-control fields of the book
 * @returns `true` when only the book's owner may read it
 */
export function isRestrictedToOwner(book: BookAccessFields): boolean {
  return book.status === "archived" || book.visibility === "private";
}

/**
 * Authoritative primary read of a book's access-control fields.
 *
 * ## Why this exists (do not replace it with the enriched LRU)
 *
 * `getEnrichedBook()` caches `status`/`visibility` in a **process-local** LRU
 * with a 5-minute TTL. That cache:
 * 1. cannot be invalidated across serverless instances (AGENTS.md §3.1 —
 *    process-local LRU must never coordinate globally-relevant state), and
 * 2. is read through `dbRead`, which is a **replica** in production
 *    (`DATABASE_READ_URL`, `src/db/client.ts`), so even a cache miss can lag a
 *    just-committed moderation.
 *
 * Authorization must therefore never trust the projection. This helper reads
 * `id, userId, status, visibility` by primary key from the **primary** write
 * connection, so an admin/author moderation is visible immediately on every
 * instance. Cost: one indexed single-row query on the read path (a
 * page-1/visit already performs at least one query); if profiling ever demands
 * it, a ≤2s keyed micro-cache may be layered *here* — bounded staleness in
 * seconds is the acceptable budget, minutes are not.
 *
 * @param bookId - Book UUID
 * @returns The authoritative access fields, or `null` when the row no longer exists
 */
export async function getBookAccessSnapshot(bookId: string): Promise<BookAccessFields | null> {
  const [row] = await dbWrite
    .select({
      userId: books.userId,
      status: books.status,
      visibility: books.visibility,
    })
    .from(books)
    .where(eq(books.id, bookId))
    .limit(1);

  if (!row) return null;
  return {
    userId: row.userId,
    status: row.status,
    visibility: row.visibility,
  };
}

/**
 * Enforces the page-read policy for private and archived books.
 *
 * Call this after resolving the book but before returning a prefetch or
 * recording a visit: visit recording can update progress and consume credits.
 * Unlisted and follower visibility keep their existing direct-link behavior.
 *
 * ## Status codes (page surface)
 * - `401` anonymous — "log in" (pre-existing contract, relied upon by readers)
 * - `403` authenticated non-owner
 *
 * The **detail** surface deliberately uses `404` instead — see
 * {@link getBookDetailAccessError} for why.
 *
 * Pass the output of {@link getBookAccessSnapshot}, not a cached projection.
 *
 * @param c - Hono context used to build the error response
 * @param book - Authoritative access fields of the book
 * @param userId - Authenticated reader, if any
 * @returns A `Response` to short-circuit with, or `null` when access is allowed
 */
export function getBookPageAccessError(
  c: Context,
  book: BookAccessFields,
  userId: string | null | undefined,
): Response | null {
  if (isRestrictedToOwner(book) && (!userId || userId !== book.userId)) {
    if (!userId) {
      return cUnauthorizedError(c, "Authentication required to view this book");
    }
    return cForbiddenError(c, "You do not have access to this book");
  }

  return null;
}

/**
 * Enforces the book-detail policy for private and archived books
 * (`GET /api/books/:identifier`).
 *
 * Pass the output of {@link getBookAccessSnapshot} — same contract as
 * {@link getBookPageAccessError} — so the caller holds one authoritative
 * snapshot that serves both this gate and its own cache-header/body
 * decisions. (The gate used to resolve and discard its own snapshot, which
 * forced the route to decide caching from the stale enriched LRU instead.)
 *
 * ## Access ladder
 * 1. Book not restricted → allow (no extra authorization queries).
 * 2. Owner (`book.userId === userId`) → allow. Load-bearing for the Pen editor
 *    SSR bootstrap, the generation tracker, and the mobile Spark creations tab.
 * 3. Admin with the `books` permission (`resolveAdminAccess`) → allow. Required
 *    by the web admin moderation panel, which reads other users' private books
 *    through this public endpoint (Twistloom-web `useAdminBookDetail`,
 *    "roadmap Decision B2").
 * 4. Otherwise → deny.
 *
 * ## Why 404 (not 401/403) on this surface
 * Both clients treat auth status codes as *session* events, not access events:
 * - **Web**: any client-side 401 emits an auth event that signs the user out
 *   app-wide (`src/lib/services/api.ts` → `AuthProvider.signOut()` →
 *   `/login?session=expired`). A reader merely opening a private book would be
 *   logged out.
 * - **Flutter**: `AuthInterceptor` treats 401/403 as token failure → refresh +
 *   replay, and can redirect to `/login/recovery`.
 *
 * `404` is inert on both (web renders `NotFoundPage`, Flutter renders
 * "not found"), matches the existing precedent in `routes/books.ts`
 * ("private books are never publicly reachable"), and does not confirm the
 * book's existence to strangers. The page surface keeps 401/403 because that
 * contract already shipped and readers depend on it.
 *
 * Denied responses must be emitted with `Cache-Control: no-store` by the route.
 *
 * @param c - Hono context used to build the error response
 * @param book - Authoritative access fields from {@link getBookAccessSnapshot};
 *   a `null` snapshot (row deleted) is the caller's 404, not this gate's
 * @param userId - Authenticated requester, if any
 * @returns A `Response` to short-circuit with, or `null` when access is allowed
 */
export async function getBookDetailAccessError(
  c: Context,
  book: BookAccessFields,
  userId: string | null | undefined,
): Promise<Response | null> {
  if (!isRestrictedToOwner(book)) {
    return null;
  }
  if (userId && userId === book.userId) {
    return null;
  }
  if (userId && adminHasPermission(await resolveAdminAccess(userId), "books")) {
    return null;
  }
  return cNotFoundError(c, "Book not found");
}
