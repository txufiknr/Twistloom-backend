/**
 * Pen (AI Co-Writing) service — Phase 1.a session lifecycle.
 *
 * Model C (draft-then-finalize): one active Pen session per (user, book). The
 * session owns a private span buffer (`draftBuffer`) over one book; `/finalize`
 * is the only way a draft becomes a published page; `/discard` throws it away.
 *
 * @see docs/roadmap/AI_CO_WRITING_PEN_ROADMAP.md §5.3, Phase 1.a
 */

import { eq, and } from "drizzle-orm";
import { penSessions } from "../db/schema.js";
import { dbRead, dbWrite } from "../db/client.js";
import { getBookFromDB } from "./book.js";
import type { DBBook, DBPenSession } from "../types/schema.js";
import type { AuthoringMode, PenSessionStatus } from "../types/pen.js";
import type { BookMode } from "../types/book.js";

/**
 * The API-facing session payload. Extends the stored session with the book's
 * branching contract (`bookMode`) so the editor knows how many actions it can
 * offer and how Continue/finalize behave (§1.a).
 */
export type PenSessionPayload = DBPenSession & {
  /** `books.mode` — the branching contract the editor must respect. */
  bookMode: BookMode;
};

/**
 * Converts a stored session row into the API payload by attaching the book's
 * mode. Throws if the book no longer exists (session rows cascade on book delete,
 * but a stale FK is still defensively handled).
 */
async function toPenSessionPayload(session: DBPenSession): Promise<PenSessionPayload> {
  const book = await getBookFromDB(session.bookId);
  if (!book) throw new Error(`Book not found for pen session: ${session.bookId}`);
  return { ...session, bookMode: book.mode };
}

/** Error thrown when the requested pen session does not exist or is not owned. */
export class PenSessionNotFoundError extends Error {
  constructor(message = "Pen session not found") {
    super(message);
    this.name = "PenSessionNotFoundError";
  }
}

/** Error thrown when a pen session already exists for the (user, book) pair. */
export class PenSessionConflictError extends Error {
  constructor(message = "An active pen session already exists for this book") {
    super(message);
    this.name = "PenSessionConflictError";
  }
}

/**
 * Creates a Pen session for a book the user owns.
 *
 * @param userId - The authenticated user's id
 * @param params - `bookId`, `authoringMode`, optional `assistanceLevel` (0..1)
 * @throws PenSessionConflictError if an active session already exists for the book
 */
export async function createPenSession(
  userId: string,
  params: { bookId: string; authoringMode: AuthoringMode; assistanceLevel?: number }
): Promise<PenSessionPayload> {
  const book: DBBook | null = await getBookFromDB(params.bookId);
  if (!book) throw new PenSessionNotFoundError("Book not found");

  const assistanceLevel =
    params.assistanceLevel !== undefined
      ? Math.min(1, Math.max(0, params.assistanceLevel))
      : 0.5;

  const created = await dbWrite.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(penSessions)
      .where(and(eq(penSessions.userId, userId), eq(penSessions.bookId, params.bookId)))
      .limit(1);

    if (existing) throw new PenSessionConflictError();

    const [session] = await tx
      .insert(penSessions)
      .values({
        userId,
        bookId: params.bookId,
        authoringMode: params.authoringMode,
        assistanceLevel,
        status: "active",
        draftBuffer: [],
      })
      .returning();

    return session;
  });

  return toPenSessionPayload(created);
}

/**
 * Returns the active (or most recent) Pen session for a book, or null if none.
 *
 * @param userId - The authenticated user's id (ownership guard)
 * @param bookId - The book to look up
 */
export async function getPenSessionForBook(userId: string, bookId: string): Promise<PenSessionPayload | null> {
  const [session] = await dbRead
    .select()
    .from(penSessions)
    .where(and(eq(penSessions.userId, userId), eq(penSessions.bookId, bookId)))
    .orderBy(penSessions.updatedAt)
    .limit(1);

  if (!session) return null;
  return toPenSessionPayload(session);
}

/**
 * Returns a Pen session by id, verifying ownership.
 *
 * @param userId - The authenticated user's id (ownership guard)
 * @param sessionId - The session to load
 * @throws PenSessionNotFoundError if missing or owned by another user
 */
export async function getPenSessionById(userId: string, sessionId: string): Promise<PenSessionPayload> {
  const [session] = await dbRead
    .select()
    .from(penSessions)
    .where(and(eq(penSessions.id, sessionId), eq(penSessions.userId, userId)))
    .limit(1);

  if (!session) throw new PenSessionNotFoundError();
  return toPenSessionPayload(session);
}

/** Allowed PATCH fields on a pen session. */
export type PenSessionUpdates = {
  assistanceLevel?: number;
  status?: PenSessionStatus;
  currentPageId?: string | null;
};

/**
 * Applies allowed PATCH updates to a session the user owns.
 *
 * @param userId - The authenticated user's id (ownership guard)
 * @param sessionId - The session to update
 * @param updates - `assistanceLevel`, `status`, or `currentPageId`
 * @throws PenSessionNotFoundError if missing or owned by another user
 */
export async function updatePenSession(
  userId: string,
  sessionId: string,
  updates: PenSessionUpdates
): Promise<PenSessionPayload> {
  const values: typeof updates = {};

  if (updates.assistanceLevel !== undefined) {
    values.assistanceLevel = Math.min(1, Math.max(0, updates.assistanceLevel));
  }
  if (updates.status !== undefined) {
    values.status = updates.status;
  }
  if (updates.currentPageId !== undefined) {
    values.currentPageId = updates.currentPageId;
  }

  const [updated] = await dbWrite
    .update(penSessions)
    .set(values)
    .where(and(eq(penSessions.id, sessionId), eq(penSessions.userId, userId)))
    .returning();

  if (!updated) throw new PenSessionNotFoundError();
  return toPenSessionPayload(updated);
}

/**
 * Marks a session `closed` (end of the current editing pass; the draft is
 * preserved for resume). Ownership is verified.
 */
export async function closePenSession(userId: string, sessionId: string): Promise<PenSessionPayload> {
  return updatePenSession(userId, sessionId, { status: "closed" });
}

/**
 * Clears the draft buffer without charging credits (`/discard`). Ownership is
 * verified. Returns the cleared session.
 */
export async function discardPenDraft(userId: string, sessionId: string): Promise<PenSessionPayload> {
  const [updated] = await dbWrite
    .update(penSessions)
    .set({ draftBuffer: [] })
    .where(and(eq(penSessions.id, sessionId), eq(penSessions.userId, userId)))
    .returning();

  if (!updated) throw new PenSessionNotFoundError();
  return toPenSessionPayload(updated);
}
