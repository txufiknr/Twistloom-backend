import type { Context } from "hono";
import type { EnrichedBookData } from "../types/book.js";
import { cForbiddenError, cUnauthorizedError } from "../utils/error.js";

/**
 * Enforces the existing page-read policy for private and archived books.
 *
 * Call this after resolving the book but before returning a prefetch or
 * recording a visit: visit recording can update progress and consume credits.
 * Unlisted and follower visibility keep their existing direct-link behavior.
 */
export function getBookPageAccessError(
  c: Context,
  book: Pick<EnrichedBookData, "userId" | "status" | "visibility">,
  userId: string | null | undefined,
): Response | null {
  if (
    (book.status === "archived" || book.visibility === "private") &&
    (!userId || userId !== book.userId)
  ) {
    if (!userId) {
      return cUnauthorizedError(c, "Authentication required to view this book");
    }
    return cForbiddenError(c, "You do not have access to this book");
  }

  return null;
}