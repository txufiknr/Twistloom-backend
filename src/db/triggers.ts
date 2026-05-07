/**
 * @overview Database Triggers Module
 * 
 * Creates and manages database triggers for automated data consistency.
 * Provides idempotent trigger creation with proper error handling.
 * 
 * Features:
 * - User session management triggers
 * - Automatic status updates for session exclusivity
 * - Idempotent operations using DROP TRIGGER IF EXISTS
 * - Environment-aware logging and error handling
 */

import { fileURLToPath } from "url";
import { sql } from "drizzle-orm";
import { dbWrite } from "./client.js";
import { getErrorMessage } from "../utils/error.js";
import { users } from "./schema.js";
import { generateId } from "../utils/uuid.js";
import { APP_NAME, APP_NAME_SLUG, APP_TAGLINE } from "../config/constants.js";
import type { DBUser } from "../types/schema.js";
const __filename = fileURLToPath(import.meta.url);

/**
 * Creates database trigger for user session exclusivity
 * 
 * This trigger ensures only one active session per user:
 * 1. Trigger fires BEFORE UPDATE on user_sessions table
 * 2. When status is set to 'active', deactivates all other sessions for that user
 * 3. Ensures data consistency without relying on application logic
 * 
 * Idempotency:
 * - Uses DROP TRIGGER IF EXISTS and CREATE OR REPLACE FUNCTION
 * - Safe to run multiple times without errors
 * - Trigger only fires when status is being changed to 'active'
 */
