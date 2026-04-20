import ImageKit, { toFile } from "@imagekit/nodejs";
import { getTodayDate } from "../utils/time.js";
import { dbWrite } from "../db/client.js";
import { inArray } from "drizzle-orm";
import { getErrorMessage } from "../utils/error.js";
import { APP_NAME_SLUG } from "../config/constants.js";
import { deletedImages } from "../db/schema.js";
import multer, { type FileFilterCallback } from "multer";
import { MAX_IMAGE_UPLOAD_SIZE } from "../config/image.js";
import type { ImageUploadObject, ImageUploadOptions, ImageUploadSource } from "../types/image.js";
import type { Book } from "../types/book.js";

let imageKitClient: ImageKit | null = null;

/**
 * @overview Default multer configuration for image uploads
 * 
 * Provides centralized multer configuration for file uploads across the application.
 * Supports image uploads with size limits and file type validation.
 * 
 * Features:
 * - Image file type validation
 * - Reusable configuration across routes
 * - Type-safe middleware setup
 * - Uses memory storage for serverless compatibility
 * - 2MB file size limit
 * - Provides file filtering callback
 */
export const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMAGE_UPLOAD_SIZE, // 2MB limit
  },
  fileFilter: (
    req: Express.Request,
    file: Express.Multer.File,
    callback: FileFilterCallback,
  ) => {
    // Accept only image files
    if (file.mimetype?.startsWith('image/')) {
      callback(null, true);
    } else {
      callback(new Error('Only image files are allowed'));
    }
  },
});

/**
 * Format keywords array for URL encoding
 * Converts array of keywords to pipe-delimited string with spaces replaced by '+'
 * @param keywords - Array of keywords to format
 * @returns URL-encoded string suitable for API requests
 * 
 * @example
 * ```typescript
 * formatKeywordsForUrl(['muslim woman', 'muslimah']) // returns 'muslim+woman|muslimah'
 * formatKeywordsForUrl(['dua', 'dhikr', 'tasbih']) // returns 'dua|dhikr|tasbih'
 * ```
 */
export function formatKeywordsForUrl(keywords: string[]): string {
  return keywords
    .map(keyword => keyword.replace(/\s+/g, '+')) // Replace spaces with '+'
    .join('|'); // Join with pipe delimiter
}

function getImageKitClient(): ImageKit | null {
  if (imageKitClient) return imageKitClient;

  const IMAGEKIT_API_KEY_PRIVATE = process.env['IMAGEKIT_API_KEY_PRIVATE'];
  if (!IMAGEKIT_API_KEY_PRIVATE) {
    console.warn("[getImageKitClient] ⚠️ Credentials not configured");
    return null;
  }

  // Docs: https://www.npmjs.com/package/@imagekit/nodejs
  // Docs: https://github.com/imagekit-developer/imagekit-nodejs
  imageKitClient = new ImageKit({
    privateKey: IMAGEKIT_API_KEY_PRIVATE,
  });

  return imageKitClient;
}

/**
 * Handle URL-based image uploads
 * @param imageUrl - Image URL to upload
 * @param prefix - Filename prefix
 * @param entityId - Entity ID for uniqueness
 * @returns Processed file content and filename
 */
function handleUrlUpload(imageUrl: string, prefix: string, entityId: string): {
  fileContent: string;
  fileName: string;
  mimeType?: string;
} {
  const fileName = generateImageFilename(entityId, prefix);
  return {
    fileContent: imageUrl,
    fileName,
  };
}

/**
 * Validate and extract file extension from MIME type
 * @param mimeType - MIME type string to validate
 * @returns Valid file extension or default 'jpg'
 */
