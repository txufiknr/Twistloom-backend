/**
 * @summary Updates trending scores for all active books
 * @description Normalizes trending scores and applies time decay
 *
 * Hybrid Approach:
 * - Incremental updates: Engagement events (likes, reads, favorites) update trendingScore immediately
 * - Hourly recalc: This job normalizes scores to prevent drift and applies time decay
 *
 * Formula:
 * trendingScore = (readCount * 0.5 + likesCount * 0.3 + favoritedCount * 0.2) * timeDecayFactor
 *
 * Time decay:
 * - Books created in last 7 days: 1.0 (full score)
 * - Books created 7-30 days ago: 0.8
 * - Books created 30-90 days ago: 0.5
 * - Books created 90+ days ago: 0.2
 *
 * Note: Time decay is based on book age (creation date), not update frequency.
 * Hourly normalization prevents drift from incremental updates, but decay factors
 * remain independent of update frequency for consistent aging behavior.
 *
 * Idempotency:
 * - Safe to run multiple times: recalculates scores based on current data
 * - Uses atomic updates for consistency
 *
 * Should be run hourly via cron job
 */
import { dbWrite } from "../db/client.js";
import { books, userFavorites } from "../db/schema.js";
import { eq, sql, count } from "drizzle-orm";
import { getErrorMessage } from "../utils/error.js";

const DECAY_RANGES = [
  { days: 7, factor: 1.0 },    // Last 7 days: full score
  { days: 30, factor: 0.8 },   // 7-30 days: 80% score
  { days: 90, factor: 0.5 },   // 30-90 days: 50% score
  { days: Infinity, factor: 0.2 }, // 90+ days: 20% score
] as const;

/**
 * Calculates time decay factor based on book creation date
 */
function getDecayFactor(createdAt: Date): number {
  const daysSinceCreation = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
  
  for (const range of DECAY_RANGES) {
    if (daysSinceCreation < range.days) {
      return range.factor;
    }
  }
  return DECAY_RANGES[DECAY_RANGES.length - 1].factor;
}

/**
 * Updates trending scores for all active books
 * 
 * Uses parameterized SQL template with CASE statement for secure bulk updates.
 * Processes books in chunks to handle large datasets efficiently.
 * 
 * Security:
 * - Uses Drizzle's sql template tag with parameter binding (not string interpolation)
 * - No sql.raw() usage - all values are properly parameterized
 * 
 * Performance:
 * - Single bulk UPDATE with CASE statement per chunk (not N+1 queries)
 * - Chunking prevents query size limits for large datasets
 * 
 * Idempotency:
 * - Safe to run multiple times: recalculates scores based on current data
 * - Uses atomic updates for consistency
 * 
 * Should be run daily via cron job
 */
export async function updateTrendingScores(): Promise<void> {
  const startedAt = Date.now();
  
  try {
    console.log("[trending-scores] 📊 Starting trending score update...");
    
    // Get all active books with their engagement metrics
    const activeBooks = await dbWrite
      .select({
        id: books.id,
        readCount: books.readCount,
        likesCount: books.likesCount,
        createdAt: books.createdAt,
      })
      .from(books)
      .where(eq(books.status, 'active'));
    
    console.log(`[trending-scores] 📚 Processing ${activeBooks.length} active books...`);
    
    if (activeBooks.length === 0) {
      console.log("[trending-scores] ✅ No active books to process");
      return;
    }
    
    // Get favorited counts for all books in a single query
    const favoritedCounts = await dbWrite
      .select({
        bookId: userFavorites.bookId,
        favoritedCount: count(userFavorites.userId).as('favoritedCount'),
      })
      .from(userFavorites)
      .groupBy(userFavorites.bookId);
    
    // Create a map for quick lookup
    const favoritedMap = new Map(
      favoritedCounts.map(f => [f.bookId, Number(f.favoritedCount)])
    );
    
    // Calculate trending scores for all books
    const updates = activeBooks.map(book => {
      const favoritedCount = favoritedMap.get(book.id) || 0;
      const decayFactor = getDecayFactor(book.createdAt);
      const trendingScore = (book.readCount * 0.5 + book.likesCount * 0.3 + favoritedCount * 0.2) * decayFactor;
      return {
        id: book.id,
        trendingScore,
      };
    });
    
    // Batch update books in chunks of 100 to avoid query size limits
    const CHUNK_SIZE = 100;
    let totalUpdated = 0;
    
    for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
      const chunk = updates.slice(i, i + CHUNK_SIZE);
      
      // Build parameterized CASE statement for single bulk update
      // Using sql template tag with parameter binding (secure, not sql.raw)
      const caseExpressions = chunk.map(u => 
        sql`WHEN ${u.id}::uuid THEN ${u.trendingScore}`
      );
      
      await dbWrite.execute(sql`
        UPDATE books 
        SET trending_score = CASE id 
          ${sql.join(caseExpressions, sql`\n          `)}
          ELSE trending_score 
        END,
        updated_at = NOW()
        WHERE id IN (${sql.join(chunk.map(u => u.id), sql`, `)})
      `);
      
      totalUpdated += chunk.length;
    }
    
    const durationMs = Date.now() - startedAt;
    console.log(`[trending-scores] ✅ Updated ${totalUpdated} books in ${durationMs}ms`);
  } catch (error) {
    console.error("[trending-scores] ❌ Failed to update trending scores:", getErrorMessage(error));
    throw error;
  }
}

/**
 * Main execution function for trending scores cron job
 */
async function main(): Promise<void> {
  const startedAt = Date.now();
  
  try {
    await updateTrendingScores();
    const durationMs = Date.now() - startedAt;
    console.log(`[trending-scores] ✅ Completed in ${durationMs}ms`);
    process.exit(0);
  } catch (error) {
    console.error("[trending-scores] ❌ Trending scores update failed:", getErrorMessage(error));
    process.exit(1);
  }
}

/**
 * Ensure unhandled async failures terminate the process.
 * Important for GitHub Actions correctness.
 */
process.on("unhandledRejection", (reason) => {
  console.error("[trending-scores] Unhandled promise rejection", reason);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  console.error("[trending-scores] Uncaught exception", getErrorMessage(error));
  process.exit(1);
});

void main();
