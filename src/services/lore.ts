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

import { eq, getTableColumns, sql } from "drizzle-orm";
import { loreEntries, books, uploadedImages } from "../db/schema.js";
import { dbRead, dbWrite } from "../db/client.js";
import { getBookFromDB } from "./book.js";
import {
  uploadLoreCharacterImage,
  persistUploadedImage,
  deleteFileFromImageKit,
  isBase64Upload,
} from "./image.js";
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

/** Maps a DB row + joined imageUrl to the API shape. */
function toEntry(row: DBLoreEntry & { imageUrl?: string | null }): LoreEntry {
  return {
    id: row.id,
    bookId: row.bookId,
    entryType: row.entryType as LoreEntryType,
    name: row.name,
    description: row.description,
    triggerKeywords: row.triggerKeywords ?? [],
    linkedCharacterId: row.linkedCharacterId,
    linkedPlaceId: row.linkedPlaceId,
    imageId: row.imageId,
    imageUrl: row.imageUrl ?? null,
    createdByUserId: row.userId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Returns the lore entries for a book the user owns, joined with `uploaded_images`
 * for canonical image URLs.
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
    .select({
      ...getTableColumns(loreEntries),
      imageUrl: uploadedImages.imageUrl,
    })
    .from(loreEntries)
    .leftJoin(uploadedImages, eq(loreEntries.imageId, uploadedImages.imageId))
    .where(eq(loreEntries.bookId, bookId));

  return rows.map(toEntry);
}

/**
 * Returns the entries whose `triggerKeywords` appear in the given text (§6.3).
 *
 * Runs on the read path (no ownership check — the caller already owns the book)
 * and is called from `continuePenDraft`.
 */
export async function getTriggeredLoreEntries(bookId: string, haystack: string): Promise<LoreEntry[]> {
  if (!haystack) return [];
  const rows = await dbRead
    .select({
      ...getTableColumns(loreEntries),
      imageUrl: uploadedImages.imageUrl,
    })
    .from(loreEntries)
    .leftJoin(uploadedImages, eq(loreEntries.imageId, uploadedImages.imageId))
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
 * If the entry is a character with a base64 avatar, uploads to ImageKit and
 * tracks in `uploaded_images`.
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

  let newImageId: string | null = null;
  let newImageUrl: string | null = null;

  if (input.entryType === "character" && input.imageUrl && isBase64Upload(input.imageUrl)) {
    const uploadResult = await uploadLoreCharacterImage(input.imageUrl, bookId, input.name);
    if (!uploadResult?.url) {
      throw new Error("Failed to upload character avatar image to ImageKit");
    }
    newImageId = uploadResult.fileId;
    newImageUrl = uploadResult.url;
  } else if (input.imageUrl && !isBase64Upload(input.imageUrl)) {
    newImageUrl = input.imageUrl;
    newImageId = input.imageId ?? null;
  }

  const values: DBNewLoreEntry = {
    bookId,
    entryType: input.entryType,
    name: input.name,
    description: input.description,
    triggerKeywords: input.triggerKeywords ?? [],
    linkedCharacterId: input.linkedCharacterId ?? null,
    linkedPlaceId: input.linkedPlaceId ?? null,
    imageId: newImageId,
    userId,
  };

  try {
    const entry = await dbWrite.transaction(async (tx) => {
      if (newImageId && newImageUrl) {
        await persistUploadedImage({
          imageId: newImageId,
          imageUrl: newImageUrl,
          type: "lore_character",
          userId,
          client: tx,
        });
      }

      const [created] = await tx.insert(loreEntries).values(values).returning();
      await tx
        .update(books)
        .set({ canonVersion: sql`${books.canonVersion} + 1`, updatedAt: new Date() })
        .where(eq(books.id, bookId));
      return created;
    });

    return toEntry({ ...entry, imageUrl: newImageUrl });
  } catch (error) {
    if (newImageId) {
      await deleteFileFromImageKit(newImageId);
    }
    throw error;
  }
}

/**
 * Updates an existing lore entry owned by the user and bumps `canon_version`.
 * Handles replacing or clearing character avatar portraits on ImageKit.
 * @throws LoreEntryNotFoundError if the entry does not exist or is not owned.
 */
export async function updateLoreEntry(
  userId: string,
  entryId: string,
  update: LoreEntryUpdate
): Promise<LoreEntry> {
  const [existing] = await dbRead
    .select({
      ...getTableColumns(loreEntries),
      imageUrl: uploadedImages.imageUrl,
    })
    .from(loreEntries)
    .leftJoin(uploadedImages, eq(loreEntries.imageId, uploadedImages.imageId))
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

  let newImageId: string | null = null;
  let newImageUrl: string | null = null;
  let oldImageIdToDelete: string | null = null;
  let effectiveImageUrl: string | null = existing.imageUrl;

  if (update.imageUrl !== undefined) {
    if (!update.imageUrl || update.imageUrl.trim() === "") {
      // Cleared avatar
      patch.imageId = null;
      effectiveImageUrl = null;
      if (existing.imageId) {
        oldImageIdToDelete = existing.imageId;
      }
    } else if (isBase64Upload(update.imageUrl)) {
      // Upload new base64 image
      const charName = update.name || existing.name;
      const uploadResult = await uploadLoreCharacterImage(update.imageUrl, existing.bookId, charName);
      if (!uploadResult?.url) {
        throw new Error("Failed to upload character avatar image to ImageKit");
      }
      newImageId = uploadResult.fileId;
      newImageUrl = uploadResult.url;
      patch.imageId = newImageId;
      effectiveImageUrl = newImageUrl;
      if (existing.imageId) {
        oldImageIdToDelete = existing.imageId;
      }
    } else {
      // Retaining remote URL
      effectiveImageUrl = update.imageUrl;
      if (update.imageId !== undefined) {
        patch.imageId = update.imageId;
      }
    }
  }

  try {
    const entry = await dbWrite.transaction(async (tx) => {
      if (newImageId && newImageUrl) {
        await persistUploadedImage({
          imageId: newImageId,
          imageUrl: newImageUrl,
          type: "lore_character",
          userId,
          client: tx,
        });
      }

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

    if (oldImageIdToDelete) {
      await deleteFileFromImageKit(oldImageIdToDelete);
    }

    return toEntry({ ...entry, imageUrl: effectiveImageUrl });
  } catch (error) {
    if (newImageId) {
      await deleteFileFromImageKit(newImageId);
    }
    throw error;
  }
}

/**
 * Deletes a lore entry owned by the user and bumps `canon_version`.
 * Cleans up any avatar image associated with the entry from ImageKit.
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

  if (existing.imageId) {
    await deleteFileFromImageKit(existing.imageId);
  }
}