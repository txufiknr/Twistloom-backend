/**
 * Hono-specific shared types.
 */

/**
 * A parsed multipart file, mirroring the subset of `Express.Multer.File` the
 * backend actually uses (memory-stored buffer + metadata). Produced by the Hono
 * upload middleware in {@link ./middleware/upload.ts} which replaces `multer`.
 */
export interface UploadedFile {
  /** Original client-side filename */
  originalname: string;
  /** Detected MIME type (e.g. "image/png") */
  mimetype: string;
  /** Decoded byte size */
  size: number;
  /** Raw file bytes held in memory (serverless-safe, mirrors multer memoryStorage) */
  buffer: Buffer;
}
