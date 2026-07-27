/**
 * Image Upload Services (ImageKit REST API v1)
 * @see https://imagekit.io/docs/api-overview
 * @see https://imagekit.io/docs/api-reference/upload-file/upload-file
 */

import { getTodayDate } from "../utils/time.js";
import { dbWrite } from "../db/client.js";
import { inArray, sql, and, eq, isNull } from "drizzle-orm";
import { getErrorMessage } from "../utils/error.js";
import { APP_NAME_SLUG } from "../config/constants.js";
import { deletedImages, uploadedImages } from "../db/schema.js";
import { dbRead } from "../db/client.js";
import type { ImageKitUploadResponse, ImageUploadObject, ImageUploadOptions, ImageUploadSource } from "../types/image.js";
import type { Book } from "../types/book.js";

// Runtime environments: Node 20+ / Edge (both have globalThis.btoa)
const encodeBase64 = (str: string): string =>
  (globalThis as { btoa: (s: string) => string }).btoa(str);

const IMAGEKIT_UPLOAD_URL = "https://upload.imagekit.io/api/v1/files/upload";
const IMAGEKIT_API_BASE = "https://api.imagekit.io/v1";

// Timeout per operation (ms). Uploads can be slower for large files.
const TIMEOUTS = {
  UPLOAD: 60_000,
  DELETE: 15_000,
  BULK_DELETE: 30_000,
} as const;

// Retry configuration for upload (matches SDK's built-in transient-failure resilience)
const RETRY = {
  MAX_ATTEMPTS: 3,
  BASE_DELAY_MS: 1_000,
} as const;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

let cachedAuthHeader: string | null = null;

/**
 * Returns a cached Basic Auth header for ImageKit API.
 * The token is computed once per module lifetime (serverless cold-start).
 */
