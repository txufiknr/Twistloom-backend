/**
 * On-Demand Book Creation Cron Job
 * 
 * Triggered by GitHub Actions workflow to create a book asynchronously.
 * This script runs in GitHub Actions environment with all necessary credentials.
 * 
 * Environment Variables:
 * - BOOK_ID: UUID v7 of the book to create
 * 
 * The script retrieves theme, mcCandidate, generateCoverImage, and userId
 * from the bookGenerations table using the provided bookId.
 */

import { initializeBook } from '../utils/prompt.js';
import { getErrorMessage } from '../utils/error.js';
import { bookGenerations } from '../db/schema.js';
import { dbRead } from '../db/client.js';
import { eq } from 'drizzle-orm';
import { updateBookGenerationStatus } from '../services/book-creation.js';

// async function notifyWorkflowWebhook(payload: BookGenerationPayload) {
//   try {
//     const webhookUrl = process.env.WORKFLOW_WEBHOOK_URL || process.env.BACKEND_URL && `${process.env.BACKEND_URL.replace(/\/$/, '')}/api/books/workflow-webhook`;
//     const secret = process.env.INTERNAL_SECRET;
//     if (!webhookUrl || !secret) return;

//     await fetch(webhookUrl, {
//       method: 'POST',
//       headers: {
//         'Content-Type': 'application/json',
//         'x-internal-secret': secret,
//       },
//       body: JSON.stringify(payload),
//     });
//   } catch (err) {
//     console.warn('[creation] ⚠️ Failed to notify workflow webhook:', getErrorMessage(err));
//   }
// }

async function main() {
  const bookId = process.env.BOOK_ID;
  
  if (!bookId) {
    throw new Error('Missing required environment variable: BOOK_ID');
  }

  console.log('[creation] ⏰ Prepare to write the book:', bookId);

  try {
    // Fetch book generation data from database
    const generationData = await dbRead
      .select({
        userId: bookGenerations.userId,
        theme: bookGenerations.theme,
        mcCandidate: bookGenerations.mcCandidate,
        generateCoverImage: bookGenerations.generateCoverImage,
      })
      .from(bookGenerations)
      .where(eq(bookGenerations.bookId, bookId))
      .limit(1);

    if (!generationData.length) {
      throw new Error(`Book generation record not found for bookId: ${bookId}`);
    }

    const { userId, theme, mcCandidate, generateCoverImage } = generationData[0];

    if (!userId || !theme) {
      throw new Error(`Missing required fields in bookGenerations: userId=${userId}, theme=${theme}`);
    }

    console.log('[creation] ✒️ Writing the book...', { 
      bookId, 
      userId, 
      theme, 
      mcCandidate,
      generateCoverImage 
    });

    // Update book generation step to 'initializing'
    void updateBookGenerationStatus({ bookId, step: 'initializing' });

    // Initialize book (this is the long-running AI generation)
    // Pass bookId to update existing draft instead of creating duplicate
    const result = await initializeBook({
      userId,
      theme,
      mcCandidate: mcCandidate || undefined,
      generateCoverImage,
      bookId, // IMPORTANT: Pass bookId to update existing draft
    });

    console.log('[creation] ✅ Book initialized successfully:', result);

    // Update book generation status (content already updated by initializeBook)
    void updateBookGenerationStatus({ bookId, step: 'completed' });

    console.log('[creation] ✅ Book completed successfully');
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    console.error('[creation] ❌ Book generation error:', errorMessage);
    void updateBookGenerationStatus({ bookId, status: 'failed', error: errorMessage });
    throw error;
  }
}

main().catch((error) => {
  console.error('[creation] Fatal error:', error);
  process.exit(1);
});
