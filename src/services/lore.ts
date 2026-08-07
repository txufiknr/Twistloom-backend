/**
 * Story-Bible (Lore) Service — Phase 5 author-curated canonical overrides.
 *
 * A `lore_entries` row is a structured canonical fact the author pins so the
 * engine's delta gate (§6.7) and prompt injection prefer it over live-but-wrong
 * story state. Every create/edit bumps `books.canonVersion` so any draft span
 * validated against an older world is correctly marked stale — the same clock
 * the page-publish path (Phase 0.d) increments (§6.7, §6.3).
 *
 * @see docs/roadmap/AI_CO_WRITING_PEN_ROADMAP.md §6.3, Phase 5
 */

import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { loreEntries, books } from "../db/schema.js";
import { dbRead, dbWrite } from "../db/client.js";
import { getBookFromDB } from "./book.js";
import type { DBLoreEntry, DBNewLoreEntry, DBBook } from "../types/schema.js";
import type { LoreEntry, LoreEntryInput, LoreEntryUpdate, LoreEntryType } from "../types/pen.js";

/** Error thrown when a lore entry does not exist or is not owned. */
export class LoreEntryNotFoundError extends Error {
  constructor(message = "Lore entry not found") {
    super(message);
    this.name = "LoreEntryNotFoundError";
  }
}

/** Error thrown when the authenticated user does not own the target book. */
export class LoreBookOwnershipError extends Error {
  constructor(message = "You do not own this book") {
    super(message);
    this.name = "LoreBookOwnershipError";
  }
}

/** Maps a DB row to the API shape, dropping column-name aliases. */
function toEntry(row: DBLoreEntry): LoreEntry {
  return {
    id: row.id,
    bookId: row.bookId,
    entryType: row.entryType as LoreEntryType,
    name: row.name,
    description: row.description,
    triggerKeywords: row.triggerKeywords ?? [],
    linkedCharacterId: row.linkedCharacterId,
    linkedPlaceId: row.linkedPlaceId,
    createdByUserId: row.userId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Returns the lore entries for a book the user owns, most recently edited first.
 * @throws LoreBookOwnershipError if the book does not exist or is not owned.
 */
export async function listLoreEntries(
  userId: string,
  bookId: string
): Promise<LoreEntry[]> {
  const book: DBBook | null = await getBookFromDB(bookId);
  if (!book) throw new LoreBookOwnershipError("Book not found");
  if (book.userId !== userId) throw new LoreBookOwnershipError();

  const rows = await dbRead
    .select()
    .from(loreEntries)
    .where(eq(loreEntries.bookId, bookId));

  return rows.map(toEntry);
}

/**
 * Returns the entries whose `triggerKeywords` appear in the given text (§6.3).
 *
 * This is the deterministic, author-controlled prompt-injection trigger: the
 * author tags an entry with keywords, and when any of them surfaces in the
 * assembled continuation context (`contextHistory` + recent prose + the
 * author's fragment), the entry is injected into the `/continue` user prompt
 * as a `CANONICAL LORE` block. Matching is case-insensitive on whole keywords
 * only, so a keyword never fires on a mere substring.
 *
 * Runs on the read path (no ownership check — the caller already owns the book)
 * and is called from `continuePenDraft`.
 */
export async function getTriggeredLoreEntries(bookId: string, haystack: string): Promise<LoreEntry[]> {
  if (!haystack) return [];
  const rows = await dbRead
    .select()
    .from(loreEntries)
    .where(eq(loreEntries.bookId, bookId));

  const needle = haystack.toLowerCase();
  return rows
    .filter((e) =>
      (e.triggerKeywords ?? []).some((kw) => {
        const lowered = kw.trim().toLowerCase();
        return lowered.length > 0 && needle.includes(lowered);
      })
    )
    .map(toEntry);
}

/**
 * Creates a new lore entry for a book the user owns and bumps `canonVersion`
 * so stale-invalidated drafts are made visible to the delta gate (§6.7).
 * @throws LoreBookOwnershipError if the book does not exist or is not owned.
 */
export async function createLoreEntry(
  userId: string,
  bookId: string,
  input: LoreEntryInput & { entryType: LoreEntryType }
): Promise<LoreEntry> {
  const book: DBBook | null = await getBookFromDB(bookId);
  if (!book) throw new LoreBookOwnershipError("Book not found");
  if (book.userId !== userId) throw new LoreBookOwnershipError();

  const values: DBNewLoreEntry = {
    bookId,
    entryType: input.entryType,
    name: input.name,
    description: input.description,
    triggerKeywords: input.triggerKeywords ?? [],
    linkedCharacterId: input.linkedCharacterId ?? null,
    linkedPlaceId: input.linkedPlaceId ?? null,
    userId,
  };

  const entry = await dbWrite.transaction(async (tx) => {
    const [created] = await tx.insert(loreEntries).values(values).returning();
    await tx
      .update(books)
      .set({ canonVersion: sql`${books.canonVersion} + 1`, updatedAt: new Date() })
      .where(eq(books.id, bookId));
    return created;
  });

  return toEntry(entry);
}

/**
 * Updates an existing lore entry owned by the user and bumps `canon_version`.
 * @throws LoreEntryNotFoundError if the entry does not exist or is not owned.
 */
export async function updateLoreEntry(
  userId: string,
  entryId: string,
  update: LoreEntryUpdate
): Promise<LoreEntry> {
  const [existing] = await dbRead
    .select()
    .from(loreEntries)
    .where(eq(loreEntries.id, entryId))
    .limit(1);

  if (!existing) throw new LoreEntryNotFoundError();
  if (existing.userId !== userId) throw new LoreEntryNotFoundError();

  const patch: Partial<DBNewLoreEntry> = {};
  if (update.entryType !== undefined) patch.entryType = update.entryType;
  if (update.name !== undefined) patch.name = update.name;
  if (update.description !== undefined) patch.description = update.description;
  if (update.triggerKeywords !== undefined) patch.triggerKeywords = update.triggerKeywords;
  if (update.linkedCharacterId !== undefined) patch.linkedCharacterId = update.linkedCharacterId ?? null;
  if (update.linkedPlaceId !== undefined) patch.linkedPlaceId = update.linkedPlaceId ?? null;

  const entry = await dbWrite.transaction(async (tx) => {
    const [updated] = await tx
      .update(loreEntries)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(loreEntries.id, entryId))
      .returning();
    await tx
      .update(books)
      .set({ canonVersion: sql`${books.canonVersion} + 1`, updatedAt: new Date() })
      .where(eq(books.id, existing.bookId));
    return updated;
  });

  return toEntry(entry);
}

/**
 * Deletes a lore entry owned by the user and bumps `canon_version`.
 * @throws LoreEntryNotFoundError if the entry does not exist or is not owned.
 */
export async function deleteLoreEntry(userId: string, entryId: string): Promise<void> {
  const [existing] = await dbRead
    .select()
    .from(loreEntries)
    .where(eq(loreEntries.id, entryId))
    .limit(1);

  if (!existing) throw new LoreEntryNotFoundError();
  if (existing.userId !== userId) throw new LoreEntryNotFoundError();

  await dbWrite.transaction(async (tx) => {
    await tx.delete(loreEntries).where(eq(loreEntries.id, entryId));
    await tx
      .update(books)
      .set({ canonVersion: sql`${books.canonVersion} + 1`, updatedAt: new Date() })
      .where(eq(books.id, existing.bookId));
  });
}