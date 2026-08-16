/**
 * @fileoverview Image Upload Services (ImageKit REST API v1)
 *
 * Server-side integration with ImageKit for every image upload/delete in the
 * app (book covers, character portraits, feedback screenshots, user
 * avatars). This module owns all direct communication with ImageKit's REST
 * API — auth, retries, request formatting — so the rest of the codebase
 * only ever calls the exported `upload*` / `delete*` / `cleanup*` functions
 * below.
 *
 * Key design decisions, for context on choices that aren't obvious from a
 * single function in isolation:
 *
 * - **Auth header caching**: the Basic Auth header is computed once and
 *   cached at module scope (`cachedAuthHeader`) rather than on every
 *   request, since it's derived from an env var that's fixed for the life
 *   of the process — this matters on serverless, where a module can be
 *   re-invoked many times per cold start.
 *
 * - **Four upload source shapes, one entry point**: `uploadImageKit`
 *   accepts a URL string, a base64 string, a raw Buffer/TypedArray/
 *   ArrayBuffer, or a multipart file object, and normalizes whichever it
 *   gets into FormData. See the branches inside it for how each is handled.
 *
 * - **Sniffed content over declared content**: wherever a caller-supplied
 *   MIME type could be wrong or spoofed (a multipart part's Content-Type, a
 *   data: URL's declared type) or is simply absent (raw buffers carry no
 *   metadata at all), the actual bytes are sniffed via `detectImageMimeType`
 *   and trusted over the declared value, falling back to the declared value
 *   only when sniffing is inconclusive.
 *
 * - **Deletion is a two-tier system**: `deleteFileFromImageKit` /
 *   `deleteFilesFromImageKit` attempt a live delete against ImageKit and
 *   report exactly which file IDs were actually confirmed deleted vs. which
 *   failed. Failures get a row in the `deleted_images` table (via
 *   `queueImageForDeletion`) for `processQueuedImageDeletions` to retry
 *   later on a cron. Every caller in this file follows the same rule:
 *   **only clear your own DB bookkeeping for IDs confirmed deleted** —
 *   clearing it for an unconfirmed ID permanently orphans that file on
 *   ImageKit, since nothing would be left to ever retry it.
 *
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

/**
 * Base64-encodes an ASCII string (e.g. `"apiKey:"`) for a Basic Auth header.
 * Uses the platform `btoa`, available as a global in both Node 20+ and Edge
 * runtimes, so no extra base64 dependency is needed. Only safe for
 * ASCII/Latin1 input — fine here since ImageKit's private key is always
 * ASCII, but not a general-purpose base64 encoder for arbitrary text.
 */
const encodeBase64 = (str: string): string =>
  (globalThis as { btoa: (s: string) => string }).btoa(str);

// Upload has its own subdomain; every other endpoint (delete, folder ops)
// lives under the main API host.
const IMAGEKIT_UPLOAD_URL = "https://upload.imagekit.io/api/v1/files/upload";
const IMAGEKIT_API_BASE = "https://api.imagekit.io/v1";

// Timeout per operation (ms), enforced via AbortController in imageKitFetch.
// UPLOAD gets the longest budget since multi-MB image bodies over a slow
// connection take longer than a metadata-only call; BULK_DELETE is longer
// than a single DELETE since ImageKit processes many file IDs server-side
// before responding.
const TIMEOUTS = {
  UPLOAD: 60_000,
  DELETE: 15_000,
  BULK_DELETE: 30_000,
} as const;

// Retry configuration for upload (matches SDK's built-in transient-failure resilience)
const RETRY = {
  MAX_ATTEMPTS: 3,
  BASE_DELAY_MS: 1_000,
  // Ceiling on the exponential backoff delay (see computeRetryDelayMs).
  // Without a cap, later attempts grow unbounded (2s, 4s, 8s, ...) — this
  // keeps worst-case retry latency predictable even if MAX_ATTEMPTS is
  // raised later.
  MAX_DELAY_MS: 5_000,
} as const;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

let cachedAuthHeader: string | null = null;

