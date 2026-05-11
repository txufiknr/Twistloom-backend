/**
 * Vercel Cron API Route for Processing Candidate Generation Jobs
 * 
 * This endpoint is called by Vercel Cron to process candidate generation jobs
 * from the pg-boss queue. It runs daily (Hobby tier limitation) and processes up to 5 jobs
 * per invocation to stay within Vercel's free tier limits.
 * 
 * The cron job:
 * 1. Verifies the CRON_SECRET for security
 * 2. Fetches pending jobs from pg-boss
 * 3. Processes each job using the ensureCandidatesForPage function
 * 4. Marks jobs as completed or failed
 * 5. Returns processing statistics
 * 
 * @example
 * ```json
 * {
 *   "crons": [
 *     {
 *       "path": "/api/cron/process-candidate-jobs",
 *       "schedule": "1 * * * *"
 *     }
 *   ]
 * }
 * ```
 */

import { type NextRequest, NextResponse } from 'next/server';
import { getBoss, enqueueCandidateGeneration, type CandidateGenerationJob } from '../../../lib/pgboss.js';
import { getPageFromDB, mapToUserStoryPage } from '../../../services/book.js';
import { MAX_BRANCHING_PREGENERATION_DEPTH } from '../../../config/story.js';
import { dbWrite } from '../../../db/client.js';
import { getErrorMessage } from '../../../utils/error.js';
import { ensureCandidatesForPageWithStrategy } from '../../../utils/candidate-generation.js';
import type { StoryState } from '../../../types/story.js';

/**
 * Maximum number of jobs to process per cron invocation
 * 
 * This limit prevents exceeding Vercel's function duration limits
 * while still making good progress on the job queue.
 */
const MAX_JOBS_PER_RUN = 5;

