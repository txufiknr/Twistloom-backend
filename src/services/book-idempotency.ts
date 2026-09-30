/**
 * @overview Book Creation Idempotency (Replay-on-Key)
 *
 * Implements the backend half of Open Findings Register **F-1**: a client may
 * send an `Idempotency-Key` header on a credit-bearing book-creation request,
 * and a replay of that request must return the book created by the *first*
 * attempt instead of charging and inserting a second draft.
 *
 * ## Why a database constraint and not Redis
 *
 * `utils/redis.ts` already exposes `setIdempotencyProcessing` / `checkIdempotency`,
 * and `routes/payments.ts` uses them. That primitive is deliberately fail-open
 * and TTL-bounded (300 s), which is correct for de-duplicating cheap
 * non-monetary calls but wrong for the money path: if Redis is cold, degraded
 * or the retry arrives after the TTL, the duplicate charge goes through.
 *
 * Here the authority is therefore a **partial unique index** on
 * `(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL`
 * (`books_user_idempotency_key_unique`), written in the *same* Postgres
 * transaction as the credit deduction (`executeWithCredits`):
 *
 * - Both attempts race → exactly one INSERT commits; the loser gets SQLSTATE
 *   `23505`, its transaction rolls back, and `executeWithCredits` reverts the
 *   deduction with it (see `services/credits.ts` failure path).
 * - Attempt 1 committed, response lost, client retries → the pre-flight lookup
 *   finds the row and replays before any AI call or charge happens.
 *
 * No lock, no Redis, no clock: correctness comes from the index alone.
 *
 * ## Contract
 *
 * - Scope is **per user**: `(userId, key)`. Two users may legitimately reuse the
 *   same key string; a key is never a cross-user capability.
 * - Absent / blank header → `key === null` → no replay protection (behaviour
 *   unchanged from before this module existed).
 * - Malformed key → the route rejects with 400 rather than silently dropping
 *   replay protection the client believes it has.
 * - A key reused with a *different* payload replays the original book. Clients
 *   mint a fresh key whenever the request subject changes (Flutter's
 *   `SparkController._keyFor` keys on `mode|prompt`), so this cannot happen in
 *   practice for the supported flows.
 *
 * @see POST /api/books/async, POST /api/books, POST /api/books/stream
 */

import { and, eq } from "drizzle-orm";
import { dbWrite } from "../db/client.js";
import { bookGenerations, books, pages } from "../db/schema.js";
import { mapBookFromDb, mapToUserStoryPage } from "./book.js";
import { getStoryStateFromPage } from "./story.js";
import type { Book, CreateBookResponse } from "../types/book.js";
import type { DBBook } from "../types/schema.js";

/** Minimum accepted `Idempotency-Key` length (chars, after trim). */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;

/** Maximum accepted `Idempotency-Key` length (chars, after trim). */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

/**
 * Success message replayed on a duplicate `POST /api/books/async`.
 * Single source of truth so the original and replay responses are identical.
 */
export const BOOK_CREATION_STARTED_MESSAGE =
  'Book creation started. Poll /api/books/:bookId/status for updates.';

/** PostgreSQL SQLSTATE for a unique_violation. */
const UNIQUE_VIOLATION_SQLSTATE = '23505';

/**
 * Printable ASCII without spaces — accepts UUIDs, UUIDv7, prefixed hashes and
 * any other opaque token a client would reasonably mint.
 */
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]+$/;

/** Result of reading the `Idempotency-Key` header off a request. */
export type ParsedIdempotencyKey =
  | { ok: true; key: string | null }
  | { ok: false; error: string };

/**
 * `POST /api/books/async` response rebuilt for a replayed request.
 * `duplicate: true` is additive so clients that ignore it keep working while
 * clients that want to suppress a second "creation started" transition can.
 */
export type AsyncCreationReplay = {
  bookId: string;
  message: string;
  aiComment: string | null | undefined;
  book: Book;
  duplicate: true;
};

