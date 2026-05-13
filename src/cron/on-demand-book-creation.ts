/**
 * On-Demand Book Creation Cron Job
 * 
 * Triggered by GitHub Actions workflow to create a book asynchronously.
 * This script runs in GitHub Actions environment with all necessary credentials.
 * 
 * Environment Variables:
 * - BOOK_ID: UUID v7 of the book to create
 * - USER_ID: User ID who requested the book
 * - THEME: Story theme
 * - MC_CANDIDATE_*: Optional main character details
 * - GENERATE_COVER_IMAGE: Whether to generate cover image
 */

import { initializeBook } from '../utils/prompt.js';
import { dbWrite } from '../db/client.js';
import { books } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { getErrorMessage } from '../utils/error.js';
import type { StoryMCCandidate } from '../types/character.js';
import { cleanupObject } from '../utils/parser.js';

async function notifyWorkflowWebhook(payload: { bookId: string; status: string; progress?: number; error?: string }) {
  try {
    const webhookUrl = process.env.WORKFLOW_WEBHOOK_URL || process.env.BACKEND_URL && `${process.env.BACKEND_URL.replace(/\/$/, '')}/api/books/workflow-webhook`;
    const secret = process.env.INTERNAL_SECRET;
    if (!webhookUrl || !secret) return;

    await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': secret,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.warn('[creation] ⚠️ Failed to notify workflow webhook:', err instanceof Error ? err.message : String(err));
  }
}

async function main() {
  const bookId = process.env.BOOK_ID;
  const userId = process.env.USER_ID;
  const theme = process.env.THEME;
  
  if (!bookId || !userId || !theme) {
    throw new Error('Missing required environment variables: BOOK_ID, USER_ID, THEME');
  }

  console.log('[creation] ⏰ Starting...', { bookId, userId, theme });

  try {
    // Update book status to 'generating'
    await dbWrite.update(books)
      .set({
        generationStatus: 'generating',
        // generationProgress: 10,
        generationStartedAt: new Date(),
      })
      .where(eq(books.id, bookId));

    console.log('[creation] ✒️ Status updated to generating');

    // Parse mcCandidate from environment variables
    const mcCandidate: StoryMCCandidate = cleanupObject({
      name: process.env.MC_CANDIDATE_NAME || undefined,
      age: process.env.MC_CANDIDATE_AGE ? parseInt(process.env.MC_CANDIDATE_AGE) : undefined,
      gender: process.env.MC_CANDIDATE_GENDER || undefined,
      bio: process.env.MC_CANDIDATE_BIO || undefined,
    });

    const generateCoverImage = process.env.GENERATE_COVER_IMAGE === 'true';

    // Initialize book (this is the long-running AI generation)
    // Pass bookId to update existing draft instead of creating duplicate
    let lastProgressSent = 0;
    const result = await initializeBook({
      userId,
      theme,
      mcCandidate: Object.keys(mcCandidate).length > 0 ? mcCandidate : undefined,
      generateCoverImage,
      bookId, // IMPORTANT: Pass bookId to update existing draft
      // Provide a lightweight percentage callback for logging and webhook notifications —
      // `initializeBook` persists progress to DB for drafts.
      onProgressPercent: async (percentage: number) => {
        console.log(`[creation] 🧩 Progress: ${percentage}%`);
        // Debounce webhook notifications to reduce requests: send on multiples of 10 or on completion
        if (percentage === 100 || percentage - lastProgressSent >= 10) {
          lastProgressSent = percentage;
          await notifyWorkflowWebhook({ bookId, status: 'generating', progress: percentage });
        }
      }
    });

    console.log('[creation] ✅ Book initialized successfully:', result);

    // Update book generation status (content already updated by initializeBook)
    await dbWrite.update(books)
      .set({
        generationStatus: 'completed',
        generationProgress: 100,
        generationCompletedAt: new Date(),
      })
      .where(eq(books.id, bookId));

    // Notify external webhook (if configured)
    await notifyWorkflowWebhook({ bookId, status: 'completed', progress: 100 });

    console.log('[creation] ✅ Book completed successfully');
  } catch (error) {
    console.error('[creation] ❌ Error:', getErrorMessage(error));
    
    // Update book status to 'failed'
    await dbWrite.update(books)
      .set({
        generationStatus: 'failed',
        generationError: getErrorMessage(error),
        generationCompletedAt: new Date(),
      })
      .where(eq(books.id, bookId));

    // Notify external webhook about failure
    await notifyWorkflowWebhook({ bookId, status: 'failed', error: getErrorMessage(error) });

    throw error;
  }
}

main().catch((error) => {
  console.error('[creation] Fatal error:', error);
  process.exit(1);
});