/**
 * Returns the Basic Auth header for the ImageKit API, computing and caching
 * it on first call. The token is derived from `IMAGEKIT_API_KEY_PRIVATE` and
 * cached at module scope for the process lifetime — see the file overview
 * for why (serverless cold-start reuse).
 *
 * @returns A `{ Authorization: ... }` header object, or `null` if the
 *   private key env var isn't set. Callers (imageKitFetch) treat `null` as
 *   a hard failure rather than sending an unauthenticated request.
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
 * Authenticated fetch to ImageKit with a per-call timeout.
 *
 * Adds the Basic Auth header automatically and enforces `timeoutMs` (default
 * `TIMEOUTS.DELETE`) via AbortController, so no caller needs to wire up its
 * own abort/timeout handling. Any caller-supplied `headers` are merged on
 * top of the auth header via the `Headers` constructor rather than
 * `Object.entries`, so it works whether `headers` is a plain object, a
 * `Headers` instance, or an array of `[key, value]` tuples — all valid
 * `RequestInit['headers']` shapes.
 *
 * Deliberately does NOT set Content-Type for FormData bodies — the
 * browser/Edge runtime sets it automatically with the correct multipart
 * boundary, and setting it manually would break that.
 *
 * @param url - Full request URL.
 * @param options - Standard `RequestInit`, plus an optional `timeoutMs`.
 * @throws {Error} If ImageKit credentials aren't configured.
 * @returns The raw `Response` — callers are responsible for checking
 *   `response.ok` and reading the body themselves.
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
 * Exponential backoff delay for a given retry attempt (0-indexed), capped at
 * `RETRY.MAX_DELAY_MS`. Shared by both retry branches in `uploadWithRetry`
 * (the inline 5xx/429 retry and the catch-block retry) so the formula lives
 * in exactly one place.
 */
function computeRetryDelayMs(attempt: number): number {
  return Math.min(RETRY.BASE_DELAY_MS * Math.pow(2, attempt), RETRY.MAX_DELAY_MS);
}

/** Builds the `"{label} failed ({status}): {body}"` error used across every ImageKit call site. */
function buildHttpError(label: string, status: number, body: string): ImageKitHttpError {
  return new ImageKitHttpError(status, `${label} failed (${status}): ${body}`);
}

/**
 * Reads a non-ok response's body and throws `buildHttpError`'s result for
 * it. Centralizes the "read body, format, throw" sequence that would
 * otherwise be repeated at every ImageKit call site that isn't a retry loop
 * (uploadWithRetry reads the body itself, since it sometimes needs to
 * discard it and retry instead of throwing).
 *
 * @returns Never — always throws. Typed as `Promise<never>` so `await
 *   throwForFailedResponse(...)` reads clearly as "this branch always ends
 *   here."
 */
async function throwForFailedResponse(response: Response, label: string): Promise<never> {
  const body = await response.text();
  throw buildHttpError(label, response.status, body);
}

