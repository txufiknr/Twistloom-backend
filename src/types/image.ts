/**
 * Image upload source types
 */
/** @types/node's Buffer is Uint8Array (ArrayBufferView) so this covers both Node.js and Edge runtimes */
export type ImageUploadObject = { buffer: ArrayBuffer | ArrayBufferView; originalname?: string; mimetype?: string };
export type ImageUploadSource = string | ArrayBufferView | ImageUploadObject;

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

/**
 * Response from ImageKit upload API (v1)
 *
 * @example
 * ```typescript
 * const result: ImageKitUploadResponse = {
 *   fileId: 'abc123',
 *   name: 'my-image.jpg',
 *   url: 'https://ik.imagekit.io/demo/my-image.jpg',
 *   thumbnailUrl: 'https://ik.imagekit.io/demo/tr:n-ik_ml_thumbnail/my-image.jpg',
 *   height: 500,
 *   width: 1000,
 *   size: 12345,
 *   filePath: '/my-image.jpg',
 *   fileType: 'image'
 * };
 * ```
 */
export interface ImageKitUploadResponse {
  /** Unique fileId. Store this in your database for future operations */
  fileId: string;
  /** Name of the asset */
  name: string;
  /** The relative path of the file in the media library */
  filePath: string;
  /** A publicly accessible URL of the file */
  url: string;
  /** In the case of an image, a small thumbnail URL */
  thumbnailUrl: string;
  /** Height of the image in pixels (only for images) */
  height: number;
  /** Width of the image in pixels (only for images) */
  width: number;
  /** Size of the image file in bytes */
  size: number;
  /** Type of file - 'image', 'video', 'audio', 'raw' */
  fileType: string;
  /** Array of tags associated with the file */
  tags?: string[];
  /** AITags added by automl or by the user */
  AITags?: Array<{ id: string; name: string; confidence: number; source: string }>;
  /** Indicates if the file is private */
  isPrivateFile?: boolean;
  /** Custom metadata associated with the file */
  customMetadata?: Record<string, unknown>;
  /** The extension of the file */
  extension?: string;
}
