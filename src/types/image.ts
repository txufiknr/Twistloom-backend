export type ImageUploadObject = { buffer: ArrayBuffer | ArrayBufferLike | Buffer; originalname?: string; mimetype?: string };
export type ImageUploadSource = string | Buffer | ImageUploadObject;

/**
 * Universal image upload configuration options
 */
export interface ImageUploadOptions {
  /** Folder path within ImageKit (e.g., 'books', 'users') */
  folder: string;
  /** Tags to apply to the uploaded image */
  tags: string[];
  /** Custom metadata for the upload */
  customMetadata?: Record<string, unknown>;
  /** Filename prefix (e.g., 'book-cover', 'profile') */
  filenamePrefix?: string;
  /** Whether to use unique filename generation */
  useUniqueFileName?: boolean;
}