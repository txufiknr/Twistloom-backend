/**
 * Background Generation Service
 * 
 * Provides fire-and-forget pattern for immediate background candidate generation
 * using the dedicated /api/generate-candidates route with extended timeout.
 * 
 * This service eliminates code duplication and provides a consistent interface
 * for triggering background generation across different parts of the application.
 */

import { APP_WEB_URL } from '../config/constants.js';
import { getEnv, requireEnv } from '../utils/env.js';

/**
 * Triggers immediate background candidate generation using fire-and-forget pattern
 * 
 * This function uses Next.js `after` to ensure the background request continues
 * processing even after the main response has been sent to the client.
 * 
 * @param params - Background generation parameters
 * @param params.userId - User ID for whom to generate candidates
 * @param params.pageId - Page ID for which to generate candidates
 * @param params.bookId - Book ID containing the page (optional but recommended)
 * @param params.context - Context for logging (defaults to 'background-generation')
 * 
 * @returns Promise<void> - Fire-and-forget pattern (no waiting)
 * 
 * @example
 * ```typescript
 * // In book creation
 * void triggerBackgroundGeneration({
 *   userId: 'user123',
 *   pageId: 'page456',
 *   bookId: 'book789',
 *   context: 'initializeBook'
 * });
 * 
 * // In candidate generation route
 * void triggerBackgroundGeneration({
 *   userId: 'user123',
 *   pageId: 'page456',
 *   bookId: 'book789',
 *   context: 'GET /candidates'
 * });
 * ```
 */
export async function triggerBackgroundGeneration(params: {
  userId: string;
  pageId: string;
  bookId?: string;
  context?: string;
}): Promise<void> {
  const { userId, pageId, bookId, context = 'background-generation' } = params;

  try {
    // Validate required environment variables
    const vercelUrl = getEnv('VERCEL_URL', APP_WEB_URL);
    const internalSecret = requireEnv('INTERNAL_SECRET');

    // const { after } = await import('next/server');
    const { waitUntil } = await import('@vercel/functions');

    // Immediate background generation with fire-and-forget pattern
    waitUntil(
      fetch(`${vercelUrl}/api/generate-candidates`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'x-internal-secret': internalSecret
        },
        body: JSON.stringify({ 
          userId, 
          pageId, 
          bookId: bookId || undefined
        }),
      })
    );

    console.log(`[${context}] 🚀 Fired background generation for page ${pageId} (user: ${userId}${bookId ? `, book: ${bookId}` : ''})`);

  } catch (error) {
    console.error(`[${context}] ❌ Failed to trigger background generation:`, error);
    // Don't rethrow - this is fire-and-forget pattern
  }
}