/**
 * Reads and validates the `Idempotency-Key` request header.
 *
 * A missing or blank header is **not** an error — it yields `{ ok, key: null }`
 * and the caller simply skips replay protection. A present-but-malformed key is
 * an error, because ignoring it would silently unprotect a request the client
 * believes is protected.
 *
 * @param raw - Raw header value (`c.req.header('idempotency-key')`)
 * @returns `{ ok: true, key }` on success (`key === null` = header absent),
 *   `{ ok: false, error }` with a client-safe message when malformed
 * @example
 * ```typescript
 * const parsed = parseIdempotencyKey(c.req.header('idempotency-key'));
 * if (!parsed.ok) return cValidationError(c, parsed.error);
 * ```
 */
export function parseIdempotencyKey(raw: string | undefined | null): ParsedIdempotencyKey {
  if (raw === undefined || raw === null || raw.trim().length === 0) {
    return { ok: true, key: null };
  }

  const key = raw.trim();

  if (key.length < IDEMPOTENCY_KEY_MIN_LENGTH || key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    return {
      ok: false,
      error: `Idempotency-Key must be between ${IDEMPOTENCY_KEY_MIN_LENGTH} and ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
    };
  }

  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return {
      ok: false,
      error: 'Idempotency-Key must contain printable ASCII characters only (no spaces or control characters)',
    };
  }

  return { ok: true, key };
}

/**
 * Looks up the book previously created under `(userId, idempotencyKey)`.
 *
 * Deliberately reads from `dbWrite` (primary), not the `dbRead` replica: a
 * replica lagging behind the original commit would make a legitimate replay
 * look like a first attempt. The unique index still makes a stale miss safe —
 * the INSERT loses the race and lands in {@link replayOnUniqueViolation} — but
 * paying one indexed primary read beats paying a wasted AI generation.
 *
 * @param userId - Owner of the book (and scoping half of the unique index)
 * @param idempotencyKey - Already-validated key
 * @returns The matching book row, or `null` when this is a genuine first attempt
 */
export async function findBookByIdempotencyKey(
  userId: string,
  idempotencyKey: string
): Promise<DBBook | null> {
  const [row] = await dbWrite
    .select()
    .from(books)
    .where(and(eq(books.userId, userId), eq(books.idempotencyKey, idempotencyKey)))
    .limit(1);

  return row ?? null;
}

/**
 * Reports whether an error is a PostgreSQL unique-constraint violation (23505).
 *
 * Checks both the error and its `cause`, because drivers and connection pools
 * sometimes wrap the original `DatabaseError`. Deliberately SQLSTATE-based
 * rather than message-matching: message text is locale/driver dependent.
 *
 * @param error - Any caught value
 * @returns `true` only for SQLSTATE 23505
 */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const candidates: unknown[] = [error];
  if ('cause' in error) candidates.push((error as { cause?: unknown }).cause);

  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const code = (candidate as { code?: unknown }).code;
    if (typeof code === 'string' && code === UNIQUE_VIOLATION_SQLSTATE) return true;
  }

  return false;
}

/**
 * Converts a lost idempotency race into a replay, or reports "not ours".
 *
 * Call this from the route's `catch` around the charged insert. Returns the
 * replayed response only when the violation really was the idempotency index:
 * a winner row is re-read **by key**, so a 23505 raised by a *different* unique
 * index (e.g. `books_slug_unique`) falls through as `null` and the route keeps
 * its normal error handling. When it does return a replay, the losing
 * transaction — including its credit deduction — has already rolled back.
 *
 * @param error - Error caught from the charged creation call
 * @param options - User scope, validated key, and the replay payload builder
 * @returns The replayed payload, or `null` when the error is unrelated
 * @example
 * ```typescript
 * try {
 *   const book = await chargeAndInsert();
 * } catch (error) {
 *   const replay = await replayOnUniqueViolation(error, {
 *     userId, key, buildReplay: buildAsyncReplay,
 *   });
 *   if (replay) return c.json(replay, 202);
 *   throw error;
 * }
 * ```
 */
export async function replayOnUniqueViolation<T>(
  error: unknown,
  options: {
    userId: string;
    key: string | null;
    buildReplay: (book: DBBook) => Promise<T>;
  }
): Promise<T | null> {
  const { userId, key, buildReplay } = options;

  if (!key || !isUniqueViolation(error)) return null;

  const winner = await findBookByIdempotencyKey(userId, key);
  if (!winner) return null;

  console.log(
    `[book-idempotency] ♻️ Duplicate creation request for user ${userId}; replaying book ${winner.id}`
  );

  // A replay that cannot be rebuilt (page 1 or its state missing) must not
  // mask the original 23505 — fall through so the route keeps its normal error
  // handling instead of turning a rare data anomaly into an unhandled throw.
  try {
    return await buildReplay(winner);
  } catch (replayError) {
    console.error(`[book-idempotency] ❌ Failed to rebuild replay for book ${winner.id}:`, replayError);
    return null;
  }
}

/**
 * Rebuilds the `POST /api/books/async` 202 payload for an already-created book.
 *
 * Everything is reconstructable from committed state: `aiComment` lives on the
 * `book_generations` row written in the same transaction as the draft, and the
 * book itself is re-mapped from the `books` row. No workflow is re-dispatched —
 * the original attempt already dispatched (or stale-detection in
 * `GET /books/:bookId/status` will), so a replay must stay a pure read.
 *
 * @param dbBook - Book row found via {@link findBookByIdempotencyKey}
 * @returns The original 202 body plus `duplicate: true`
 */
export async function buildAsyncReplay(dbBook: DBBook): Promise<AsyncCreationReplay> {
  const [generation] = await dbWrite
    .select({ aiComment: bookGenerations.aiComment })
    .from(bookGenerations)
    .where(eq(bookGenerations.bookId, dbBook.id))
    .limit(1);

  return {
    bookId: dbBook.id,
    message: BOOK_CREATION_STARTED_MESSAGE,
    aiComment: generation?.aiComment,
    book: mapBookFromDb(dbBook),
    duplicate: true,
  };
}

/**
 * Rebuilds a `CreateBookResponse` (used by `POST /books` and `POST /books/stream`)
 * for an already-created book.
 *
 * Page 1 and its story state were both committed by the original attempt, so
 * the replay is a pair of indexed reads — no AI call, no charge, no SSE
 * progress events. `firstPage` is the same persisted shape the normal path
 * returns (`UserStoryPage` extends `StoryPage`).
 *
 * @param dbBook - Book row found via {@link findBookByIdempotencyKey}
 * @param userId - Reader whose page-1 selections should populate `selectedActions`
 * @returns The original response body plus `duplicate: true`
 * @throws When page 1 or its story state is missing — a book in that state
 *   cannot be replayed faithfully, and failing loudly beats returning a
 *   half-populated response the client would render as a broken story.
 */
export async function buildCreationReplay(
  dbBook: DBBook,
  userId: string
): Promise<CreateBookResponse & { duplicate: true }> {
  const [dbPage] = await dbWrite
    .select()
    .from(pages)
    .where(and(eq(pages.bookId, dbBook.id), eq(pages.page, 1)))
    .limit(1);

  if (!dbPage) {
    throw new Error(`Idempotent replay: page 1 not found for book ${dbBook.id}`);
  }

  const initialState = await getStoryStateFromPage(dbPage);
  if (!initialState) {
    throw new Error(`Idempotent replay: story state not found for book ${dbBook.id}`);
  }

  const firstPage = await mapToUserStoryPage(dbPage, userId);

  return {
    book: mapBookFromDb(dbBook),
    firstPage,
    initialState,
    duplicate: true,
  };
}
