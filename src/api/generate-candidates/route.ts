/**
 * Vercel Background Function for Candidate Generation
 * 
 * Purpose: Extended timeout candidate generation for Vercel Hobby tier
 * Uses maxDuration=800 (13 minutes) to handle long-running AI generation
 * 
 * Security: Internal secret verification
 * Timeout: 800 seconds (max for Hobby tier)
 * 
 * This route is designed for fire-and-forget background processing
 * using waitUntil to ensure completion after response is sent.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { ensureCandidatesForPageWithStrategy } from '../../utils/candidate-generation.js';
import { getStoryState } from '../../services/story.js';
import { getBook, getPageFromDB, mapToUserStoryPage } from '../../services/book.js';
import { isValidUuid } from '../../utils/uuid.js';

/**
 * Maximum duration for this function (Vercel Hobby tier: up to 800s)
 */
export const maxDuration = 800; // seconds - 13 minutes 20 seconds

/**
 * POST /api/generate-candidates
 * 
 * Background candidate generation with extended timeout
 * 
 * Request body:
 * {
 *   userId: string,
 *   pageId: string,
 *   bookId?: string (optional)
 * }
 * 
 * Security: Requires INTERNAL_SECRET header
 */
export async function POST(req: NextRequest) {
  try {
    // Verify internal secret
    const internalSecret = req.headers.get('x-internal-secret');
    if (internalSecret !== process.env.INTERNAL_SECRET) {
      console.error('[generate-candidates] ❌ Invalid internal secret');
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Parse request body with error handling
    let parsedBody;
    try {
      parsedBody = await req.json();
    } catch (error) {
      console.error('[generate-candidates] ❌ Invalid JSON in request body:', error);
      return NextResponse.json(
        { error: 'Invalid JSON in request body' },
        { status: 400 }
      );
    }

    const { userId, pageId, bookId } = parsedBody;
    
    if (!userId || !pageId) {
      return NextResponse.json(
        { error: 'Missing required fields: userId, pageId' },
        { status: 400 }
      );
    }

    // Validate UUID format
    if (!isValidUuid(userId) || !isValidUuid(pageId)) {
      return NextResponse.json(
        { error: 'Invalid format for userId or pageId' },
        { status: 400 }
      );
    }

    console.log(`[generate-candidates] 🚀 Starting background generation for page ${pageId}`);
    // Note: any `userId` can trigger next page generation for any page, no need for dbPage.userId validation

    // Get page and context
    const dbPage = await getPageFromDB(pageId, { bookIdentifier: bookId });
    if (!dbPage) {
      return NextResponse.json(
        { error: 'Page not found' },
        { status: 404 }
      );
    }

    const userPage = await mapToUserStoryPage(dbPage, userId);
    const currentState = await getStoryState(dbPage.id, { 
      dbPage, 
      maxTraversalDepth: 1 
    });

    // Generate candidates with extended timeout
    const { actions } = await ensureCandidatesForPageWithStrategy({
      strategy: 'cron', // Use cron strategy for extended timeout
      userId,
      page: userPage,
      currentState,
      currentBook: bookId ? await getBook(bookId) : null,
      options: {
        timeoutMs: (maxDuration - 15) * 1000 // 15s buffer
      }
    });
    const originalActionsCount = actions.length;
    const visibleActionsCount = actions.filter(a => a.destination.pageId).length;
    const pendingAfter = originalActionsCount - visibleActionsCount;

    console.log(`[generate-candidates] ✅ Completed background generation (${visibleActionsCount}/${originalActionsCount}) for page ${pageId}`);

    return NextResponse.json({
      success: true,
      pageId,
      userId,
      originalActionsCount,
      visibleActionsCount,
      pendingAfter,
      generatedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('[generate-candidates] ❌ Background generation failed:', error);
    return NextResponse.json(
      { 
        error: 'Background generation failed',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}
