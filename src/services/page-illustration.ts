/**
 * @fileoverview Page Illustration Generation Service
 *
 * Core generation pipeline for AI page illustrations. Handles:
 * - Single page illustration generation (on-demand / lazy)
 * - Batch missing illustration generation (cron)
 * - Per-book illustration generation (admin trigger)
 *
 * Reference pattern: `generateCoverImages()` in `src/services/book.ts:2721`.
 */

import { geminiGenerateImage } from "../utils/ai-image.js";
import { uploadImageKit, persistUploadedImage } from "./image.js";
import { dbWrite, dbRead } from "../db/client.js";
import { pages, books } from "../db/schema.js";
import { eq, and, isNull, isNotNull, gt, sql, count, desc } from "drizzle-orm";
import { IS_PRODUCTION } from "../config/env.js";
import { getErrorMessage } from "../utils/error.js";
import {
  ILLUSTRATION_IMPORTANCE_THRESHOLD,
  MAX_ILLUSTRATIONS_PER_BOOK,
  ILLUSTRATION_ASPECT_RATIO,
  ILLUSTRATION_JPEG_QUALITY,
  ILLUSTRATION_IMAGEKIT_FOLDER,
} from "../config/page-illustrations.js";

/**
 * Generate a page illustration from the page's imagePrompt.
 * Uploads to ImageKit, persists to uploaded_images, sets pages.image_url.
 *
 * @param pageId - ID of the page to illustrate
 * @param imagePrompt - AI-written text-to-image description
 * @param bookId - ID of the book (for ImageKit tagging)
 * @param userId - Owner user ID (for uploaded_images tracking)
 * @returns The ImageKit URL, or null on failure
 */
export async function generatePageIllustration(
  pageId: string,
  imagePrompt: string,
  bookId: string,
  userId: string | null,
): Promise<string | null> {
  if (!IS_PRODUCTION) {
    console.log(`[generatePageIllustration] ⏩ Skipping in development`);
    return null;
  }

  try {
    // 1. Generate image via Gemini
    const { buffers } = await geminiGenerateImage(imagePrompt, {
      numberOfImages: 1,
      aspectRatio: ILLUSTRATION_ASPECT_RATIO,
      outputMimeType: "image/jpeg",
      outputCompressionQuality: ILLUSTRATION_JPEG_QUALITY,
    });

    if (buffers.length === 0) {
      console.warn(`[generatePageIllustration] ⚠️ No image generated for page ${pageId}`);
      return null;
    }

    // 2. Upload to ImageKit
    const uploadResult = await uploadImageKit(buffers[0], pageId, {
      folder: ILLUSTRATION_IMAGEKIT_FOLDER,
      tags: ["page-illustration", `book-id:${bookId}`, `page-id:${pageId}`],
      filenamePrefix: "illustration",
    });

    if (!uploadResult) {
      console.warn(`[generatePageIllustration] ⚠️ ImageKit upload failed for page ${pageId}`);
      return null;
    }

    // 3. Persist to uploaded_images + 4. Set pages.image_url (atomic transaction)
    await dbWrite.transaction(async (tx) => {
      await persistUploadedImage({
        imageId: uploadResult.fileId,
        imageUrl: uploadResult.url,
        type: "page_illustration",
        userId: userId ?? "00000000-0000-0000-0000-000000000000",
        entityId: pageId,
        client: tx,
      });

      await tx
        .update(pages)
        .set({ imageUrl: uploadResult.url, updatedAt: new Date() })
        .where(eq(pages.id, pageId));
    });

    console.log(`[generatePageIllustration] ✅ Generated illustration for page ${pageId}`);
    return uploadResult.url;
  } catch (error) {
    console.error(`[generatePageIllustration] ❌ Failed for page ${pageId}:`, getErrorMessage(error));
    return null;
  }
}

/**
 * Find all pages that need illustrations and generate them.
 * Called by the cron job.
 *
 * @param batchSize - Max pages to process per run
 * @returns Stats about the generation run
 */
