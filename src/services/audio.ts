/**
 * Audio upload + library service.
 *
 * Handles user audio uploads to ImageKit (folder: user-audio/),
 * library listing, and deletion with in-use checks against book_place_bgm.
 */

import { dbRead, dbWrite, type DBClient } from "../db/client.js";
import { userAudioLibrary, bookPlaceBgm } from "../db/schema.js";
import { eq, and, or, count } from "drizzle-orm";
import { uploadImageKit, deleteFileFromImageKit } from "./image.js";
import type { ImageUploadSource } from "../types/image.js";

export type UserAudioLibraryItem = {
  id: string;
  fileUrl: string;
  fileId: string;
  fileName: string | null;
  fileSize: number | null;
  durationSec: number | null;
  mimeType: string | null;
  createdAt: Date;
};

/**
 * Upload an audio file to ImageKit and persist a library row.
 */
export async function uploadUserAudio(
  audioSource: ImageUploadSource,
  userId: string,
  fileName: string,
  mimeType: string,
  fileSize: number,
): Promise<{ id: string; fileUrl: string; fileId: string } | null> {
  const uploadResult = await uploadImageKit(audioSource, userId, {
    folder: 'user-audio',
    tags: ['user-audio', `user-id:${userId}`],
    filenamePrefix: 'audio',
  });

  if (!uploadResult) return null;

  const [row] = await dbWrite
    .insert(userAudioLibrary)
    .values({
      userId,
      fileUrl: uploadResult.url,
      fileId: uploadResult.fileId,
      fileName,
      fileSize,
      mimeType,
    })
    .returning({ id: userAudioLibrary.id });

  return { id: row.id, fileUrl: uploadResult.url, fileId: uploadResult.fileId };
}

/**
 * List all audio library items for a user.
 */
export async function listAudioLibrary(userId: string): Promise<UserAudioLibraryItem[]> {
  return dbRead
    .select()
    .from(userAudioLibrary)
    .where(eq(userAudioLibrary.userId, userId))
    .orderBy(userAudioLibrary.createdAt);
}

/**
 * Check how many book_place_bgm rows reference a library item's fileId.
 *
 * @param client - Database client to use; pass `tx` inside a transaction to
 *   avoid TOCTOU races between the ref-count check and the subsequent delete.
 */
async function getLibraryItemRefCount(fileId: string, client: DBClient = dbRead): Promise<number> {
  const [{ cnt }] = await client
    .select({ cnt: count() })
    .from(bookPlaceBgm)
    .where(or(
      eq(bookPlaceBgm.primaryFileId, fileId),
      eq(bookPlaceBgm.variantFileId, fileId),
    ));
  return cnt;
}

/**
 * Delete a library item. Rejects (409) if referenced by any book_place_bgm.
 * The check-then-delete is wrapped in a transaction to prevent TOCTOU races.
 */
export async function deleteAudioLibraryItem(
  userId: string,
  libraryId: string,
): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'in_use'; refCount?: number }> {
  return dbWrite.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(userAudioLibrary)
      .where(and(
        eq(userAudioLibrary.id, libraryId),
        eq(userAudioLibrary.userId, userId),
      ))
      .limit(1)
      .for("update");

    if (!row) return { ok: false, reason: 'not_found' };

    // Check if any book_place_bgm references this library item's fileId.
    // Must use tx (not dbRead) to avoid TOCTOU races within the transaction.
    const refCount = await getLibraryItemRefCount(row.fileId, tx);
    if (refCount > 0) return { ok: false, reason: 'in_use', refCount };

    // Delete from ImageKit (best-effort — outside tx is fine, soft delete)
    await deleteFileFromImageKit(row.fileId);

    // Delete from DB within the same transaction
    await tx
      .delete(userAudioLibrary)
      .where(and(
        eq(userAudioLibrary.id, libraryId),
        eq(userAudioLibrary.userId, userId),
      ));

    return { ok: true };
  });
}