/**
 * Uploads `formData` to ImageKit, retrying transient failures with
 * exponential backoff.
 *
 * Retries on 5xx (server error) and 429 (rate-limited) responses, and on
 * network-level errors (timeout, DNS, connection reset) — anything that's
 * plausibly transient. Does NOT retry other 4xx responses: those mean the
 * request itself was invalid, and retrying an invalid request just wastes
 * `RETRY.MAX_ATTEMPTS` worth of time before failing anyway. The 4xx/5xx
 * distinction is made on `ImageKitHttpError.status` (see its JSDoc for why
 * that's a typed field rather than a string match).
 * 
 * @todo can it reuse `retryWithBackoff` from `src\utils\retry.ts`?
 *
 * @param formData - The multipart body to upload; reused as-is across
 *   retry attempts (safe — FormData holds direct Blob/string references,
 *   not a stream that gets consumed on first use).
 * @returns The successful `Response` (guaranteed `response.ok`).
 * @throws The last error encountered once `RETRY.MAX_ATTEMPTS` is exhausted,
 *   or immediately for a non-retryable 4xx.
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
          await new Promise(r => setTimeout(r, computeRetryDelayMs(attempt)));
          continue;
        }
      }

      throw buildHttpError('ImageKit upload', response.status, body);
    } catch (error) {
      // Don't retry genuine 4xx client errors (429 is handled above and excluded here)
      if (error instanceof ImageKitHttpError && error.status >= 400 && error.status < 500 && error.status !== 429) {
        throw error;
      }

      lastError = error as Error;

      if (attempt < RETRY.MAX_ATTEMPTS - 1) {
        await new Promise(r => setTimeout(r, computeRetryDelayMs(attempt)));
      }
    }
  }

  throw lastError ?? new Error('Upload failed after retries');
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Formats a list of keywords into a single URL-safe query segment: each
 * keyword's internal whitespace is collapsed to `+` (the standard
 * application/x-www-form-urlencoded space encoding), and keywords are
 * joined with `|`. E.g. `["dark fantasy", "mystery"]` → `"dark+fantasy|mystery"`.
 *
 * Not called elsewhere in this file — exported for callers that need to
 * build a keyword-based query parameter (e.g. an ImageKit search or
 * transformation query) from a keyword list such as `Book.keywords`.
 *
 * @param keywords - Keywords to format; each is expected to be plain,
 *   unescaped text (not pre-URL-encoded).
 */
export function formatKeywordsForUrl(keywords: string[]): string {
  return keywords
    .map(keyword => keyword.replace(/\s+/g, '+'))
    .join('|');
}

/**
 * Resolves a MIME type string down to a plain lowercase file extension,
 * gated by an explicit whitelist of extensions this app expects to send to
 * ImageKit. Anything that isn't a recognized `image/*` type — missing,
 * malformed, non-image, or simply unsupported — falls back to `'jpg'`
 * rather than propagating an arbitrary, unvalidated extension into a
 * filename sent to the ImageKit API.
 *
 * Strips `;charset=...`-style parameters and normalizes case before
 * matching (so e.g. `"image/svg+xml;charset=utf-8"` or `"Image/PNG"` both
 * resolve correctly instead of falling through to the default), and maps
 * SVG's real MIME subtype (`svg+xml`, per RFC 2854) to the plain `svg`
 * extension that's actually in the whitelist.
 *
 * @param mimeType - A MIME type string, e.g. `"image/png"`. May be missing
 *   or malformed — this function never throws.
 * @returns A lowercase extension from the whitelist, or `'jpg'` when the
 *   input can't be resolved to one.
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
 * Builds a `{prefix}-{entityId}.{extension}` filename for ImageKit, with
 * both `prefix` and `entityId` sanitized to a safe `[a-z0-9-]` charset.
 *
 * The name is deterministic — no random suffix. That's intentional: paired
 * with `useUniqueFileName: false` in `uploadImageKit` and the date-based
 * folder path, a same-day re-upload for the same entity overwrites the
 * previous file in place (ImageKit's documented behavior when
 * useUniqueFileName is false) instead of accumulating duplicates.
 * Cross-day re-uploads land in a new dated folder; the old file is picked up
 * later by the cleanup jobs near the bottom of this file (e.g.
 * `cleanupStaleUserUploads`).
 *
 * @param entityId - ID of the entity the image belongs to (book, user,
 *   feedback report, etc.) — typically a DB-generated UUID/CUID.
 * @param prefix - Short label for the image's role, e.g. `"cover"`, `"profile"`.
 * @param extension - File extension without the leading dot. Defaults to
 *   `'jpg'`; callers normally pass the result of `validateMimeType`.
 * @returns The sanitized filename, e.g. `"cover-3fa85f64-....jpg"`.
 */
function generateImageFilename(entityId: string, prefix: string, extension: string = 'jpg'): string {
  const sanitize = (value: string) => value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const sanitizedPrefix = sanitize(prefix);
  const sanitizedEntityId = sanitize(entityId);

  return sanitizedPrefix
    ? `${sanitizedPrefix}-${sanitizedEntityId}.${extension}`
    : `${sanitizedEntityId}.${extension}`;
}