export async function generateMissingPageIllustrations(
  batchSize: number = 20,
): Promise<{ processed: number; generated: number; failed: number }> {
  const stats = { processed: 0, generated: 0, failed: 0 };

  // Find pages with high imageImportance, no imageUrl yet, in active public non-Pen books
  const candidates = await dbRead
    .select({
      id: pages.id,
      bookId: pages.bookId,
      imagePrompt: pages.imagePrompt,
      imageImportance: pages.imageImportance,
    })
    .from(pages)
    .innerJoin(books, eq(pages.bookId, books.id))
    .where(and(
      gt(pages.imageImportance, ILLUSTRATION_IMPORTANCE_THRESHOLD),
      isNull(pages.imageUrl),
      isNotNull(pages.imagePrompt),
      eq(books.status, "active"),
      eq(books.visibility, "public"),
      eq(books.isPenBook, false),
    ))
    .orderBy(sql`RANDOM()`)
    .limit(batchSize);

  console.log(`[generateMissingPageIllustrations] 📋 Found ${candidates.length} candidate pages`);

  for (const candidate of candidates) {
    if (!candidate.imagePrompt) continue;

    stats.processed++;

    // Per-book cost cap: check current illustration count
    const [{ bookCount }] = await dbRead
      .select({ bookCount: count() })
      .from(pages)
      .where(and(
        eq(pages.bookId, candidate.bookId),
        isNotNull(pages.imageUrl),
      ));

    if (bookCount >= MAX_ILLUSTRATIONS_PER_BOOK) {
      console.log(`[generateMissingPageIllustrations] ⏸️ Book ${candidate.bookId} reached cap (${MAX_ILLUSTRATIONS_PER_BOOK})`);
      continue;
    }

    // Look up book owner for uploaded_images.userId
    const [bookOwner] = await dbRead
      .select({ userId: books.userId })
      .from(books)
      .where(eq(books.id, candidate.bookId))
      .limit(1);

    const result = await generatePageIllustration(
      candidate.id,
      candidate.imagePrompt,
      candidate.bookId,
      bookOwner?.userId ?? null,
    );

    if (result) {
      stats.generated++;
    } else {
      stats.failed++;
    }

    // Rate limit: 2 second delay between generations
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  return stats;
}

/**
 * Generate illustrations for all qualifying pages in a specific book.
 * Called by the cron job (on-demand mode) or admin endpoint.
 *
 * @param bookId - ID of the book to generate illustrations for
 * @param batchSize - Max pages to process per run
 * @returns Stats about the generation run
 */
export async function generateBookIllustrations(
  bookId: string,
  batchSize: number = 20,
): Promise<{ processed: number; generated: number; failed: number }> {
  const stats = { processed: 0, generated: 0, failed: 0 };

  // Get book owner
  const [bookOwner] = await dbRead
    .select({ userId: books.userId })
    .from(books)
    .where(eq(books.id, bookId))
    .limit(1);

  // Check current illustration count for cost cap
  const [{ bookCount }] = await dbRead
    .select({ bookCount: count() })
    .from(pages)
    .where(and(
      eq(pages.bookId, bookId),
      isNotNull(pages.imageUrl),
    ));

  if (bookCount >= MAX_ILLUSTRATIONS_PER_BOOK) {
    console.log(`[generateBookIllustrations] ⏸️ Book ${bookId} already at cap (${bookCount}/${MAX_ILLUSTRATIONS_PER_BOOK})`);
    return stats;
  }

  const remaining = MAX_ILLUSTRATIONS_PER_BOOK - bookCount;
  const effectiveBatch = Math.min(batchSize, remaining);

  const candidates = await dbRead
    .select({
      id: pages.id,
      imagePrompt: pages.imagePrompt,
    })
    .from(pages)
    .where(and(
      gt(pages.imageImportance, ILLUSTRATION_IMPORTANCE_THRESHOLD),
      isNull(pages.imageUrl),
      isNotNull(pages.imagePrompt),
      eq(pages.bookId, bookId),
    ))
    .orderBy(desc(pages.imageImportance))
    .limit(effectiveBatch);

  console.log(`[generateBookIllustrations] 📋 Found ${candidates.length} candidate pages in book ${bookId}`);

  for (const candidate of candidates) {
    if (!candidate.imagePrompt) continue;

    stats.processed++;

    const result = await generatePageIllustration(
      candidate.id,
      candidate.imagePrompt,
      bookId,
      bookOwner?.userId ?? null,
    );

    if (result) {
      stats.generated++;
    } else {
      stats.failed++;
    }

    // Rate limit: 2 second delay between generations
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  return stats;
}