/**
 * GET handler for cron job processing
 * 
 * @param req - NextRequest with cron secret verification
 * @returns NextResponse with processing statistics
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  console.log('[cron] Starting candidate job processing...');
  
  // Verify Vercel Cron secret for security
  const authHeader = req.headers.get('authorization');
  const expectedAuth = `Bearer ${process.env.CRON_SECRET}`;
  
  if (authHeader !== expectedAuth) {
    console.error('[cron] ⚠️ Unauthorized request - invalid auth header');
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }
  
  try {
    const boss = await getBoss();
    
    // Fetch up to MAX_JOBS_PER_RUN jobs from the queue
    const jobs = await boss.fetch('generate-candidates', { batchSize: MAX_JOBS_PER_RUN });
    
    if (!jobs || jobs.length === 0) {
      console.log('[cron] ✨ No jobs to process');
      return NextResponse.json({ 
        processed: 0,
        message: 'No jobs to process'
      });
    }
    
    console.log(`[cron] ⏰ Processing ${jobs.length} candidate generation jobs`);
    
    // Process all jobs in parallel for efficiency
    const processingPromises = jobs.map(async (job) => {
      const startTime = Date.now();
      
      try {
        const { userId, pageId, bookId, currentDepth = 1, maxDepth = MAX_BRANCHING_PREGENERATION_DEPTH, currentState: serializedState } = job.data as CandidateGenerationJob;
        
        console.log(`[cron] ⏰ Processing job ${job.id} for page ${pageId} (depth ${currentDepth}/${maxDepth})`);
        
        // Get page from database
        const dbPage = await getPageFromDB(pageId, { client: dbWrite, bookIdentifier: bookId });
        if (!dbPage) {
          throw new Error(`Page ${pageId} not found`);
        }
        
        // Map to user-facing page format
        const userPage = await mapToUserStoryPage(dbPage, userId);
        
        // Deserialize state if provided, otherwise use null for reconstruction
        let currentState: StoryState | null = null;
        if (serializedState) {
          try {
            currentState = JSON.parse(serializedState) as StoryState;
            console.log(`[cron] 🧩 Using provided state for job ${job.id}`);
          } catch (error) {
            console.warn(`[cron] ⚠️ Failed to deserialize state for job ${job.id}, will reconstruct:`, error);
            currentState = null;
          }
        } else {
          console.log(`[cron] 🧩 No state provided for job ${job.id}, will reconstruct from parent page`);
        }
        
        // Process candidate generation with state context
        await ensureCandidatesForPageWithStrategy({
          strategy: 'cron',
          userId,
          page: userPage,
          currentState,
          currentBook: null
        });
        
        // Mark job as completed
        await boss.complete('generate-candidates', job.id);
        
        const duration = Date.now() - startTime;
        console.log(`[cron] ✅ Completed job ${job.id} in ${duration}ms`);
        
        return { jobId: job.id, status: 'completed', duration };
        
      } catch (error) {
        const duration = Date.now() - startTime;
        console.error(`[cron] ❌ Failed job ${job.id} after ${duration}ms:`, error);
        
        // Mark job as failed (pg-boss will handle retries)
        const errorMessage = getErrorMessage(error);
        await boss.fail(job.id, errorMessage);
        
        return { 
          jobId: job.id, 
          status: 'failed', 
          duration, 
          error: errorMessage 
        };
      }
    });
    
    // Wait for all jobs to complete
    const results = await Promise.allSettled(processingPromises);
    
    // Calculate statistics
    const succeeded = results.filter(r => 
      r.status === 'fulfilled' && r.value.status === 'completed'
    ).length;
    
    const failed = results.filter(r => 
      r.status === 'rejected' || (r.status === 'fulfilled' && r.value.status === 'failed')
    ).length;
    
    const totalDuration = results.reduce((sum, result) => {
      if (result.status === 'fulfilled') {
        return sum + result.value.duration;
      }
      return sum;
    }, 0);
    
    console.log(`[cron] ✅ Batch complete: ${succeeded} succeeded, ${failed} failed, ${totalDuration}ms total`);
    
    return NextResponse.json({
      processed: jobs.length,
      succeeded,
      failed,
      totalDuration: `${totalDuration}ms`,
      averageDuration: jobs.length > 0 ? `${Math.round(totalDuration / jobs.length)}ms` : '0ms',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('[cron] Critical error in job processing:', error);
    
    return NextResponse.json(
      { 
        error: 'Internal server error',
        message: getErrorMessage(error),
        timestamp: new Date().toISOString()
      },
      { status: 500 }
    );
  }
}

/**
 * POST handler for manual job triggering (admin/testing)
 * 
 * This endpoint allows manual triggering of job processing for testing
 * or administrative purposes. It requires the same CRON_SECRET.
 * 
 * @param req - NextRequest with optional job parameters
 * @returns NextResponse with job enqueue result
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  // Verify authorization
  const authHeader = req.headers.get('authorization');
  const expectedAuth = `Bearer ${process.env.CRON_SECRET}`;
  
  if (authHeader !== expectedAuth) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }
  
  try {
    const body = await req.json();
    const { userId, pageId, bookId, priority = 10 } = body;
    
    if (!userId || !pageId || !bookId) {
      return NextResponse.json(
        { error: 'Missing required parameters: userId, pageId, bookId' },
        { status: 400 }
      );
    }
    
    // Enqueue the job with high priority
    const jobId = await enqueueCandidateGeneration({
      userId,
      pageId,
      bookId,
      priority
    }, {
      priority,
      retryLimit: 3,
      retryDelay: 30
    });
    
    console.log(`[cron] ⏰ Manually enqueued job ${jobId} for page ${pageId}`);
    
    return NextResponse.json({
      success: true,
      jobId,
      userId,
      pageId,
      bookId,
      priority,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('[cron] ❌ Error in manual job enqueue:', error);
    
    return NextResponse.json(
      { 
        error: 'Failed to enqueue job',
        message: getErrorMessage(error)
      },
      { status: 500 }
    );
  }
}