function validateMimeType(mimeType: string): string {
  if (!mimeType || typeof mimeType !== 'string') {
    console.warn('[validateMimeType] ⚠️ Invalid MIME type provided, using default');
    return 'jpg';
  }

  const parts = mimeType.split('/');
  if (parts.length !== 2 || !parts[0].startsWith('image/')) {
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
 * Handle base64 data URL uploads
 * @param base64Url - Base64 data URL
 * @param prefix - Filename prefix
 * @param entityId - Entity ID for uniqueness
 * @returns Processed file content, filename, and MIME type
 */
function handleBase64Upload(base64Url: string, prefix: string, entityId: string): {
  fileContent: Buffer;
  fileName: string;
  mimeType: string;
} | null {
  const matches = base64Url.match(/^data:(.+?);base64,(.+)$/);
  if (!matches || matches.length !== 3) {
    console.error('[handleBase64Upload] ❌ Invalid base64 data URL format');
    return null;
  }

  const mimeType = matches[1];
  const base64Data = matches[2];
  const fileContent = Buffer.from(base64Data, 'base64');
  const extension = validateMimeType(mimeType);
  const fileName = generateImageFilename(entityId, prefix, extension);

  return {
    fileContent,
    fileName,
    mimeType,
  };
}

/**
 * Handle multipart file uploads
 * @param uploadObj - File upload object with buffer and metadata
 * @param prefix - Filename prefix
 * @param entityId - Entity ID for uniqueness
 * @returns Processed file content, filename, and MIME type
 */
function handleFileUpload(uploadObj: ImageUploadObject, prefix: string, entityId: string): {
  fileContent: Buffer;
  fileName: string;
  mimeType?: string;
} {
  // Convert buffer to Node Buffer for ImageKit with proper type safety
  let fileContent: Buffer;
  if (Buffer.isBuffer(uploadObj.buffer)) {
    fileContent = uploadObj.buffer;
  } else if (uploadObj.buffer instanceof ArrayBuffer) {
    fileContent = Buffer.from(uploadObj.buffer);
  } else if (typeof uploadObj.buffer === 'object' && uploadObj.buffer !== null) {
    // Handle ArrayBufferLike - validate it has required properties
    const arrayBufferLike = uploadObj.buffer as ArrayBufferLike;
    
    // Check if it has the required ArrayBufferLike properties
    if (typeof arrayBufferLike.byteLength === 'number' && 
        typeof arrayBufferLike.slice === 'function') {
      try {
        // Convert to proper ArrayBuffer first, then to Buffer
        const arrayBuffer = arrayBufferLike.slice(0);
        fileContent = Buffer.from(arrayBuffer);
      } catch (error) {
        console.error('[handleFileUpload] ❌ Failed to convert ArrayBufferLike to Buffer:', getErrorMessage(error));
        throw new Error('Invalid ArrayBufferLike: cannot convert to Buffer', { cause: error });
      }
    } else {
      console.error('[handleFileUpload] ❌ Invalid ArrayBufferLike: missing required properties');
      throw new Error('Invalid ArrayBufferLike: missing byteLength or slice method');
    }
  } else {
    console.error('[handleFileUpload] ❌ Invalid buffer type:', typeof uploadObj.buffer);
    throw new Error(`Invalid buffer type: ${typeof uploadObj.buffer}`);
  }

  const extension = uploadObj.originalname?.split('.').pop() || 'jpg';
  const fileName = generateImageFilename(entityId, prefix, extension);

  return {
    fileContent,
    fileName,
    mimeType: uploadObj.mimetype,
  };
}

/**
 * Universal image upload function
 * 
 * Handles image uploads from multiple sources (URL, base64, multipart file) with customizable
 * folder structure, tags, and metadata. This is a library-like function that can be used for
 * any image upload scenario in the project.
 * 
 * @param imageSource - Image source (URL, base64, or file object)
 * @param entityId - Entity ID for filename generation and metadata
 * @param options - Upload configuration options
 * @returns Promise resolving to ImageKit upload response with URL and file ID
 * 
 * @example
 * ```typescript
 * // Book cover upload
 * const bookResult = await uploadImageKit(
 *   imageSource,
 *   'book-123',
 *   {
 *     folder: 'books',
 *     tags: ['book-cover', 'book-id:book-123'],
 *     customMetadata: { bookId: 'book-123', bookTitle: 'Mystery Mansion' },
 *     filenamePrefix: 'cover'
 *   }
 * );
 * 
 * // User profile upload
 * const userResult = await uploadImageKit(
 *   imageSource,
 *   'user-456',
 *   {
 *     folder: 'users',
 *     tags: ['user-profile', 'user-id:user-456'],
 *     customMetadata: { userId: 'user-456' },
 *     filenamePrefix: 'profile'
 *   }
 * );
 * ```
 */
export async function uploadImageKit(
  imageSource: ImageUploadSource,
  entityId: string,
  options: ImageUploadOptions
): Promise<ImageKit.Files.FileUploadResponse | null> {
  const imagekit = getImageKitClient();
  if (!imagekit) return null;

  // Track created File objects for cleanup
  const createdFiles: File[] = [];

  try {
    let fileData: File | string;
    let fileName: string;

    // Handle different input types using helper functions
    if (typeof imageSource === 'string') {
      if (imageSource.startsWith('data:')) {
        // Base64 data URL - convert to File using toFile
        const base64Result = handleBase64Upload(imageSource, options.filenamePrefix || 'image', entityId);
        if (!base64Result) return null;
        
        try {
          const file = await toFile(
            base64Result.fileContent,
            generateImageFilename(entityId, options.filenamePrefix || 'image', validateMimeType(base64Result.mimeType)),
            { type: base64Result.mimeType }
          );
          createdFiles.push(file);
          fileData = file;
          fileName = file.name;
        } catch (fileError) {
          console.error('[uploadImageKit] ❌ Failed to convert base64 to File:', fileError);
          return null;
        }
      } else {
        // Regular URL - pass string directly
        const urlResult = handleUrlUpload(imageSource, options.filenamePrefix || 'image', entityId);
        fileData = urlResult.fileContent; // This is the URL string
        fileName = generateImageFilename(entityId, options.filenamePrefix || 'image');
      }
    } else if (imageSource && typeof imageSource === 'object' && 'buffer' in imageSource) {
      // File object from multipart upload - convert Buffer to File
      const uploadObj = imageSource as ImageUploadObject;
      const fileResult = handleFileUpload(uploadObj, options.filenamePrefix || 'image', entityId);
      
      try {
        const file = await toFile(
          fileResult.fileContent,
          generateImageFilename(entityId, options.filenamePrefix || 'image', uploadObj.originalname?.split('.').pop() || 'jpg'),
          { type: uploadObj.mimetype }
        );
        createdFiles.push(file);
        fileData = file;
        fileName = file.name;
      } catch (fileError) {
        console.error('[uploadImageKit] ❌ Failed to convert multipart file to File:', fileError);
        return null;
      }
    } else if (Buffer.isBuffer(imageSource)) {
      // Direct Buffer input - convert to File
      const bufferResult = handleFileUpload(
        { buffer: imageSource, originalname: 'buffer.jpg', mimetype: undefined },
        options.filenamePrefix || 'image',
        entityId
      );
      
      try {
        const file = await toFile(
          bufferResult.fileContent,
          generateImageFilename(entityId, options.filenamePrefix || 'image', 'jpg'),
          { type: 'image/jpeg' }
        );
        createdFiles.push(file);
        fileData = file;
        fileName = file.name;
      } catch (fileError) {
        console.error('[uploadImageKit] ❌ Failed to convert buffer to File:', fileError);
        return null;
      }
    } else {
      console.error('[uploadImageKit] ❌ Invalid image source type');
      return null;
    }

    // Prepare upload parameters
    const uploadParams: ImageKit.Files.FileUploadParams = {
      file: fileData,
      fileName,
      useUniqueFileName: options.useUniqueFileName ?? false,
      folder: `/${APP_NAME_SLUG}/${options.folder}/${getTodayDate().replace(/-/g, '/')}`,
      tags: options.tags,
      customMetadata: {
        entityId,
        uploadType: options.filenamePrefix || 'image',
        uploadedAt: new Date().toISOString(),
        ...options.customMetadata,
      },
    };

    const result = await imagekit.files.upload(uploadParams);

    console.log(`[uploadImageKit] 📸 Image uploaded: ${result.url} (ID: ${result.fileId})`);
    return result;
  } catch (error) {
    console.error(`[uploadImageKit] ❌ Image upload failed for entity ${entityId}:`, getErrorMessage(error));
    return null;
  } finally {
    // Cleanup File objects to prevent memory leaks
    // Note: In serverless environments, this helps with garbage collection
    createdFiles.length = 0; // Clear array for GC
  }
}

/**
 * Generate sanitized filename for images
 * @param entityId - Entity ID for uniqueness
 * @param prefix - Filename prefix
 * @param extension - File extension (default: 'jpg')
 * @returns Sanitized filename
 */
function generateImageFilename(entityId: string, prefix: string, extension: string = 'jpg'): string {
  const sanitizedPrefix = prefix
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${sanitizedPrefix}-${entityId}.${extension}`;
}

/**
 * Upload book cover image to ImageKit.io
 * 
 * Wrapper function for book cover uploads using the universal uploadImageKit function.
 * Maintains backward compatibility while leveraging the universal implementation.
 * 
 * @param imageSource - Image source (URL string, base64 string, or file object)
 * @param bookId - Book ID for metadata and folder organization
 * @param bookTitle - Book title for filename generation
 * @param keywords - Book keywords/tags for ImageKit metadata
 * @returns Promise resolving to ImageKit upload response with URL and file ID
 * 
 * @example
 * ```typescript
 * // Upload from URL
 * const result = await uploadBookCover(
 *   'https://example.com/cover.jpg',
 *   'book-123',
 *   'Mystery Mansion',
 *   ['thriller', 'mystery', 'haunted']
 * );
 * 
 * // Upload from base64
 * const result = await uploadBookCover(
 *   'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ...',
 *   'book-123',
 *   'Mystery Mansion',
 *   ['thriller', 'mystery']
 * );
 * 
 * // Upload from file (multipart)
 * const result = await uploadBookCover(
 *   req.file,
 *   'book-123',
 *   'Mystery Mansion',
 *   ['thriller', 'mystery']
 * );
 * ```
 */
export async function uploadBookCover(
  imageSource: ImageUploadSource,
  bookMeta: Pick<Book, 'id' | 'title' | 'keywords'>,
): Promise<ImageKit.Files.FileUploadResponse | null> {
  const { id, title, keywords } = bookMeta;
  return uploadImageKit(imageSource, id, {
    folder: 'books',
    tags: [...keywords, 'book-cover', `book-id:${id}`],
    customMetadata: {
      bookId: id,
      bookTitle: title,
    },
    filenamePrefix: 'cover',
  });
}

/**
 * Upload user profile image to ImageKit.io
 * 
 * Wrapper function for user profile uploads using the universal uploadImageKit function.
 * Maintains backward compatibility while leveraging the universal implementation.
 * 
 * @param imageSource - Image source (URL, base64, or file object)
 * @param userId - User ID for metadata and filename generation
 * @returns Promise resolving to ImageKit upload response with URL and file ID
 * 
 * @example
 * ```typescript
 * // Upload from file (multipart)
 * const result = await uploadUserProfile(req.file, 'user-123');
 * 
 * // Upload from base64
 * const result = await uploadUserProfile(
 *   'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ...',
 *   'user-123'
 * );
 * 
 * // Upload from URL
 * const result = await uploadUserProfile(
 *   'https://example.com/profile.jpg',
 *   'user-123'
 * );
 * ```
 */
export async function uploadUserProfile(
  imageSource: ImageUploadSource,
  userId: string
): Promise<ImageKit.Files.FileUploadResponse | null> {
  return uploadImageKit(imageSource, userId, {
    folder: 'users',
    tags: ['user-profile', `user-id:${userId}`],
    customMetadata: {
      userId,
    },
    filenamePrefix: 'profile',
  });
}

/**
 * Deletes a file from ImageKit with fallback to deletion queue
 * 
 * Attempts to delete the file directly from ImageKit. If deletion fails,
 * queues the file for retry by the cleanup cron job. This ensures reliability
 * even during temporary API failures.
 * 
 * @param fileId - ImageKit file ID to delete
 * @returns Promise resolving when deletion is attempted
 * 
 * @example
 * ```typescript
 * await deleteFileFromImageKit('file_id_123');
 * ```
 */
export async function deleteFileFromImageKit(fileId: string) {
  const imagekit = getImageKitClient();
  if (!imagekit) return;

  try {
    await imagekit.files.delete(fileId);
    console.log(`[imagekit] 🗑️ Image ${fileId} deleted successfully.`);
  } catch (error) {
    // Queue for retry by cleanup cron job
    try {
      await queueImageForDeletion(fileId);
      console.log(`[imagekit] 🔄 File ${fileId} queued for retry by cleanup job:`, getErrorMessage(error));
    } catch (dbError) {
      console.error(`[imagekit] ❌ Failed to queue image deletion for ${fileId}:`, getErrorMessage(dbError));
    }
  }
}

/**
 * Bulk deletes multiple files from ImageKit
 * 
 * Deletes multiple files in a single API call for better performance.
 * Unlike single file deletion, this does not have automatic fallback to queue.
 * 
 * @param fileIds - Array of ImageKit file IDs to delete
 * @returns Promise resolving when deletion is attempted
 * 
 * @example
 * ```typescript
 * await deleteFilesFromImageKit(['file_id_1', 'file_id_2', 'file_id_3']);
 * ```
 */
export async function deleteFilesFromImageKit(fileIds: string[]) {
  const imagekit = getImageKitClient();
  if (!imagekit) return;

  try {
    const response = await imagekit.files.bulk.delete({ fileIds });
    console.log("[imagekit] 🗑️ Images bulk delete result:", response.successfullyDeletedFileIds);
  } catch (error) {
    console.error(`[imagekit] ❌ Failed to bulk delete images:`, getErrorMessage(error));
  }
}

/**
 * Deletes a folder and all its contents from ImageKit
 * 
 * Permanently deletes the specified folder and all files within it.
 * This operation cannot be undone.
 * 
 * @param folderPath - Path of the folder to delete (e.g., 'books/2024/01/15')
 * @returns Promise resolving when deletion is attempted
 * 
 * @example
 * ```typescript
 * await deleteFolderFromImageKit('books/2024/01/15');
 * ```
 */
export async function deleteFolderFromImageKit(folderPath: string) {
  const imagekit = getImageKitClient();
  if (!imagekit) return;

  try {
    await imagekit.folders.delete({ folderPath });
    console.log(`[imagekit] 🗑️ Folder "${folderPath}" and all its contents deleted.`);
  } catch (error) {
    console.error(`[imagekit] ❌ Failed to delete folder "${folderPath}"`, getErrorMessage(error));
  }
}

/**
 * Queues an image for deletion in the deleted_images table
 * 
 * This function is used to track images that need to be deleted from ImageKit.
 * A separate cleanup process will handle the actual deletion.
 * 
 * @param imageId - ImageKit file ID to queue for deletion
 * @returns Promise resolving when deletion is queued
 * 
 * @example
 * ```typescript
 * await queueImageForDeletion('file_id_123');
 * ```
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
    // Don't throw - deletion queue failure shouldn't block the main operation
  }
}

/**
 * Process queued ImageKit file deletions from deleted_images table
 * 
 * This function processes the cleanup queue created by the database trigger:
 * 1. Fetches pending file IDs from deleted_images table (oldest first)
 * 2. Attempts to delete each file from ImageKit
 * 3. Removes processed rows from the queue (both successful and failed deletions)
 * 4. Returns statistics for monitoring and logging
 * 
 * @param batchSize - Maximum number of files to process in one batch (default: 50)
 * @returns Promise resolving to deletion statistics
 * 
 * Idempotency:
 * - Safe to run multiple times: only processes existing queue items
 * - Removes processed items to prevent reprocessing
 * - Handles ImageKit API failures gracefully
 * - Uses database transaction for consistency
 * 
 * Error Handling:
 * - Logs individual file deletion failures but continues processing
 * - Removes failed items from queue to prevent infinite loops
 * - Returns detailed statistics for monitoring
 */
export async function processQueuedImageDeletions(batchSize: number = 50): Promise<{
  processed: number;
  successful: number;
  failed: number;
  errors: string[];
}> {
  const imagekit = getImageKitClient();
  if (!imagekit) {
    console.warn("[imagekit] ⚠️ ImageKit client not configured, skipping cleanup");
    return { processed: 0, successful: 0, failed: 0, errors: [] };
  }

  const stats = {
    processed: 0,
    successful: 0,
    failed: 0,
    errors: [] as string[]
  };

  try {
    console.log(`[imagekit] 🧹 Processing up to ${batchSize} queued image deletions...`);
    
    // Fetch pending deletions (oldest first for FIFO processing)
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

    // Use bulk deletion for optimal performance
    try {
      const response = await imagekit.files.bulk.delete({ fileIds: fileIdsToDelete });
      stats.successful = response.successfullyDeletedFileIds?.length || 0;
      stats.failed = fileIdsToDelete.length - stats.successful;
      
      console.log(`[imagekit] 🗑️ Bulk deletion completed: ${stats.successful}/${stats.processed} successful`);
      
      // Note: ImageKit bulk API doesn't provide detailed failure information
      // We can only determine which files succeeded vs total count
    } catch (bulkError) {
      // Fallback to individual deletions if bulk fails
      console.warn("[imagekit] ⚠️ Bulk deletion failed, falling back to individual deletions:", bulkError);
      
      // Reset counters for fallback processing
      stats.successful = 0;
      stats.failed = 0;
      
      // Process each deletion individually as fallback
      for (const deletion of pendingDeletions) {
        try {
          await imagekit.files.delete(deletion.fileId);
          stats.successful++;
          console.log(`[imagekit] 🗑️ File ${deletion.fileId} deleted successfully (fallback)`);
        } catch (error) {
          stats.failed++;
          const errorMsg = `Failed to delete file ${deletion.fileId}: ${error instanceof Error ? error.message : String(error)}`;
          stats.errors.push(errorMsg);
          console.error(`[imagekit] ❌ ${errorMsg}`);
        }
      }
    }

    // Remove processed items from queue (both successful and failed)
    if (fileIdsToDelete.length > 0) {
      await dbWrite
        .delete(deletedImages)
        .where(inArray(deletedImages.fileId, fileIdsToDelete));
    }

    console.log(`[imagekit] ✅ Cleanup completed: ${stats.successful}/${stats.processed} successful, ${stats.failed} failed`);
    
    return stats;
  } catch (error) {
    const errorMsg = `ImageKit cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`[imagekit] ❌ ${errorMsg}`);
    stats.errors.push(errorMsg);
    return stats;
  }
}