/**
 * Detects an image's real format from its binary signature ("magic bytes")
 * rather than trusting caller-supplied metadata. A Content-Type header or
 * filename extension is trivially spoofed by a client, and raw Buffer /
 * ArrayBuffer sources carry no metadata at all — this is the only reliable
 * way to know what was actually uploaded. Used across every upload source
 * branch in `uploadImageKit` (and by `handleBase64Upload`) as the preferred
 * source of truth over any declared MIME type.
 *
 * @param bytes - The raw file bytes (or at least the first ~256 of them —
 *   every signature checked here lives within that range).
 * @returns A MIME type like `"image/png"`, or `null` if the format isn't
 *   one of the recognized signatures (JPEG, PNG, GIF, WEBP, BMP, AVIF,
 *   HEIC, SVG). Callers fall back to a declared/default type on `null`.
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
 * Matches a base64-encoded image data URL, e.g.
 * `"data:image/png;base64,iVBORw0KG..."`. Capture group 1 is the MIME type,
 * group 2 is the payload — the payload itself is constrained to the base64
 * charset (+ optional `=` padding) here, not just the overall shape, so a
 * match guarantees decodable content.
 *
 * This is the single source of truth for the data-URL shape: both
 * `isBase64Upload` (validation) and `handleBase64Upload` (extraction) test
 * against this same constant instead of each keeping an independent copy
 * that could quietly drift out of sync with the other.
 */
const BASE64_DATA_URL_PATTERN = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i;

/** Matches the base64 charset with optional padding, with no `data:` wrapper. Length/padding validity is checked separately in `isRawBase64String`. */
const RAW_BASE64_CHARSET_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * True when `value` is well-formed base64 text on its own (no `data:` URL
 * wrapper): valid base64 charset and correctly padded (length a multiple of
 * 4). Shared by the raw-string branch of `isBase64Upload` and by
 * `handleBase64Upload`, so both agree on exactly what counts as base64.
 */
function isRawBase64String(value: string): boolean {
  return RAW_BASE64_CHARSET_PATTERN.test(value) && value.length % 4 === 0;
}

/**
 * Returns true when a value looks like an image payload supplied as base64.
 *
 * Supports both standard data URLs such as `data:image/png;base64,...` and
 * raw base64 strings. Regular URLs and other non-base64 values return
 * false — used in `uploadImageKit` to decide whether a string source should
 * be parsed as base64 (via `handleBase64Upload`) or passed straight through
 * to ImageKit as a URL.
 */
export function isBase64Upload(value: unknown): value is string {
  if (typeof value !== 'string') return false;

  const trimmed = value.trim();
  if (trimmed.startsWith('data:')) {
    return BASE64_DATA_URL_PATTERN.test(trimmed);
  }

  return isRawBase64String(trimmed);
}

/**
 * Parses a base64 image payload (data URL or bare base64 string) into a
 * ready-to-upload Blob.
 *
 * Self-validates via `isBase64Upload` rather than trusting the caller to
 * have checked first — so this function is correct to call on its own, and
 * there's exactly one place (`isBase64Upload`) that defines what "valid
 * base64" means, instead of this function keeping its own parallel
 * validation that could disagree with it. In the current codebase
 * `uploadImageKit` always checks `isBase64Upload` first anyway (it needs
 * the boolean to decide which branch to take), so this is a cheap redundant
 * check in practice — a second regex test on a short string — traded for a
 * function that can't be misused by a future caller who skips that check.
 *
 * The declared MIME type (from the data: URL prefix, or the `image/jpeg`
 * default for a bare base64 string with no type info at all) is only a
 * starting guess: it's overridden by `detectImageMimeType` sniffing the
 * decoded bytes wherever that succeeds, since a data: URL's declared type
 * is caller-supplied and not guaranteed to match the actual content — same
 * trust model as every other upload source in this module.
 *
 * @param base64Url - The base64 string or data URL to parse.
 * @param prefix - Filename prefix, passed through to `generateImageFilename`.
 * @param entityId - Entity ID, passed through to `generateImageFilename`.
 * @returns The decoded file as a Blob plus its generated filename and
 *   resolved MIME type, or `null` if the input isn't valid base64 or
 *   decodes to zero bytes.
 */