async function ensureUserSessionTrigger(): Promise<void> {
  try {
    // Create the trigger function
    await dbWrite.execute(`
      CREATE OR REPLACE FUNCTION deactivate_other_user_sessions()
      RETURNS TRIGGER AS $$
      BEGIN
        -- When status is being set to 'active', update all other sessions for this user to 'past'
        IF NEW.status = 'active' THEN
          UPDATE user_sessions 
          SET status = 'past', updated_at = NOW()
          WHERE userId = NEW.userId 
            AND bookId != NEW.bookId 
            AND status = 'active';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    
    // Drop existing trigger if it exists
    await dbWrite.execute(`
      DROP TRIGGER IF EXISTS user_sessions_update_trigger ON user_sessions;
    `);
    
    // Create the trigger
    await dbWrite.execute(`
      CREATE TRIGGER user_sessions_update_trigger
        BEFORE UPDATE ON user_sessions
        FOR EACH ROW
        EXECUTE FUNCTION deactivate_other_user_sessions();
    `);
    
    console.log("✅ User session exclusivity trigger created successfully!");
  } catch (error) {
    console.error("❌ Failed to create user session trigger:", getErrorMessage(error));
    throw error;
  }
}

/**
 * Creates trigger to update book read count based on unique users in userPageProgress
 * 
 * This trigger fires AFTER INSERT OR UPDATE on user_page_progress table:
 * 1. When a user progresses in a book (any page visit)
 * 2. Updates read_count to match unique users who have read this book
 * 3. Ensures denormalized count stays synchronized
 * 
 * Note: This counts unique users (distinct user_id), not total page visits
 * 
 * Idempotency:
 * - Uses CREATE OR REPLACE FUNCTION
 * - Safe to run multiple times without errors
 */
async function ensureBookReadCountTrigger(): Promise<void> {
  try {
    // Create the trigger function
    await dbWrite.execute(`
      CREATE OR REPLACE FUNCTION update_book_read_count()
      RETURNS TRIGGER AS $$
      BEGIN
        UPDATE books
        SET read_count = (
          SELECT COUNT(DISTINCT user_id)
          FROM user_page_progress
          WHERE book_id = NEW.book_id
        ),
            trending_score = trending_score + 0.5, -- Incremental update for hybrid approach
            updated_at = NOW()
        WHERE id = NEW.book_id;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    
    // Drop existing triggers if they exist
    await dbWrite.execute(`
      DROP TRIGGER IF EXISTS user_page_progress_insert_trigger ON user_page_progress;
    `);
    await dbWrite.execute(`
      DROP TRIGGER IF EXISTS user_page_progress_update_trigger ON user_page_progress;
    `);
    await dbWrite.execute(`
      DROP TRIGGER IF EXISTS user_sessions_insert_trigger ON user_sessions;
    `);
    
    // Create the trigger for user_page_progress
    await dbWrite.execute(`
      CREATE TRIGGER user_page_progress_insert_trigger
        AFTER INSERT ON user_page_progress
        FOR EACH ROW
        EXECUTE FUNCTION update_book_read_count();
    `);
    
    await dbWrite.execute(`
      CREATE TRIGGER user_page_progress_update_trigger
        AFTER UPDATE ON user_page_progress
        FOR EACH ROW
        EXECUTE FUNCTION update_book_read_count();
    `);
    
    console.log("✅ Book read count trigger created successfully!");
  } catch (error) {
    console.error("❌ Failed to create book read count trigger:", getErrorMessage(error));
    throw error;
  }
}

/**
 * Creates initial Admin user in the database
 * 
 * Creates a default admin user with name "Admin" only if the users table is empty.
 * This user can be used for system administration and testing purposes.
 * 
 * @returns Promise that resolves with the created user object or null if table not empty
 * 
 * Behavior:
 * - Checks if users table is empty
 * - Generates a unique userId using generateId()
 * - Inserts user with name "Admin" only if table is empty
 * - Returns the complete user object from database or null
 */
async function createInitialAdminUser(): Promise<DBUser | null> {
  // Check if users table is empty
  const [existingUsers] = await dbWrite
    .select({ count: sql<number>`count(*)` })
    .from(users);
  
  if (existingUsers.count > 0) {
    console.log("ℹ️ Users table not empty, skipping initial Admin user creation.");
    return null;
  }
  
  const [createdUser] = await dbWrite
    .insert(users)
    .values({
      userId: generateId(),
      username: APP_NAME_SLUG,
      name: APP_NAME,
      penName: APP_NAME,
      bio: APP_TAGLINE,
    })
    .returning();
  
  console.log("✅ Initial Admin user created successfully!");
  return createdUser;
}

/**
 * Creates trigger to increment book branches count when a new branch is created
 * 
 * This trigger fires AFTER INSERT on pages table:
 * 1. When a page is inserted with a new branch_id for a book
 * 2. Increments the branches_count column in books table
 * 3. Ensures denormalized count stays synchronized
 * 
 * Performance Considerations:
 * - Uses NOT EXISTS subquery to check branch uniqueness
 * - Monitor trigger execution time in production, especially with millions of pages
 * - If performance degrades, consider:
 *   - Adding an index on (book_id, branch_id) to speed up the subquery
 *   - Using a materialized view for branch counts with periodic recalculation
 *   - Moving to a batch update approach for high-volume scenarios
 * 
 * Idempotency:
 * - Uses CREATE OR REPLACE FUNCTION
 * - Safe to run multiple times without errors
 */
async function ensureBookBranchesIncrementTrigger(): Promise<void> {
  try {
    // Create the trigger function
    await dbWrite.execute(`
      CREATE OR REPLACE FUNCTION increment_book_branches_count()
      RETURNS TRIGGER AS $$
      BEGIN
        -- Check if book_id is not NULL before processing
        IF NEW.book_id IS NOT NULL THEN
          -- Check if this branch_id is new for this book
          IF NOT EXISTS (
            SELECT 1 FROM pages 
            WHERE book_id = NEW.book_id 
              AND branch_id = NEW.branch_id 
              AND id != NEW.id
            LIMIT 1
          ) THEN
            UPDATE books 
            SET branches_count = branches_count + 1,
                updated_at = NOW()
            WHERE id = NEW.book_id;
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    
    // Drop existing trigger if it exists
    await dbWrite.execute(`
      DROP TRIGGER IF EXISTS pages_insert_branch_trigger ON pages;
    `);
    
    // Create the trigger
    await dbWrite.execute(`
      CREATE TRIGGER pages_insert_branch_trigger
        AFTER INSERT ON pages
        FOR EACH ROW
        EXECUTE FUNCTION increment_book_branches_count();
    `);
    
    console.log("✅ Book branches increment trigger created successfully!");
  } catch (error) {
    console.error("❌ Failed to create book branches increment trigger:", getErrorMessage(error));
    throw error;
  }
}

/**
 * Creates trigger to increment page visit count when a user visits a page
 * 
 * This trigger fires AFTER INSERT on user_page_progress table:
 * 1. When a user progresses to a new page (next_page_id is set)
 * 2. Increments the visit_count column in pages table for that page
 * 3. Ensures denormalized count stays synchronized for fast reads
 * 
 * Note: This counts total page visits (not unique visitors)
 * 
 * Idempotency:
 * - Uses CREATE OR REPLACE FUNCTION
 * - Safe to run multiple times without errors
 */
async function ensurePageVisitCountIncrementTrigger(): Promise<void> {
  try {
    // Create the trigger function
    await dbWrite.execute(`
      CREATE OR REPLACE FUNCTION increment_page_visit_count()
      RETURNS TRIGGER AS $$
      BEGIN
        -- Only increment if next_page_id is set (user actually visited the page)
        IF NEW.next_page_id IS NOT NULL THEN
          UPDATE pages
          SET visit_count = visit_count + 1,
              updated_at = NOW()
          WHERE id = NEW.next_page_id;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    
    // Drop existing trigger if it exists
    await dbWrite.execute(`
      DROP TRIGGER IF EXISTS user_page_progress_visit_trigger ON user_page_progress;
    `);
    
    // Create the trigger
    await dbWrite.execute(`
      CREATE TRIGGER user_page_progress_visit_trigger
        AFTER INSERT ON user_page_progress
        FOR EACH ROW
        EXECUTE FUNCTION increment_page_visit_count();
    `);
    
    console.log("✅ Page visit count increment trigger created successfully!");
  } catch (error) {
    console.error("❌ Failed to create page visit count increment trigger:", getErrorMessage(error));
    throw error;
  }
}

/**
 * Creates trigger to decrement book branches count when the last page of a branch is deleted
 * 
 * This trigger fires AFTER DELETE on pages table:
 * 1. When a page is deleted
 * 2. Check if this was the last page with this branch_id for the book
 * 3. Decrements the branches_count column in books table if so
 * 4. Ensures denormalized count stays synchronized
 * 
 * Performance Considerations:
 * - Uses NOT EXISTS subquery to check if branch still exists
 * - Monitor trigger execution time in production, especially with millions of pages
 * - If performance degrades, consider:
 *   - Adding an index on (book_id, branch_id) to speed up the subquery
 *   - Using a materialized view for branch counts with periodic recalculation
 *   - Moving to a batch update approach for high-volume scenarios
 * 
 * Idempotency:
 * - Uses CREATE OR REPLACE FUNCTION
 * - Safe to run multiple times without errors
 */
async function ensureBookBranchesDecrementTrigger(): Promise<void> {
  try {
    // Create the trigger function
    await dbWrite.execute(`
      CREATE OR REPLACE FUNCTION decrement_book_branches_count()
      RETURNS TRIGGER AS $$
      BEGIN
        -- Check if book_id is not NULL before processing
        IF OLD.book_id IS NOT NULL THEN
          -- Check if this was the last page with this branch_id for this book
          IF NOT EXISTS (
            SELECT 1 FROM pages 
            WHERE book_id = OLD.book_id 
              AND branch_id = OLD.branch_id 
            LIMIT 1
          ) THEN
            UPDATE books 
            SET branches_count = GREATEST(branches_count - 1, 0),
                updated_at = NOW()
            WHERE id = OLD.book_id;
          END IF;
        END IF;
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql;
    `);
    
    // Drop existing trigger if it exists
    await dbWrite.execute(`
      DROP TRIGGER IF EXISTS pages_delete_branch_trigger ON pages;
    `);
    
    // Create the trigger
    await dbWrite.execute(`
      CREATE TRIGGER pages_delete_branch_trigger
        AFTER DELETE ON pages
        FOR EACH ROW
        EXECUTE FUNCTION decrement_book_branches_count();
    `);
    
    console.log("✅ Book branches decrement trigger created successfully!");
  } catch (error) {
    console.error("❌ Failed to create book branches decrement trigger:", getErrorMessage(error));
    throw error;
  }
}

/**
 * Creates all necessary database triggers
 * 
 * Sets up triggers for automated data consistency and business logic enforcement.
 * Runs idempotently and provides comprehensive error handling.
 * 
 * @returns Promise that resolves when all triggers are created
 * 
 * Behavior:
 * - Creates user session exclusivity trigger
 * - Creates book likes count increment/decrement triggers
 * - Creates book read count increment trigger
 * - Creates book branches count increment/decrement triggers
 * - Logs successful creation operations
 * - Handles errors gracefully with detailed logging
 * 
 * Idempotency:
 * - Safe to run multiple times without errors
 * - Uses DROP IF EXISTS for existing triggers
 * - Preserves existing functionality while updating logic
 */
export async function ensureTriggers(): Promise<void> {
  console.log("\nCreating database triggers...");

  try {
    // Create user session exclusivity trigger
    await ensureUserSessionTrigger();

    // Create denormalization triggers for performance
    await ensureBookReadCountTrigger();
    await ensureBookBranchesIncrementTrigger();
    await ensureBookBranchesDecrementTrigger();
    await ensurePageVisitCountIncrementTrigger();

    const mode = process.env['NODE_ENV'] || "development";
    console.log(`✅ All triggers created successfully in ${mode} mode!`);
  } catch (error) {
    console.error("❌ Failed to create triggers:", getErrorMessage(error));
    throw error;
  }
}

/**
 * Main execution block for standalone script execution.
 * Initializes database triggers and creates initial Admin user when run directly.
 */
if (process.argv[1] === __filename) {
  (async () => {
    await ensureTriggers();
    console.log("✅ Database triggers initialization complete!");
    
    // Create initial Admin user
    const adminUser = await createInitialAdminUser();
    console.log("🕵️‍♂️ Created Admin user:", adminUser);
    
    process.exit(0);
  })().catch((err) => {
    console.error("❌ Database triggers initialization failed:", getErrorMessage(err));
    process.exit(1);
  });
}