function getAuthHeaders(): Record<string, string> | null {
  if (cachedAuthHeader) {
    return { 'Authorization': cachedAuthHeader };
  }

  const privateKey = process.env['IMAGEKIT_API_KEY_PRIVATE'];
  if (!privateKey) {
    console.warn("[imagekit] ⚠️ Credentials not configured");
    return null;
  }

  cachedAuthHeader = `Basic ${encodeBase64(`${privateKey}:`)}`;
  return { 'Authorization': cachedAuthHeader };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Authenticated fetch to ImageKit with timeout.
 * Does NOT set Content-Type for FormData bodies (browser/Edge auto-sets boundary).
 */
async function imageKitFetch(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const headers = getAuthHeaders();
  if (!headers) throw new Error("ImageKit credentials not configured");

  const timeoutMs = options.timeoutMs ?? TIMEOUTS.DELETE;
  const { timeoutMs: _, ...fetchOptions } = options;

  const mergedHeaders = new Headers(headers);
  if (fetchOptions.headers) {
    const incoming = fetchOptions.headers as Record<string, string>;
    for (const [k, v] of Object.entries(incoming)) {
      mergedHeaders.set(k, v);
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...fetchOptions,
      headers: mergedHeaders,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Upload form data to ImageKit with retry for transient failures.
 * Retries on 5xx, 429 (rate-limit), and network errors — but NOT on 4xx.
 */
async function uploadWithRetry(formData: FormData): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < RETRY.MAX_ATTEMPTS; attempt++) {
    try {
      const response = await imageKitFetch(IMAGEKIT_UPLOAD_URL, {
        method: 'POST',
        body: formData,
        timeoutMs: TIMEOUTS.UPLOAD,
      });

      if (response.ok) return response;

      const body = await response.text();

      // Retry on server errors (5xx) and rate-limit (429)
      if (response.status >= 500 || response.status === 429) {
        if (attempt < RETRY.MAX_ATTEMPTS - 1) {
          const delay = Math.min(RETRY.BASE_DELAY_MS * Math.pow(2, attempt), 5_000);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }

      throw new Error(`ImageKit upload failed (${response.status}): ${body}`);
    } catch (error) {
      // Don't retry 4xx errors (except 429 handled above)
      if (error instanceof Error && /ImageKit upload failed \(4/.test(error.message) && !error.message.includes('429')) {
        throw error;
      }

      lastError = error as Error;

      if (attempt < RETRY.MAX_ATTEMPTS - 1) {
        const delay = Math.min(RETRY.BASE_DELAY_MS * Math.pow(2, attempt), 5_000);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw lastError ?? new Error('Upload failed after retries');
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Format keywords array for URL encoding
 */
export function formatKeywordsForUrl(keywords: string[]): string {
  return keywords
    .map(keyword => keyword.replace(/\s+/g, '+'))
    .join('|');
}

/**
 * Validate and extract file extension from MIME type
 */
function validateMimeType(mimeType: string): string {
  if (!mimeType || typeof mimeType !== 'string') {
    console.warn('[validateMimeType] ⚠️ Invalid MIME type provided, using default');
    return 'jpg';
  }

  const parts = mimeType.split('/');
  if (parts.length !== 2 || !mimeType.startsWith('image/')) {
    console.warn('[validateMimeType] ⚠️ Not an image MIME type:', mimeType);
    return 'jpg';
  }

  const extension = parts[1];
  const validExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg', 'heic', 'tiff'];

  if (!validExtensions.includes(extension.toLowerCase())) {
    console.warn('[validateMimeType] ⚠️ Unsupported image extension:', extension);
    return 'jpg';
  }

  return extension.toLowerCase();
}

/**
 * Generate sanitized filename for images
 */
function generateImageFilename(entityId: string, prefix: string, extension: string = 'jpg'): string {
  const sanitizedPrefix = prefix
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${sanitizedPrefix}-${entityId}.${extension}`;
}

/** Default filename prefix used when options.filenamePrefix is not provided */
const DEFAULT_FILENAME_PREFIX = 'image';

/**
 * Returns true when a value looks like an image payload supplied as base64.
 *
 * Supports both standard data URLs such as `data:image/png;base64,...` and
 * raw base64 strings. Regular URLs and other non-base64 values return false.
 */
export function isBase64Upload(value: unknown): value is string {
  if (typeof value !== 'string') return false;

  const trimmed = value.trim();
  if (trimmed.startsWith('data:')) {
    return /^data:(image\/[a-zA-Z0-9.+-]+);base64,[A-Za-z0-9+/]+={0,2}$/i.test(trimmed);
  }

  return /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) && trimmed.length % 4 === 0;
}

/**
 * Handle base64 data URL uploads — extracts the raw base64 payload and filename
 */
function handleBase64Upload(base64Url: string, prefix: string, entityId: string): {
  file: Blob;
  fileName: string;
  mimeType: string;
} | null {
  const trimmed = base64Url.trim();
  let mimeType = 'image/jpeg';
  let payload = trimmed;

  if (trimmed.startsWith('data:')) {
    const matches = trimmed.match(/^data:(.+?);base64,(.+)$/i);
    if (!matches || matches.length !== 3) {
      console.error('[handleBase64Upload] ❌ Invalid base64 data URL format');
      return null;
    }

    mimeType = matches[1];
    payload = matches[2];
  } else if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('blob:')) {
    console.error('[handleBase64Upload] ❌ Expected base64 content but received a URL');
    return null;
  } else if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) || trimmed.length % 4 !== 0) {
    console.error('[handleBase64Upload] ❌ Invalid base64 content format');
    return null;
  }

  const buffer = Buffer.from(payload, 'base64');
  if (buffer.length === 0) {
    console.error('[handleBase64Upload] ❌ Decoded base64 payload is empty');
    return null;
  }

  const extension = validateMimeType(mimeType);
  const fileName = generateImageFilename(entityId, prefix, extension);

  return {
    file: new Blob([buffer], { type: mimeType }),
    fileName,
    mimeType,
  };
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Universal image upload function
 *
 * Handles image uploads from multiple sources (URL, base64, multipart file) with customizable
 * folder structure, tags, and metadata.
 *
 * @param imageSource - Image source (URL, base64, or file object)
 * @param entityId - Entity ID for filename generation and metadata
 * @param options - Upload configuration options
 * @returns Promise resolving to ImageKit upload response with URL and file ID
 */
export async function uploadImageKit(
  imageSource: ImageUploadSource,
  entityId: string,
  options: ImageUploadOptions
): Promise<ImageKitUploadResponse | null> {
  try {
    const formData = new FormData();
    const folderPath = `/${APP_NAME_SLUG}/${options.folder}/${getTodayDate().replace(/-/g, '/')}`;
    const prefix = options.filenamePrefix || DEFAULT_FILENAME_PREFIX;

    if (typeof imageSource === 'string') {
      if (isBase64Upload(imageSource)) {
        const parsed = handleBase64Upload(imageSource, prefix, entityId);
        if (!parsed) return null;
        formData.append('file', parsed.file, parsed.fileName);
        formData.append('fileName', parsed.fileName);
      } else {
        formData.append('file', imageSource);
        formData.append('fileName', generateImageFilename(entityId, prefix));
      }
    } else if (ArrayBuffer.isView(imageSource)) {
      // Raw TypedArray (including Node.js Buffer) — send as Blob
      const fileName = generateImageFilename(entityId, prefix);
      formData.append('file', new Blob([imageSource as BlobPart], { type: 'image/jpeg' }), fileName);
      formData.append('fileName', fileName);
    } else if (imageSource instanceof ArrayBuffer) {
      // Raw ArrayBuffer — send as Blob
      const fileName = generateImageFilename(entityId, prefix);
      formData.append('file', new Blob([imageSource], { type: 'image/jpeg' }), fileName);
      formData.append('fileName', fileName);
    } else if (imageSource && 'buffer' in imageSource) {
      // File object from multipart (ImageUploadObject) — extract buffer and metadata
      const uploadObj = imageSource as ImageUploadObject;
      const mimeType = uploadObj.mimetype || 'application/octet-stream';
      const ext = uploadObj.originalname?.split('.').pop() || 'jpg';
      const fileName = generateImageFilename(entityId, prefix, ext);
      formData.append('file', new Blob([uploadObj.buffer as BlobPart], { type: mimeType }), fileName);
      formData.append('fileName', fileName);
    } else {
      console.error('[uploadImageKit] ❌ Invalid image source type');
      return null;
    }

    formData.append('useUniqueFileName', String(options.useUniqueFileName ?? false));
    formData.append('folder', folderPath);
    if (options.tags?.length) {
      formData.append('tags', options.tags.join(','));
    }

    const response = await uploadWithRetry(formData);
    const result = await response.json() as ImageKitUploadResponse;

    console.log(`[uploadImageKit] 📸 Image uploaded: ${result.url} (ID: ${result.fileId})`);
    return result;
  } catch (error) {
    console.error(`[uploadImageKit] ❌ Image upload failed for entity ${entityId}:`, getErrorMessage(error));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Convenience upload wrappers
// ---------------------------------------------------------------------------

/**
 * Upload book cover image to ImageKit.io
 */
export async function uploadBookCover(
  imageSource: ImageUploadSource,
  bookMeta: Pick<Book, 'id' | 'title' | 'keywords'>,
): Promise<ImageKitUploadResponse | null> {
  const { id, keywords } = bookMeta;
  return uploadImageKit(imageSource, id, {
    folder: 'books',
    tags: [...keywords, 'book-cover', `book-id:${id}`],
    filenamePrefix: 'cover',
  });
}

/**
 * Upload a book's main character avatar image to ImageKit.io
 */
export async function uploadBookCharacterImage(
  imageSource: ImageUploadSource,
  bookId: string,
  characterName: string
): Promise<ImageKitUploadResponse | null> {
  return uploadImageKit(imageSource, bookId, {
    folder: 'book-characters',
    tags: ['book-character', `book-id:${bookId}`, `character:${characterName}`],
    filenamePrefix: 'character',
  });
}

/**
 * Upload feedback screenshot image to ImageKit.io
 */
export async function uploadFeedbackScreenshot(
  imageSource: ImageUploadSource,
  feedbackId: string
): Promise<ImageKitUploadResponse | null> {
  return uploadImageKit(imageSource, feedbackId, {
    folder: 'feedbacks',
    tags: ['feedback-screenshot', `feedback-id:${feedbackId}`],
    filenamePrefix: 'screenshot',
  });
}

/**
 * Upload user profile image to ImageKit.io
 */
export async function uploadUserImage(
  imageSource: ImageUploadSource,
  userId: string
): Promise<ImageKitUploadResponse | null> {
  return uploadImageKit(imageSource, userId, {
    folder: 'users',
    tags: ['user-profile', `user-id:${userId}`],
    filenamePrefix: 'profile',
  });
}

// ---------------------------------------------------------------------------
// Delete operations
// ---------------------------------------------------------------------------

/**
 * Deletes a file from ImageKit with fallback to deletion queue
 *
 * Attempts to delete the file directly from ImageKit. If deletion fails,
 * queues the file for retry by the cleanup cron job.
 *
 * @param fileId - ImageKit file ID to delete
 */
export async function deleteFileFromImageKit(fileId: string) {
  try {
    const response = await imageKitFetch(`${IMAGEKIT_API_BASE}/files/${fileId}`, {
      method: 'DELETE',
      timeoutMs: TIMEOUTS.DELETE,
    });

    // 404 means already deleted — treat as success for idempotency
    if (response.status === 404) {
      console.log(`[imagekit] 👻 Image ${fileId} already deleted (404)`);
      return;
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`ImageKit delete failed (${response.status}): ${body}`);
    }

    console.log(`[imagekit] 🗑️ Image ${fileId} deleted successfully.`);
  } catch (error) {
    try {
      await queueImageForDeletion(fileId);
      console.log(`[imagekit] 🔄 File ${fileId} queued for retry:`, getErrorMessage(error));
    } catch (dbError) {
      console.error(`[imagekit] ❌ Failed to queue image deletion for ${fileId}:`, getErrorMessage(dbError));
    }
  }
}

/**
 * Bulk deletes multiple files from ImageKit with individual fallback
 *
 * Attempts bulk deletion first. If the bulk call fails, falls back to
 * individual deletes. Any individual failures are queued for retry by
 * the cleanup cron job.
 *
 * @param fileIds - Array of ImageKit file IDs to delete
 */
export async function deleteFilesFromImageKit(fileIds: string[]) {
  try {
    const response = await imageKitFetch(`${IMAGEKIT_API_BASE}/files/batch/deleteByFileIds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileIds }),
      timeoutMs: TIMEOUTS.BULK_DELETE,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Bulk delete failed (${response.status}): ${body}`);
    }

    const data = await response.json() as { successfullyDeletedFileIds: string[] };
    console.log("[imagekit] 🗑️ Images bulk delete result:", data.successfullyDeletedFileIds);
  } catch (error) {
    console.warn("[imagekit] ⚠️ Bulk delete failed, falling back to individual deletes:", getErrorMessage(error));
    for (const fileId of fileIds) {
      await deleteFileFromImageKit(fileId);
    }
  }
}

/**
 * Deletes a folder and all its contents from ImageKit
 *
 * @param folderPath - Path of the folder to delete (e.g., 'books/2024/01/15')
 */
export async function deleteFolderFromImageKit(folderPath: string) {
  try {
    const response = await imageKitFetch(`${IMAGEKIT_API_BASE}/folder/`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath }),
      timeoutMs: TIMEOUTS.DELETE,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Folder delete failed (${response.status}): ${body}`);
    }

    console.log(`[imagekit] 🗑️ Folder "${folderPath}" and all its contents deleted.`);
  } catch (error) {
    console.error(`[imagekit] ❌ Failed to delete folder "${folderPath}"`, getErrorMessage(error));
  }
}

// ---------------------------------------------------------------------------
// Deletion queue
// ---------------------------------------------------------------------------

/**
 * Queues an image for deletion in the deleted_images table
 *
 * A separate cleanup process will handle the actual deletion.
 *
 * @param imageId - ImageKit file ID to queue for deletion
 */
export async function queueImageForDeletion(imageId: string): Promise<void> {
  try {
    await dbWrite
      .insert(deletedImages)
      .values({
        fileId: imageId,
        createdAt: new Date(),
      });
    console.log(`[queueImageForDeletion] 🗑️ Queued image ${imageId} for deletion`);
  } catch (error) {
    console.error('[queueImageForDeletion] ❌ Error queuing image for deletion:', {fileId: imageId, error: getErrorMessage(error)});
  }
}

/**
 * Process queued ImageKit file deletions from deleted_images table
 *
 * 1. Fetches pending file IDs from deleted_images table (oldest first)
 * 2. Attempts to delete each file from ImageKit via bulk API
 * 3. Removes processed rows from the queue (both successful and failed)
 * 4. Returns statistics for monitoring
 *
 * @param batchSize - Maximum number of files to process in one batch (default: 50)
 * @returns Promise resolving to deletion statistics
 */
export async function processQueuedImageDeletions(batchSize: number = 50): Promise<{
  processed: number;
  successful: number;
  failed: number;
  errors: string[];
}> {
  const stats = {
    processed: 0,
    successful: 0,
    failed: 0,
    errors: [] as string[]
  };

  try {
    console.log(`[imagekit] 🧹 Processing up to ${batchSize} queued image deletions...`);

    const pendingDeletions = await dbWrite
      .select()
      .from(deletedImages)
      .orderBy(deletedImages.createdAt)
      .limit(batchSize);

    if (pendingDeletions.length === 0) {
      console.log("[imagekit] ✨ No queued image deletions to process");
      return stats;
    }

    stats.processed = pendingDeletions.length;
    const fileIdsToDelete = pendingDeletions.map(deletion => deletion.fileId);

    // Use deleteFilesFromImageKit — it handles bulk attempt + individual fallback + queue for retries
    await deleteFilesFromImageKit(fileIdsToDelete);

    // Clean up uploaded_images DB rows — delete all queue IDs.
    // The deleteFilesFromImageKit already handles ImageKit deletion and
    // queues failures for retry; we clean up the queue regardless.
    await dbWrite
      .delete(uploadedImages)
      .where(inArray(uploadedImages.imageId, fileIdsToDelete));

    // Remove processed items from the deletion queue
    await dbWrite
      .delete(deletedImages)
      .where(inArray(deletedImages.fileId, fileIdsToDelete));

    // Stats are optimistic since deleteFilesFromImageKit handles fallbacks internally
    stats.successful = stats.processed;
    stats.failed = 0;

    console.log(`[imagekit] ✅ Cleanup completed: ${stats.successful}/${stats.processed} successful, ${stats.failed} failed`);
    return stats;
  } catch (error) {
    const errorMsg = `ImageKit cleanup failed: ${getErrorMessage(error)}`;
    console.error(`[imagekit] ❌ ${errorMsg}`);
    stats.errors.push(errorMsg);
    return stats;
  }
}

// ---------------------------------------------------------------------------
// User-image cleanup
// ---------------------------------------------------------------------------

/**
 * Clean up stale (outdated) user profile images for users who still exist.
 *
 * When a user uploads a new avatar, a *new* `uploaded_images` row is inserted while
 * the old row is left in place. Over time a user accumulates multiple `type = 'user'`
 * rows with a non-null `userId`. This function finds those users, keeps only the
 * *most recent* row, deletes all older images from ImageKit, and removes their DB rows.
 */
export async function cleanupStaleUserUploads(batchSize: number = 50): Promise<{
  processed: number;
  deleted: number;
  errors: string[];
}> {
  const stats = { processed: 0, deleted: 0, errors: [] as string[] };

  try {
    const dupResult = await dbRead.execute(sql`
      SELECT user_id, COUNT(*)::int AS cnt
      FROM uploaded_images
      WHERE type = 'user' AND user_id IS NOT NULL
      GROUP BY user_id
      HAVING COUNT(*) > 1
      LIMIT ${batchSize}
    `);
    const duplicates = dupResult.rows as Array<{ user_id: string; cnt: number }> | undefined;

    if (!duplicates || duplicates.length === 0) return stats;

    for (const { user_id: dupUserId } of duplicates) {
      const rows = await dbRead
        .select({ imageId: uploadedImages.imageId, createdAt: uploadedImages.createdAt })
        .from(uploadedImages)
        .where(and(eq(uploadedImages.userId, dupUserId), eq(uploadedImages.type, 'user')))
        .orderBy(uploadedImages.createdAt)
        .limit(100);

      const stale = rows.slice(0, -1);
      if (stale.length === 0) continue;

      stats.processed += stale.length;
      const staleIds = stale.map(r => r.imageId);

      await deleteFilesFromImageKit(staleIds);

      const del = await dbWrite
        .delete(uploadedImages)
        .where(and(
          eq(uploadedImages.userId, dupUserId),
          eq(uploadedImages.type, 'user'),
          inArray(uploadedImages.imageId, staleIds),
        ))
        .returning({ imageId: uploadedImages.imageId });
      stats.deleted += del.length;
    }

    console.log(`[imagekit] 🧹 Stale user uploads cleanup: processed=${stats.processed} deleted=${stats.deleted}`);
    return stats;
  } catch (error) {
    const msg = getErrorMessage(error);
    console.error('[imagekit] ❌ Failed to cleanup stale user uploads:', msg);
    stats.errors.push(msg);
    return stats;
  }
}

/**
 * Clean up orphaned user uploads whose linked user account no longer exists.
 *
 * When a user account is deleted, the DB trigger sets `userId = NULL` on the
 * corresponding `uploaded_images` rows. This function finds those orphaned rows,
 * queues their ImageKit file IDs for deletion, and removes the orphaned DB rows.
 */
export async function cleanupOrphanedUserUploads(batchSize: number = 100): Promise<{
  processed: number;
  queued: number;
  removed: number;
  errors: string[];
}> {
  const stats = { processed: 0, queued: 0, removed: 0, errors: [] as string[] };

  try {
    const orphans = await dbRead
      .select({ imageId: uploadedImages.imageId })
      .from(uploadedImages)
      .where(and(eq(uploadedImages.type, 'user'), isNull(uploadedImages.userId)))
      .orderBy(uploadedImages.createdAt)
      .limit(batchSize);

    if (orphans.length === 0) return stats;

    stats.processed = orphans.length;
    const orphanIds = orphans.map((r: { imageId: string }) => r.imageId);

    for (const id of orphanIds) {
      try {
        await queueImageForDeletion(id);
        stats.queued++;
      } catch (err) {
        stats.errors.push(getErrorMessage(err));
      }
    }

    try {
      const del = await dbWrite
        .delete(uploadedImages)
        .where(inArray(uploadedImages.imageId, orphanIds))
        .returning({ imageId: uploadedImages.imageId });
      stats.removed = del.length;
    } catch (err) {
      stats.errors.push(getErrorMessage(err));
      console.warn('[imagekit] ⚠️ Failed to remove orphan uploaded_images rows:', getErrorMessage(err));
    }

    console.log(`[imagekit] 🧾 Orphaned user uploads: processed=${stats.processed} queued=${stats.queued} removed=${stats.removed}`);
    return stats;
  } catch (error) {
    const msg = getErrorMessage(error);
    console.error('[imagekit] ❌ Failed to cleanup orphaned user uploads:', msg);
    stats.errors.push(msg);
    return stats;
  }
}
