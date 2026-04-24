/**
 * @summary Updates trending scores for all active books
 * @description Calculates and updates trendingScore based on engagement metrics with time decay
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
 * Idempotency:
 * - Safe to run multiple times: recalculates scores based on current data
 * - Uses atomic updates for consistency
 * 
 * Should be run daily via cron job
 */
import { dbWrite } from "../db/client.js";
import { books, userFavorites } from "../db/schema.js";
import { eq, count } from "drizzle-orm";
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
    
    // Get favorited counts for all books
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
    
    // Calculate and update trending scores
    let updatedCount = 0;
    for (const book of activeBooks) {
      const favoritedCount = favoritedMap.get(book.id) || 0;
      const decayFactor = getDecayFactor(book.createdAt);
      
      // Calculate trending score
      const trendingScore = (book.readCount * 0.5 + book.likesCount * 0.3 + favoritedCount * 0.2) * decayFactor;
      
      // Update the book
      await dbWrite
        .update(books)
        .set({ trendingScore })
        .where(eq(books.id, book.id));
      
      updatedCount++;
    }
    
    const durationMs = Date.now() - startedAt;
    console.log(`[trending-scores] ✅ Updated ${updatedCount} books in ${durationMs}ms`);
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