function handleBase64Upload(base64Url: string, prefix: string, entityId: string): {
  file: Blob;
  fileName: string;
  mimeType: string;
} | null {
  if (!isBase64Upload(base64Url)) {
    console.error('[handleBase64Upload] ❌ Input is not a valid base64 image payload');
    return null;
  }

  const trimmed = base64Url.trim();
  let declaredMimeType = 'image/jpeg';
  let payload = trimmed;

  if (trimmed.startsWith('data:')) {
    const matches = trimmed.match(BASE64_DATA_URL_PATTERN);
    if (!matches) {
      // Unreachable given the isBase64Upload guard above (same pattern), but
      // handled explicitly rather than asserted away — a function shouldn't
      // need a non-null assertion to stay correct on its own.
      console.error('[handleBase64Upload] ❌ Data URL failed re-parse after passing validation');
      return null;
    }
    declaredMimeType = matches[1];
    payload = matches[2];
  }

  const buffer = Buffer.from(payload, 'base64');
  if (buffer.length === 0) {
    console.error('[handleBase64Upload] ❌ Decoded base64 payload is empty');
    return null;
  }

  const mimeType = detectImageMimeType(buffer) ?? declaredMimeType;
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
 * Appends a file Blob and its filename to `formData` under the `file` and
 * `fileName` fields ImageKit's upload API expects. Every source branch in
 * `uploadImageKit` that produces a Blob (base64, TypedArray, ArrayBuffer,
 * multipart) ends with this same two-line append — factored out so that
 * pairing stays in one place. Not used for the plain-URL string branch,
 * which appends a string rather than a Blob and has no filename to set on
 * the append call itself.
 */
function appendFileToFormData(formData: FormData, file: Blob, fileName: string): void {
  formData.append('file', file, fileName);
  formData.append('fileName', fileName);
}

/**
 * Universal image upload function — the single entry point all the
 * `upload*` wrappers below (and any future caller) go through.
 *
 * Accepts four shapes of `imageSource` and normalizes each into the
 * multipart FormData ImageKit's upload API expects:
 * - **URL string** (anything that isn't base64, per `isBase64Upload`) —
 *   passed straight through in the `file` field; ImageKit fetches it.
 * - **Base64 string / data URL** — decoded via `handleBase64Upload`.
 * - **Raw Buffer / TypedArray / ArrayBuffer** — no metadata exists for
 *   these at all, so the real format is sniffed from the bytes.
 * - **Multipart file object** (`ImageUploadObject`) — the client-supplied
 *   `mimetype`/`originalname` are untrusted (trivially spoofable), so the
 *   sniffed format is preferred and only falls back to the declared
 *   mimetype when sniffing is inconclusive; the extension always resolves
 *   through `validateMimeType`'s whitelist rather than the raw filename.
 *
 * Every failure path (invalid source, failed parse, upload error after
 * retries) returns `null` rather than throwing — callers get a uniform
 * "did this work" signal without needing their own try/catch, and the
 * specific failure reason is always logged via `console.error` first.
 *
 * @param imageSource - The image, in any of the four shapes above.
 * @param entityId - Entity ID used for filename generation and tagging.
 * @param options - Folder, filename prefix, tags, and uniqueness config.
 * @returns The ImageKit upload response (URL, file ID, etc.), or `null` on
 *   any failure.
 */
export async function uploadImageKit(
  imageSource: ImageUploadSource,
  entityId: string,
  options: ImageUploadOptions
): Promise<ImageKitUploadResponse | null> {
  try {
    const formData = new FormData();
    const folderPath = `/${APP_NAME_SLUG}/${options.folder}/${getTodayDate().replace(/-/g, '/')}`;
    const prefix = options.filenamePrefix ?? DEFAULT_FILENAME_PREFIX;

    if (typeof imageSource === 'string') {
      if (isBase64Upload(imageSource)) {
        const parsed = handleBase64Upload(imageSource, prefix, entityId);
        if (!parsed) return null;
        appendFileToFormData(formData, parsed.file, parsed.fileName);
      } else {
        formData.append('file', imageSource);
        formData.append('fileName', generateImageFilename(entityId, prefix));
      }
    } else if (ArrayBuffer.isView(imageSource) || imageSource instanceof ArrayBuffer) {
      // Raw TypedArray (including Node.js Buffer) or ArrayBuffer — send as
      // Blob. No metadata accompanies either source type, so sniff the real
      // format from the bytes rather than assuming JPEG (which previously
      // mislabeled every non-JPEG raw upload).
      const bytes = imageSource instanceof ArrayBuffer
        ? new Uint8Array(imageSource)
        : new Uint8Array(imageSource.buffer, imageSource.byteOffset, imageSource.byteLength);
      const mimeType = detectImageMimeType(bytes) ?? 'image/jpeg';
      const extension = validateMimeType(mimeType);
      const fileName = generateImageFilename(entityId, prefix, extension);
      appendFileToFormData(formData, new Blob([imageSource as BlobPart], { type: mimeType }), fileName);
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
      appendFileToFormData(formData, new Blob([uploadObj.buffer as BlobPart], { type: mimeType }), fileName);
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
 * Uploads a book's cover image, tagged with the book's own keywords plus a
 * book-cover marker and the book's ID (so covers can be found/cleaned up by
 * tag via the ImageKit dashboard or API without a DB round-trip).
 *
 * @param imageSource - The cover image, in any form `uploadImageKit` accepts.
 * @param bookMeta - Only `id` and `keywords` are used; typed as a `Pick` so
 *   callers can pass a full `Book` without this function depending on its
 *   entire shape.
 * @returns The ImageKit upload response, or `null` on failure — see
 *   `uploadImageKit` for the full failure/retry behavior.
 */
export async function uploadBookCover(
  imageSource: ImageUploadSource,
  bookMeta: Pick<Book, 'id' | 'title' | 'keywords' | 'slug'>,
): Promise<ImageKitUploadResponse | null> {
  const { id, slug, keywords } = bookMeta;
  const entityId = slug || id;
  return uploadImageKit(imageSource, entityId, {
    folder: 'books',
    tags: [...keywords, 'book-cover', `book-id:${id}`],
    filenamePrefix: slug ? '' : 'cover',
  });
}

/**
 * Uploads a book's main character avatar image, tagged with the book ID and
 * character name for lookup.
 *
 * @param imageSource - The avatar image, in any form `uploadImageKit` accepts.
 * @param bookId - Book this character belongs to; used for filename
 *   generation and the `book-id:` tag.
 * @param characterName - Used only for the `character:` tag — not
 *   sanitized here, since `generateImageFilename` never sees it (the
 *   filename is keyed on `bookId`, not `characterName`).
 * @returns The ImageKit upload response, or `null` on failure.
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
 * Uploads a character avatar image from the Story Bible (Lore entries).
 *
 * @param imageSource - Image source (base64 data URL, buffer, URL, etc.)
 * @param bookId - Book ID this lore character belongs to.
 * @param characterName - Character name for tagging and filename prefix.
 * @returns The ImageKit upload response, or `null` on failure.
 */
export async function uploadLoreCharacterImage(
  imageSource: ImageUploadSource,
  bookId: string,
  characterName: string
): Promise<ImageKitUploadResponse | null> {
  const sanitizedName = characterName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'character';

  return uploadImageKit(imageSource, bookId, {
    folder: 'lore-characters',
    tags: ['lore-character', `book-id:${bookId}`, `character:${sanitizedName}`],
    filenamePrefix: `lore-${sanitizedName}`,
  });
}

/**
 * Uploads a screenshot attached to a user feedback report.
 *
 * @param imageSource - The screenshot, in any form `uploadImageKit` accepts.
 * @param feedbackId - Feedback report this screenshot belongs to.
 * @returns The ImageKit upload response, or `null` on failure.
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
 * Uploads an inline draft image for the Pen editor (base64 data URL).
 *
 * Tagged with the pen-draft marker and the owning session's ID so drafts can be
 * found/cleaned up by tag via the ImageKit dashboard or API without a DB
 * round-trip, mirroring `uploadBookCover`'s tagging convention.
 *
 * @param imageSource - The draft image, in any form `uploadImageKit` accepts
 *   (the Pen editor sends a base64 data URL).
 * @param sessionId - Pen session this image belongs to.
 * @returns The ImageKit upload response, or `null` on failure.
 */
export async function uploadPenDraftImage(
  imageSource: ImageUploadSource,
  sessionId: string
): Promise<ImageKitUploadResponse | null> {
  return uploadImageKit(imageSource, sessionId, {
    folder: 'pen-drafts',
    tags: ['pen-draft', `session-id:${sessionId}`],
    filenamePrefix: 'draft',
  });
}

/**
 * Uploads a user's profile image.
 *
 * @param imageSource - The profile image, in any form `uploadImageKit` accepts.
 * @param userId - User this image belongs to.
 * @returns The ImageKit upload response, or `null` on failure.
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
      await throwForFailedResponse(response, 'ImageKit delete');
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
      await throwForFailedResponse(response, 'Bulk delete');
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
 * Deletes a folder and everything inside it from ImageKit in one call.
 *
 * Unlike the file-delete functions above, there's no DB-side bookkeeping to
 * reconcile here — folders aren't tracked in `uploaded_images` — so a
 * failure is just logged rather than queued for retry (there's no queue
 * entry type for "retry deleting this folder"). Intended for infrequent,
 * explicitly-triggered cleanup (e.g. wiping an entire book's or user's
 * image folder), not for the automated cleanup jobs below.
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
      await throwForFailedResponse(response, 'Folder delete');
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
 * Cleans up stale (outdated) user profile images for users who still exist.
 *
 * When a user uploads a new avatar, a *new* `uploaded_images` row is
 * inserted while the old row is left in place, so a user accumulates
 * multiple `type = 'user'` rows with a non-null `userId` over time. This
 * finds those users, keeps only the *most recent* row per user, and
 * deletes the rest from both ImageKit and the DB.
 *
 * Follows the same confirm-before-clearing rule as the deletion-queue
 * functions above: a user's DB rows are only removed for images
 * `deleteFilesFromImageKit` actually confirmed deleted. Anything that
 * fails stays in `uploaded_images` and simply reappears as a duplicate for
 * that user on the next run — no separate retry queue is needed here since
 * the "still has duplicates" query IS the retry mechanism.
 *
 * @param batchSize - Maximum number of distinct users (not images) to
 *   process in one run (default: 50).
 * @returns Stats: how many stale images were found (`processed`) and
 *   actually removed (`deleted`), plus any errors encountered.
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
 * Cleans up orphaned user uploads whose linked user account no longer exists.
 *
 * When a user account is deleted, a DB trigger sets `userId = NULL` on the
 * corresponding `uploaded_images` rows rather than deleting them outright
 * (deleting the image file itself is this function's job, on a schedule,
 * not the trigger's). This finds those orphaned rows, queues their ImageKit
 * file IDs for deletion via `queueImageForDeletion`, and removes the
 * `uploaded_images` tracking row for each one it successfully queued.
 *
 * Actual ImageKit deletion happens later via `processQueuedImageDeletions`
 * — this function's job is only to queue and untrack, not to delete
 * directly, since orphan cleanup and the deletion queue are handled by
 * separate scheduled jobs.
 *
 * @param batchSize - Maximum number of orphaned rows to process in one run
 *   (default: 100).
 * @returns Stats: how many orphaned rows were found (`processed`), how many
 *   were successfully queued for deletion (`queued`), how many tracking
 *   rows were removed (`removed`), plus any errors encountered.
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
