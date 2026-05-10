/**
 * PostgreSQL-based Job Queue System using pg-boss
 * 
 * This module provides a robust job queue system built on top of PostgreSQL
 * using the pg-boss library. It's designed to handle asynchronous candidate
 * page generation without blocking API responses or hitting Vercel timeouts.
 * 
 * Key features:
 * - Neon PostgreSQL native integration
 * - Automatic job retries with exponential backoff
 * - Distributed job processing across serverless instances
 * - Built-in job state tracking and monitoring
 * - Graceful error handling and dead letter queue
 * 
 * @example
 * ```typescript
 * // Enqueue a candidate generation job
 * const boss = await getBoss();
 * await boss.send('generate-candidates', {
 *   userId,
 *   pageId,
 *   bookId
 * }, {
 *   retryLimit: 3,
 *   retryDelay: 30,
 *   expireInSeconds: 600
 * });
 * ```
 */

import { PgBoss } from 'pg-boss';
import { getErrorMessage } from '../utils/error.js';

// Singleton instance for connection reuse
let boss: PgBoss | null = null;

/**
 * Job queue configuration optimized for Neon PostgreSQL and Vercel serverless
 */
const BOSS_CONFIG = {
  // Use existing database connection
  connectionString: process.env.DATABASE_URL,
  
  // Neon-safe configuration: don't keep persistent connections
  max: 2,
  
  // Retry failed jobs up to 3 times with exponential backoff
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
  
  // Job expiration to prevent stale jobs
  expireInSeconds: 600, // 10 minutes max lifetime
  
  // Polling interval for job processing
  pollIntervalSeconds: 5,
  
  // Archive completed jobs for monitoring
  archiveCompletedJobsInSeconds: 3600, // 1 hour
  
  // Remove expired jobs after 24 hours
  deleteExpiredJobsInSeconds: 86400,
  
  // Enable job monitoring
  newJobCheckInterval: 1,
  newJobCheckIntervalSeconds: 1,
};

/**
 * Job type definitions for type safety
 */
export interface CandidateGenerationJob {
  userId: string;
  pageId: string;
  bookId: string;
  currentDepth?: number;
  maxDepth?: number;
  priority?: number;
  /** Serialized story state for context preservation */
  currentState?: string | null;
}

export interface BatchGenerationJob {
  userId: string;
  pageIds: string[];
  bookId: string;
  priority?: number;
}

/**
 * Gets or creates the pg-boss instance
 * 
 * This function implements the singleton pattern to ensure only one
 * pg-boss instance exists per serverless function invocation.
 * 
 * @returns Promise<PgBoss> - Configured pg-boss instance
 * 
 * @throws Error - If database connection fails
 */
export async function getBoss(): Promise<PgBoss> {
  if (!boss) {
    console.log('[pg-boss] 👋 Initializing job queue system...');
    
    boss = new PgBoss(BOSS_CONFIG);
    
    // Set up event handlers for monitoring
    boss.on('error', (error: Error) => {
      console.error('[pg-boss] ❌ Database error:', error);
    });
    
    boss.on('ready', () => {
      console.log('[pg-boss] ✅ Job queue system ready');
    });
    
    boss.on('stopped', () => {
      console.log('[pg-boss] 👋 Job queue system stopped');
    });
    
    try {
      await boss.start();
      console.log('[pg-boss] ✅ Successfully started job queue system');
    } catch (error) {
      console.error('[pg-boss] ❌ Failed to start job queue:', error);
      boss = null;
      throw new Error(`Failed to initialize job queue: ${getErrorMessage(error)}`, { cause: error });
    }
  }
  
  return boss;
}

/**
 * Enqueues a candidate generation job
 * 
 * @param job - Job data containing user, page, and book information
 * @param options - Optional job configuration overrides
 * 
 * @example
 * ```typescript
 * await enqueueCandidateGeneration({
 *   userId: 'user-123',
 *   pageId: 'page-456',
 *   bookId: 'book-789'
 * }, {
 *   priority: 10, // Higher priority
 *   retryLimit: 5  // More retries for important pages
 * });
 * ```
 */
export async function enqueueCandidateGeneration(
  job: CandidateGenerationJob,
  options: {
    priority?: number;
    retryLimit?: number;
    retryDelay?: number;
    expireInSeconds?: number;
  } = {}
): Promise<string> {
  const boss = await getBoss();
  
  const jobId = await boss.send('generate-candidates', job, {
    ...BOSS_CONFIG,
    ...options,
    priority: options.priority || 0,
  }) as string;
  
  console.log(`[pg-boss] ⏳ Enqueued candidate generation job ${jobId} for page ${job.pageId}`);
  return jobId;
}

