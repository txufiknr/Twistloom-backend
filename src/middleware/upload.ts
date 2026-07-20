/**
 * Hono upload middleware (multer replacement)
 *
 * Replaces `multer` for the single-file image upload used by
 * `PATCH /api/books/:id` (field name `imageFile`). It parses the multipart body
 * with Hono's native `c.req.parseBody`, validates the file is an image within the
 * configured size limit, and stores it on the context as `file` (see {@link AppEnv}).
 *
 * This keeps the route handlers serverless-friendly: there is no disk I/O and the
 * raw bytes are held in memory exactly like `multer.memoryStorage()`.
 */

import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../hono/env.js";
import { MAX_IMAGE_UPLOAD_SIZE } from "../config/image.js";

/**
 * Builds a single-file upload middleware for the given multipart field name.
 *
 * @param fieldName - The form field that carries the file (default: "imageFile")
 * @returns Hono middleware that populates `c.get("file")`
 */
export function imageUploadMiddleware(fieldName = "imageFile") {
  return createMiddleware<AppEnv>(async (c, next) => {
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

    if (file.size > MAX_IMAGE_UPLOAD_SIZE) {
      throw new HTTPException(413, { message: "Image file exceeds size limit" });
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    c.set("file", {
      originalname: file.name,
      mimetype: file.type,
      size: file.size,
      buffer,
    });

    await next();
  });
}
