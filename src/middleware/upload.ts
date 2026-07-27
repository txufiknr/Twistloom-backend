/**
 * Hono upload middleware (multer replacement)
 *
 * Replaces `multer` for the single-file image upload used by
 * `PATCH /api/books/:id` (field name `imageFile`). It parses the multipart body
 * with Hono's native `c.req.parseBody`, validates the file is an image (MIME
 * type + magic bytes) within the configured size limit, and stores it on the
 * context as `file` (see {@link AppEnv}).
 *
 * This keeps the route handlers serverless-friendly: there is no disk I/O and the
 * raw bytes are held in memory exactly like `multer.memoryStorage()`.
 */

import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../hono/env.js";
import { MAX_IMAGE_UPLOAD_SIZE } from "../config/image.js";

/**
 * Magic bytes (file signatures) for common image formats.
 * Used to validate the actual file content matches the declared MIME type.
 */
const IMAGE_MAGIC_BYTES: Record<string, Uint8Array> = {
  "image/jpeg": new Uint8Array([0xFF, 0xD8, 0xFF]),
  "image/png":  new Uint8Array([0x89, 0x50, 0x4E, 0x47]),
  "image/gif":  new Uint8Array([0x47, 0x49, 0x46]),
  "image/webp": new Uint8Array([0x52, 0x49, 0x46, 0x46]), // RIFF header
};

/**
 * Checks whether the first bytes of `buffer` match the expected magic bytes
 * for a given MIME type. Returns `true` if the MIME type has no magic-byte
 * definition (unknown format) — the caller should still reject unknown types
 * via the MIME check.
 */
function matchesMagicBytes(buffer: Uint8Array, mimeType: string): boolean {
  const expected = IMAGE_MAGIC_BYTES[mimeType];
  if (!expected) return true; // Unknown MIME — let the caller's MIME check decide
  if (buffer.length < expected.length) return false;
  return expected.every((byte, i) => buffer[i] === byte);
}

/**
 * Builds a single-file upload middleware for the given multipart field name.
 *
 * @param fieldName - The form field that carries the file (default: "imageFile")
 * @returns Hono middleware that populates `c.get("file")`
 */
export function imageUploadMiddleware(fieldName = "imageFile") {
  return createMiddleware<AppEnv>(async (c, next) => {
    const contentType = c.req.header("content-type") || "";

    // JSON requests carry imageUrl as a base64 string — no multipart file to validate
    if (contentType.includes("application/json")) {
      await next();
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.parseBody({ all: true });
    } catch {
      throw new HTTPException(400, { message: "Invalid multipart form data" });
    }

    const file = body[fieldName];

    if (!(file instanceof File)) {
      throw new HTTPException(400, { message: "Image file is required" });
    }

    if (!file.type.startsWith("image/")) {
      throw new HTTPException(400, { message: "Only image files are allowed" });
    }

    // Explicitly reject SVG — SVGs can contain XSS payloads and are not
    // needed for avatar / book-cover uploads. If SVG support is ever required,
    // sanitise the SVG content via a dedicated library (e.g. svg-sanitizer).
    if (file.type === "image/svg+xml") {
      throw new HTTPException(400, { message: "SVG uploads are not supported" });
    }

    if (file.size > MAX_IMAGE_UPLOAD_SIZE) {
      throw new HTTPException(413, { message: "Image file exceeds size limit" });
    }

    const buffer = new Uint8Array(await file.arrayBuffer());

    // Magic-byte validation: verify the file header matches the declared MIME
    // type. This prevents polyglot files and mislabeled content from passing
    // as valid images.
    if (!matchesMagicBytes(buffer, file.type)) {
      throw new HTTPException(400, { message: "File content does not match image type" });
    }

    c.set("file", {
      originalname: file.name,
      mimetype: file.type,
      size: file.size,
      buffer,
    });

    await next();
  });
}