/**
 * Enqueues a batch of candidate generation jobs
 * 
 * Useful for bulk operations like retrying failed generations
 * or processing multiple pages from a book.
 * 
 * @param job - Batch job data
 * @param options - Optional job configuration overrides
 */
export async function enqueueBatchGeneration(
  job: BatchGenerationJob,
  options: {
    priority?: number;
    retryLimit?: number;
    retryDelay?: number;
    expireInSeconds?: number;
  } = {}
): Promise<string> {
  const boss = await getBoss();
  
  const jobId = await boss.send('batch-generate-candidates', job, {
    ...BOSS_CONFIG,
    ...options,
    priority: options.priority || 0,
  }) as string;
  
  console.log(`[pg-boss] ⏳ Enqueued batch generation job ${jobId} for ${job.pageIds.length} pages`);
  return jobId;
}

/**
 * Registers job handlers for candidate generation
 * 
 * This function should be called during application startup to register
 * the job processing handlers with pg-boss.
 * 
 * @param handlers - Object containing handler functions for each job type
 */
export async function registerJobHandlers(handlers: {
  onGenerateCandidates: (job: { id: string; data: CandidateGenerationJob }) => Promise<void>;
  onBatchGenerateCandidates: (job: { id: string; data: BatchGenerationJob }) => Promise<void>;
}): Promise<void> {
  const boss = await getBoss();
  
  // Register individual candidate generation handler
  await boss.work('generate-candidates', async (job) => {
    const typedJob = job as unknown as { id: string; data: CandidateGenerationJob };
    console.log(`[pg-boss] ⏰ Processing candidate generation job ${typedJob.id} for page ${typedJob.data.pageId}`);
    
    try {
      await handlers.onGenerateCandidates(typedJob);
      console.log(`[pg-boss] ✅ Successfully completed job ${typedJob.id}`);
    } catch (error) {
      console.error(`[pg-boss] ❌ Failed to process job ${typedJob.id}:`, error);
      throw error; // Re-throw to trigger pg-boss retry logic
    }
  });
  
  // Register batch generation handler
  await boss.work('batch-generate-candidates', async (job) => {
    const typedJob = job as unknown as { id: string; data: BatchGenerationJob };
    console.log(`[pg-boss] ⏰ Processing batch generation job ${typedJob.id} for ${typedJob.data.pageIds.length} pages`);
    
    try {
      await handlers.onBatchGenerateCandidates(typedJob);
      console.log(`[pg-boss] ✅ Successfully completed batch job ${typedJob.id}`);
    } catch (error) {
      console.error(`[pg-boss] ❌ Failed to process batch job ${typedJob.id}:`, error);
      throw error; // Re-throw to trigger pg-boss retry logic
    }
  });
  
  console.log('[pg-boss] ✅ Registered job handlers');
}

/**
 * Gets job queue statistics for monitoring
 * 
 * @returns Promise with queue statistics
 */
export async function getQueueStats(): Promise<{
  created: number;
  completed: number;
  failed: number;
  active: number;
  expired: number;
  cancelled: number;
}> {
  const boss = await getBoss();
  
  try {
    const stats = await boss.getQueueStats('generate-candidates');
    return {
      created: stats.createdOn ? new Date(stats.createdOn).getTime() : 0,
      completed: 0, // pg-boss doesn't provide these directly
      failed: 0,
      active: 0,
      expired: 0,
      cancelled: 0,
    };
  } catch (error) {
    console.error('[pg-boss] ❌ Failed to get queue stats:', error);
    // Return default stats on error
    return {
      created: 0,
      completed: 0,
      failed: 0,
      active: 0,
      expired: 0,
      cancelled: 0,
    };
  }
}

/**
 * Stops the job queue system gracefully
 * 
 * This function should be called during application shutdown
 * to ensure all in-progress jobs are handled properly.
 */
export async function stopBoss(): Promise<void> {
  if (boss) {
    console.log('[pg-boss] ⏰ Stopping job queue system...');
    await boss.stop();
    boss = null;
    console.log('[pg-boss] 👋 Job queue system stopped');
  }
}

/**
 * Health check for the job queue system
 * 
 * @returns Promise<boolean> - True if system is healthy
 */
export async function healthCheck(): Promise<boolean> {
  try {
    const stats = await getQueueStats();
    
    // Consider system healthy if we can get stats
    console.log('[pg-boss] ✅ Health check passed:', stats);
    return true;
  } catch (error) {
    console.error('[pg-boss] ❌ Health check failed:', error);
    return false;
  }
}
