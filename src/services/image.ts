/**
 * Image Upload Services (ImageKit REST API v1)
 * @see https://imagekit.io/docs/api-overview
 * @see https://imagekit.io/docs/api-reference/upload-file/upload-file
 */

import { getTodayDate } from "../utils/time.js";
import { type DBClient, dbWrite } from "../db/client.js";
import { inArray, sql, and, eq, isNull } from "drizzle-orm";
import { getErrorMessage } from "../utils/error.js";
import { APP_NAME_SLUG } from "../config/constants.js";
import { deletedImages, uploadedImages } from "../db/schema.js";
import { dbRead } from "../db/client.js";
import type { ImageKitUploadResponse, ImageUploadObject, ImageUploadOptions, ImageUploadSource } from "../types/image.js";
import type { Book, UploadedImageType } from "../types/book.js";

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
  // Merge via the Headers constructor rather than Object.entries so this works
  // regardless of whether the caller passed a plain object, a Headers instance,
  // or an array of [key, value] tuples — all valid RequestInit['headers'] shapes,
  // but only the plain-object shape survives Object.entries().
  if (fetchOptions.headers) {
    new Headers(fetchOptions.headers).forEach((value, key) => {
      mergedHeaders.set(key, value);
    });
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
 * HTTP error carrying the real response status alongside the message.
 *
 * Retry logic needs to branch on the status code, and doing that by parsing
 * it back out of a formatted "failed (${status}): ${body}" string is fragile:
 * `body` is arbitrary server text, so e.g. a 400 response whose body happens
 * to mention "429" anywhere would be misread as rate-limited and retried. A
 * typed field is the sound way to carry structured data through a throw.
 */
class ImageKitHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ImageKitHttpError';
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

      throw new ImageKitHttpError(response.status, `ImageKit upload failed (${response.status}): ${body}`);
    } catch (error) {
      // Don't retry genuine 4xx client errors (429 is handled above and excluded here)
      if (error instanceof ImageKitHttpError && error.status >= 400 && error.status < 500 && error.status !== 429) {
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

  // Strip any parameters (e.g. "image/svg+xml;charset=utf-8" -> "image/svg+xml")
  // and normalize case before matching, so a differently-cased or
  // parameterized MIME type doesn't fall through to the default below.
  const cleaned = mimeType.split(';')[0].trim().toLowerCase();

  const parts = cleaned.split('/');
  if (parts.length !== 2 || !cleaned.startsWith('image/')) {
    console.warn('[validateMimeType] ⚠️ Not an image MIME type:', mimeType);
    return 'jpg';
  }

  // "svg+xml" is the real MIME subtype for SVG (RFC 2854) — map it to the
  // plain "svg" extension, which is what's actually in the whitelist below.
  // Without this, every SVG upload silently fell through to the 'jpg' default
  // despite 'svg' being an explicitly supported extension.
  const subtype = parts[1];
  const extension = subtype === 'svg+xml' ? 'svg' : subtype;

  const validExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg', 'heic', 'tiff'];

  if (!validExtensions.includes(extension)) {
    console.warn('[validateMimeType] ⚠️ Unsupported image extension:', extension);
    return 'jpg';
  }

  return extension;
}

/**
 * Generate sanitized filename for images
 */
function generateImageFilename(entityId: string, prefix: string, extension: string = 'jpg'): string {
  const sanitize = (value: string) => value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // Both pieces end up in a filename sent to the ImageKit API, so both get the
  // same sanitization — previously only the prefix was cleaned. This is a
  // no-op for well-formed UUID/CUID entityIds, but closes the gap otherwise.
  return `${sanitize(prefix)}-${sanitize(entityId)}.${extension}`;
}

/**
 * Detects an image's real format from its binary signature ("magic bytes")
 * rather than trusting caller-supplied metadata. A Content-Type header or
 * filename extension is trivially spoofed by a client, and raw Buffer /
 * ArrayBuffer sources carry no metadata at all — this is the only reliable
 * way to know what was actually uploaded. Returns null when the format isn't
 * recognized so callers can fall back to a sane default.
 */
function detectImageMimeType(bytes: Uint8Array): string | null {
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  // GIF: "GIF8" (covers both GIF87a and GIF89a)
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif';
  }
  // WEBP: "RIFF" .... "WEBP"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  // BMP: "BM"
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return 'image/bmp';
  }
  // AVIF/HEIC: ISO-BMFF "ftyp" box at offset 4, brand at offset 8
  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (brand.startsWith('heic') || brand.startsWith('heix') || brand === 'mif1' || brand === 'msf1') return 'image/heic';
  }

  // SVG is plain-text XML, not a binary format — check the head as text.
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, Math.min(bytes.length, 256)))
    .trimStart()
    .toLowerCase();
  if (head.startsWith('<?xml') || head.startsWith('<svg')) {
    return 'image/svg+xml';
  }

  return null;
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
    const matches = trimmed.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/i);
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
      // Raw TypedArray (including Node.js Buffer) — send as Blob.
      // No metadata accompanies this source type, so sniff the real format
      // from the bytes rather than assuming JPEG (which mislabeled every
      // non-JPEG raw upload, e.g. a PNG would be sent as declared JPEG).
      const bytes = new Uint8Array(imageSource.buffer, imageSource.byteOffset, imageSource.byteLength);
      const mimeType = detectImageMimeType(bytes) ?? 'image/jpeg';
      const extension = validateMimeType(mimeType);
      const fileName = generateImageFilename(entityId, prefix, extension);
      formData.append('file', new Blob([imageSource as BlobPart], { type: mimeType }), fileName);
      formData.append('fileName', fileName);
    } else if (imageSource instanceof ArrayBuffer) {
      // Raw ArrayBuffer — send as Blob. Same reasoning as the TypedArray branch.
      const bytes = new Uint8Array(imageSource);
      const mimeType = detectImageMimeType(bytes) ?? 'image/jpeg';
      const extension = validateMimeType(mimeType);
      const fileName = generateImageFilename(entityId, prefix, extension);
      formData.append('file', new Blob([imageSource], { type: mimeType }), fileName);
      formData.append('fileName', fileName);
    } else if (imageSource && 'buffer' in imageSource) {
      // File object from multipart (ImageUploadObject) — extract buffer and metadata.
      // uploadObj.mimetype and uploadObj.originalname are client-supplied and
      // trivially spoofable (a client can set any Content-Type/filename it
      // likes on a multipart part). Previously the raw filename extension was
      // used verbatim with no validation at all — unlike every other source
      // type in this function, it bypassed validateMimeType's whitelist
      // entirely. Now: sniff the real format from the bytes as ground truth,
      // fall back to the declared mimetype only if sniffing is inconclusive,
      // and always resolve the extension through validateMimeType.
      const uploadObj = imageSource as ImageUploadObject;
      const bufferBytes = uploadObj.buffer instanceof Uint8Array
        ? uploadObj.buffer
        : new Uint8Array(uploadObj.buffer as ArrayBufferLike);
      const mimeType = detectImageMimeType(bufferBytes) ?? (uploadObj.mimetype || 'application/octet-stream');
      const extension = validateMimeType(mimeType);
      const fileName = generateImageFilename(entityId, prefix, extension);
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
 * @returns true if the file is confirmed gone from ImageKit (deleted now or
 *   already absent), false if the delete failed. Callers use this to decide
 *   whether it's safe to drop their own DB bookkeeping for the file.
 */
export async function deleteFileFromImageKit(fileId: string): Promise<boolean> {
  try {
    const response = await imageKitFetch(`${IMAGEKIT_API_BASE}/files/${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
      timeoutMs: TIMEOUTS.DELETE,
    });

    // 404 means already deleted — treat as success for idempotency
    if (response.status === 404) {
      console.log(`[imagekit] 👻 Image ${fileId} already deleted (404)`);
      return true;
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`ImageKit delete failed (${response.status}): ${body}`);
    }

    console.log(`[imagekit] 🗑️ Image ${fileId} deleted successfully.`);
    return true;
  } catch (error) {
    // queueImageForDeletion reports whether the retry-queue insert itself
    // succeeded — it's a separate DB write that can independently fail, and
    // that failure matters: it's the difference between "will be retried
    // later" and "silently lost".
    const queued = await queueImageForDeletion(fileId);
    if (queued) {
      console.log(`[imagekit] 🔄 File ${fileId} queued for retry:`, getErrorMessage(error));
    } else {
      console.error(`[imagekit] ❌ Failed to queue image ${fileId} for deletion after delete failure:`, getErrorMessage(error));
    }
    return false;
  }
}

/**
 * Sequentially deletes each file individually, tracking which succeeded.
 * Kept sequential (not concurrent) so a failed or partial batch doesn't turn
 * into a burst of simultaneous requests against ImageKit.
 */
async function deleteEachIndividually(fileIds: string[]): Promise<{ succeeded: string[]; failed: string[] }> {
  const succeeded: string[] = [];
  const failed: string[] = [];
  for (const fileId of fileIds) {
    const ok = await deleteFileFromImageKit(fileId);
    (ok ? succeeded : failed).push(fileId);
  }
  return { succeeded, failed };
}

/**
 * Bulk deletes multiple files from ImageKit with individual fallback
 *
 * Attempts bulk deletion first. A 200 response from the batch endpoint does
 * NOT guarantee every requested file was deleted — successfullyDeletedFileIds
 * can be a strict subset (e.g. an ID no longer exists, or fails individually
 * for some other reason) — so anything missing from that list is retried
 * individually rather than being treated as done. If the bulk call fails
 * outright, every file falls back to individual deletes. Individual failures
 * are queued for retry by the cleanup cron job (see deleteFileFromImageKit).
 *
 * @param fileIds - Array of ImageKit file IDs to delete
 * @returns Which file IDs were confirmed deleted vs. which ultimately failed —
 *   callers should only clear their own DB records for the `succeeded` ones.
 */
export async function deleteFilesFromImageKit(
  fileIds: string[]
): Promise<{ succeeded: string[]; failed: string[] }> {
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

    const succeededSet = new Set(data.successfullyDeletedFileIds);
    const missing = fileIds.filter(id => !succeededSet.has(id));

    if (missing.length === 0) {
      return { succeeded: [...succeededSet], failed: [] };
    }

    console.warn(`[imagekit] ⚠️ ${missing.length} file(s) missing from bulk delete result, retrying individually:`, missing);
    const retried = await deleteEachIndividually(missing);
    return {
      succeeded: [...succeededSet, ...retried.succeeded],
      failed: retried.failed,
    };
  } catch (error) {
    console.warn("[imagekit] ⚠️ Bulk delete failed, falling back to individual deletes:", getErrorMessage(error));
    return deleteEachIndividually(fileIds);
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
 * @returns true if the row was inserted, false if the insert itself failed.
 *   Callers that only have this queue insert as their record of "this file
 *   still needs to be deleted" need to know when it didn't happen.
 */
export async function queueImageForDeletion(imageId: string): Promise<boolean> {
  try {
    await dbWrite
      .insert(deletedImages)
      .values({
        fileId: imageId,
        createdAt: new Date(),
      });
    console.log(`[queueImageForDeletion] 🗑️ Queued image ${imageId} for deletion`);
    return true;
  } catch (error) {
    console.error('[queueImageForDeletion] ❌ Error queuing image for deletion:', {fileId: imageId, error: getErrorMessage(error)});
    return false;
  }
}

/**
 * Process queued ImageKit file deletions from deleted_images table
 *
 * 1. Fetches pending file IDs from deleted_images table (oldest first)
 * 2. Attempts to delete each file from ImageKit via bulk API
 * 3. Removes rows from the queue for confirmed-successful deletions only —
 *    rows for failures are left in place so a later run retries them
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

    // deleteFilesFromImageKit handles bulk attempt + individual fallback + queue
    // for retries, and now reports exactly which IDs it actually confirmed
    // deleted vs. which failed.
    const { succeeded, failed } = await deleteFilesFromImageKit(fileIdsToDelete);

    if (succeeded.length > 0) {
      // Clean up uploaded_images DB rows for confirmed deletions only.
      await dbWrite
        .delete(uploadedImages)
        .where(inArray(uploadedImages.imageId, succeeded));

      // Remove confirmed items from the deletion queue.
      await dbWrite
        .delete(deletedImages)
        .where(inArray(deletedImages.fileId, succeeded));
    }

    stats.successful = succeeded.length;
    stats.failed = failed.length;
    if (failed.length > 0) {
      // Rows for these are intentionally left in deleted_images so the next
      // run retries them — deleteFileFromImageKit has already re-queued them
      // internally too, so a failed ID may end up with a duplicate queue row;
      // that's harmless and self-resolves the next time it succeeds, since
      // the cleanup above matches and removes every row for that fileId.
      stats.errors.push(`${failed.length} image(s) failed to delete and remain queued for retry: ${failed.join(', ')}`);
    }

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

      // Only clear DB rows for images confirmed deleted from ImageKit — any
      // that failed stay in uploaded_images and will show up as duplicates
      // for this user again on the next run.
      const { succeeded } = await deleteFilesFromImageKit(staleIds);
      if (succeeded.length === 0) continue;

      const del = await dbWrite
        .delete(uploadedImages)
        .where(and(
          eq(uploadedImages.userId, dupUserId),
          eq(uploadedImages.type, 'user'),
          inArray(uploadedImages.imageId, succeeded),
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

    const queuedIds: string[] = [];
    for (const id of orphanIds) {
      const queued = await queueImageForDeletion(id);
      if (queued) {
        stats.queued++;
        queuedIds.push(id);
      } else {
        stats.errors.push(`Failed to queue image ${id} for deletion`);
      }
    }

    // Only drop the uploaded_images tracking row for IDs we actually managed
    // to queue for ImageKit deletion — otherwise a queue-insert failure would
    // remove the only remaining record of that file, orphaning it forever.
    if (queuedIds.length > 0) {
      try {
        const del = await dbWrite
          .delete(uploadedImages)
          .where(inArray(uploadedImages.imageId, queuedIds))
          .returning({ imageId: uploadedImages.imageId });
        stats.removed = del.length;
      } catch (err) {
        stats.errors.push(getErrorMessage(err));
        console.warn('[imagekit] ⚠️ Failed to remove orphan uploaded_images rows:', getErrorMessage(err));
      }
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

// ---------------------------------------------------------------------------
// Upload tracking
// ---------------------------------------------------------------------------

/**
 * Persists an upload record to the uploaded_images table
 *
 * Inserts a row tracking an image upload. Use inside a transaction by
 * passing a `client` to participate in an existing transaction context.
 *
 * @param params - Upload tracking parameters
 * @param params.imageId - ImageKit file ID
 * @param params.imageUrl - ImageKit URL
 * @param params.type - Image type (cover, mc, user, feedback)
 * @param params.userId - User who uploaded the image
 * @param params.client - Optional DB client for transaction participation
 * @throws Rethrows DB errors for the caller to handle (e.g. transaction rollback)
 */
export async function persistUploadedImage(params: {
  imageId: string;
  imageUrl: string;
  type: UploadedImageType;
  userId: string;
  client?: DBClient;
}): Promise<void> {
  const db = params.client ?? dbWrite;
  try {
    await db.insert(uploadedImages).values({
      imageId: params.imageId,
      imageUrl: params.imageUrl,
      type: params.type,
      userId: params.userId,
    });
  } catch (error) {
    console.error(`[persistUploadedImage] ❌ Failed to persist uploaded image ${params.imageId}:`, getErrorMessage(error));
    throw error;
  }
}
