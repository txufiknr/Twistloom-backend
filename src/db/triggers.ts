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
 * Drops all existing database triggers in the public schema
 * 
 * This function removes all triggers from the database to ensure a clean state
 * before recreating them. It iterates through all triggers in the public schema
 * and drops them using dynamic SQL execution.
 * 
 * @returns Promise that resolves when all triggers are dropped
 * 
 * Behavior:
 * - Queries information_schema.triggers for all triggers in public schema
 * - Dynamically constructs and executes DROP TRIGGER statements
 * - Uses quote_ident() to safely escape trigger and table names
 * - Logs success or error details
 * 
 * Idempotency:
 * - Safe to run even if no triggers exist
 * - Handles cases where triggers might have already been dropped
 */
async function dropAllTriggers(): Promise<void> {
  try {
    await dbWrite.execute(sql`
      DO $$
      DECLARE
        r RECORD;
      BEGIN
        FOR r IN (
          SELECT
            t.tgname AS trigger_name,
            c.relname AS table_name
          FROM pg_trigger t
          JOIN pg_class c ON t.tgrelid = c.oid
          JOIN pg_namespace n ON c.relnamespace = n.oid
          WHERE n.nspname = 'public'
          AND NOT t.tgisinternal
        ) LOOP
          EXECUTE 'DROP TRIGGER IF EXISTS ' || quote_ident(r.trigger_name) || ' ON ' || quote_ident(r.table_name) || ' CASCADE';
        END LOOP;
      END $$;
    `);
    console.log("✅ Successfully deleted all existing triggers.");
  } catch (error) {
    console.error("❌ Error dropping triggers:", getErrorMessage(error));
    throw error;
  }
}

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
          WHERE user_id = NEW.user_id 
            AND book_id != NEW.book_id 
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
 * Creates trigger to update book read count and page 1 visit count based on unique users in user_sessions
 * 
 * This trigger fires AFTER INSERT OR UPDATE on user_sessions table:
 * 1. When a user starts or updates a session for a book
 * 2. Updates read_count to match unique users who have read this book
 * 3. Updates page 1's visit_count to match book's read_count (every reader visits page 1)
 * 4. Ensures denormalized counts stay synchronized
 * 
 * Note: This counts unique users (distinct user_id), not total page visits
 * Page 1 visit count is consolidated with book read count since every reader visits page 1
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
      DECLARE
        v_page_1_id UUID;
      BEGIN
        -- Update book read count
        UPDATE books
        SET read_count = (
          SELECT COUNT(DISTINCT user_id)
          FROM user_sessions
          WHERE book_id = NEW.book_id
        ),
            trending_score = trending_score + 0.5, -- Incremental update for hybrid approach
            updated_at = NOW()
        WHERE id = NEW.book_id;
        
        -- Update page 1's visit_count to match book's read_count
        -- Every book reader visits page 1, so visit_count = read_count
        SELECT id INTO v_page_1_id
        FROM pages
        WHERE book_id = NEW.book_id AND page = 1
        LIMIT 1;
        
        IF v_page_1_id IS NOT NULL THEN
          UPDATE pages
          SET visit_count = (
            SELECT COUNT(DISTINCT user_id)
            FROM user_sessions
            WHERE book_id = NEW.book_id
          ),
              updated_at = NOW()
          WHERE id = v_page_1_id;
        END IF;
        
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    
    // Drop existing triggers if they exist
    await dbWrite.execute(`
      DROP TRIGGER IF EXISTS user_sessions_read_trigger ON user_sessions;
    `);
    
    // Create the trigger on user_sessions
    await dbWrite.execute(`
      CREATE TRIGGER user_sessions_read_trigger
        AFTER INSERT OR UPDATE ON user_sessions
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
 * Creates trigger to update page visit count based on unique users in user_page_progress
 * 
 * This trigger fires AFTER INSERT OR UPDATE on user_page_progress table:
 * 1. When a user progresses to a new page (pages > 1)
 * 2. Updates visit_count for both actionedPageId and nextPageId to count unique users
 * 3. Ensures denormalized count stays synchronized for fast reads
 * 
 * Note: This counts unique users (distinct user_id) from user_page_progress
 * Page 1 visit count is handled by book read count trigger (every reader visits page 1)
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
        -- Update visit_count for actionedPageId (page where action was taken)
        IF NEW.actioned_page_id IS NOT NULL THEN
          UPDATE pages
          SET visit_count = (
            SELECT COUNT(DISTINCT user_id)
            FROM user_page_progress
            WHERE actioned_page_id = NEW.actioned_page_id
          ),
              updated_at = NOW()
          WHERE id = NEW.actioned_page_id;
        END IF;
        
        -- Update visit_count for nextPageId (destination page)
        IF NEW.next_page_id IS NOT NULL THEN
          UPDATE pages
          SET visit_count = (
            SELECT COUNT(DISTINCT user_id)
            FROM user_page_progress
            WHERE next_page_id = NEW.next_page_id
          ),
              updated_at = NOW()
          WHERE id = NEW.next_page_id;
        END IF;
        
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    
    // Drop existing triggers if they exist
    await dbWrite.execute(`
      DROP TRIGGER IF EXISTS user_page_progress_visit_trigger ON user_page_progress;
    `);
    
    // Create the trigger on user_page_progress
    await dbWrite.execute(`
      CREATE TRIGGER user_page_progress_visit_trigger
        AFTER INSERT OR UPDATE ON user_page_progress
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
 * Creates trigger to update book comments count when comments are inserted or deleted
 * 
 * This trigger fires AFTER INSERT OR DELETE on user_comments table:
 * 1. When a parent comment is added or removed (parent_comment_id IS NULL)
 * 2. Updates comments_count to match count of parent comments for the book
 * 3. Ensures denormalized count stays synchronized
 * 
 * Note: Only counts parent comments (parent_comment_id IS NULL), not replies
 * 
 * Idempotency:
 * - Uses CREATE OR REPLACE FUNCTION
 * - Safe to run multiple times without errors
 */
async function ensureBookCommentsCountTrigger(): Promise<void> {
  try {
    // Create the trigger function
    await dbWrite.execute(`
      CREATE OR REPLACE FUNCTION update_book_comments_count()
      RETURNS TRIGGER AS $$
      BEGIN
        -- Only update for parent comments (not replies)
        IF (TG_OP = 'INSERT' AND NEW.parent_comment_id IS NULL) OR
           (TG_OP = 'DELETE' AND OLD.parent_comment_id IS NULL) THEN
          UPDATE books
          SET comments_count = (
            SELECT COUNT(*)
            FROM user_comments
            WHERE book_id = COALESCE(NEW.book_id, OLD.book_id)
              AND parent_comment_id IS NULL
          ),
              updated_at = NOW()
          WHERE id = COALESCE(NEW.book_id, OLD.book_id);
        END IF;
        RETURN COALESCE(NEW, OLD);
      END;
      $$ LANGUAGE plpgsql;
    `);
    
    // Drop existing triggers if they exist
    await dbWrite.execute(`
      DROP TRIGGER IF EXISTS user_comments_insert_comments_trigger ON user_comments;
    `);
    await dbWrite.execute(`
      DROP TRIGGER IF EXISTS user_comments_delete_comments_trigger ON user_comments;
    `);
    
    // Create the triggers
    await dbWrite.execute(`
      CREATE TRIGGER user_comments_insert_comments_trigger
        AFTER INSERT ON user_comments
        FOR EACH ROW
        EXECUTE FUNCTION update_book_comments_count();
    `);
    
    await dbWrite.execute(`
      CREATE TRIGGER user_comments_delete_comments_trigger
        AFTER DELETE ON user_comments
        FOR EACH ROW
        EXECUTE FUNCTION update_book_comments_count();
    `);
    
    console.log("✅ Book comments count trigger created successfully!");
  } catch (error) {
    console.error("❌ Failed to create book comments count trigger:", getErrorMessage(error));
    throw error;
  }
}

/**
 * Creates trigger to update book complete count when users complete books
 * 
 * This trigger fires AFTER INSERT on user_completed_books table:
 * 1. When a user completes a book (reaches the last page)
 * 2. Updates complete_count to match unique users who completed the book
 * 3. Ensures denormalized count stays synchronized
 * 
 * Note: Counts unique users (DISTINCT user_id) who completed the book
 * 
 * Idempotency:
 * - Uses CREATE OR REPLACE FUNCTION
 * - Safe to run multiple times without errors
 */
async function ensureBookCompleteCountTrigger(): Promise<void> {
  try {
    // Create the trigger function for user_completed_books
    await dbWrite.execute(`
      CREATE OR REPLACE FUNCTION update_book_complete_count()
      RETURNS TRIGGER AS $$
      BEGIN
        UPDATE books
        SET complete_count = (
          SELECT COUNT(DISTINCT user_id)
          FROM user_completed_books
          WHERE book_id = NEW.book_id
        ),
            updated_at = NOW()
        WHERE id = NEW.book_id;
        
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    
    // Drop existing triggers if they exist
    await dbWrite.execute(`
      DROP TRIGGER IF EXISTS user_completed_books_complete_trigger ON user_completed_books;
    `);
    
    // Create the trigger on user_completed_books
    await dbWrite.execute(`
      CREATE TRIGGER user_completed_books_complete_trigger
        AFTER INSERT ON user_completed_books
        FOR EACH ROW
        EXECUTE FUNCTION update_book_complete_count();
    `);
    
    console.log("✅ Book complete count trigger created successfully!");
  } catch (error) {
    console.error("❌ Failed to create book complete count trigger:", getErrorMessage(error));
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
 * Creates trigger to delete from user_favorites when a book is unliked from user_likes
 *
 * This trigger fires AFTER DELETE on user_likes table:
 * 1. When a user unlikes a book (target_type = 'book')
 * 2. Deletes the corresponding entry from user_favorites for the same user+book
 * 3. Ensures consistency between likes and favorites
 *
 * Note: Only triggers when target_type is 'book' (not comments or users)
 *
 * Idempotency:
 * - Uses CREATE OR REPLACE FUNCTION
 * - Safe to run multiple times without errors
 */
async function ensureUserFavoritesCleanupTrigger(): Promise<void> {
  try {
    // Create the trigger function
    await dbWrite.execute(`
      CREATE OR REPLACE FUNCTION cleanup_user_favorites_on_unlike()
      RETURNS TRIGGER AS $$
      BEGIN
        -- Only process if the unliked item was a book
        IF OLD.target_type = 'book' THEN
          DELETE FROM user_favorites
          WHERE user_id = OLD.user_id
            AND book_id = OLD.target_id;
        END IF;
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // Drop existing trigger if it exists
    await dbWrite.execute(`
      DROP TRIGGER IF EXISTS user_likes_delete_favorites_trigger ON user_likes;
    `);

    // Create the trigger
    await dbWrite.execute(`
      CREATE TRIGGER user_likes_delete_favorites_trigger
        AFTER DELETE ON user_likes
        FOR EACH ROW
        EXECUTE FUNCTION cleanup_user_favorites_on_unlike();
    `);

    console.log("✅ User favorites cleanup trigger created successfully!");
  } catch (error) {
    console.error("❌ Failed to create user favorites cleanup trigger:", getErrorMessage(error));
    throw error;
  }
}

// /**
//  * Creates trigger to auto-update pendingGenerationCount based on actions
//  *
//  * This trigger fires BEFORE INSERT OR UPDATE on pages table:
//  * 1. When actions column is changed
//  * 2. Counts actions where destination.pageId is null
//  * 3. Updates pendingGenerationCount with that count
//  * 4. Ensures SSOT for pending generation tracking
//  *
//  * Idempotency:
//  * - Uses CREATE OR REPLACE FUNCTION
//  * - Safe to run multiple times without errors
//  */
// async function ensurePendingGenerationCountTrigger(): Promise<void> {
//   try {
//     // Create the trigger function
//     await dbWrite.execute(`
//       CREATE OR REPLACE FUNCTION update_pending_generation_count()
//       RETURNS TRIGGER AS $$
//       BEGIN
//         -- Count actions that do NOT have a valid, non-empty destinationPageIds array.
//         -- Explicitly handles all falsy cases:
//         --   - key absent         → action->'destinationPageIds' IS NULL
//         --   - key is JSON null   → jsonb_typeof = 'null'
//         --   - key is not array   → jsonb_typeof <> 'array'
//         --   - array is empty     → jsonb_array_length = 0
//         --
//         -- Without the IS NULL guard, NOT (NULL = 'array' AND ...) → NOT NULL → NULL,
//         -- which is falsy in WHERE, causing absent keys to never be counted.
//         NEW.pending_generation_count = (
//           SELECT COUNT(*)
//           FROM jsonb_array_elements(NEW.actions) AS action
//           WHERE (
//             (action->'destinationPageIds') IS NULL
//             OR jsonb_typeof(action->'destinationPageIds') <> 'array'
//             OR jsonb_array_length(action->'destinationPageIds') = 0
//           )
//         );
//         RETURN NEW;
//       END;
//       $$ LANGUAGE plpgsql;
//     `);

//     // Drop existing triggers if they exist
//     await dbWrite.execute(`
//       DROP TRIGGER IF EXISTS pages_insert_pending_count_trigger ON pages;
//     `);
//     await dbWrite.execute(`
//       DROP TRIGGER IF EXISTS pages_update_pending_count_trigger ON pages;
//     `);

//     // Create the triggers
//     await dbWrite.execute(`
//       CREATE TRIGGER pages_insert_pending_count_trigger
//         BEFORE INSERT ON pages
//         FOR EACH ROW
//         EXECUTE FUNCTION update_pending_generation_count();
//     `);

//     // No "OF actions" — fire on ALL updates so manual writes to
//     // pending_generation_count are always overridden by the actual count.
//     await dbWrite.execute(`
//       CREATE TRIGGER pages_update_pending_count_trigger
//         BEFORE UPDATE ON pages
//         FOR EACH ROW
//         EXECUTE FUNCTION update_pending_generation_count();
//     `);

//     console.log("✅ Pending generation count trigger created successfully!");
//   } catch (error) {
//     console.error("❌ Failed to create pending generation count trigger:", getErrorMessage(error));
//     throw error;
//   }
// }

// /**
//  * One-time backfill to correct pending_generation_count for rows that were
//  * written before the trigger fix. Safe to re-run (idempotent), but should
//  * only be called once from a migration script.
//  *
//  * Note: the BEFORE UPDATE trigger WILL fire for each updated row and recompute
//  * pending_generation_count from actions, which produces the same result as the
//  * explicit SET expression. The explicit computation is kept for clarity and to
//  * ensure correctness even if the trigger is temporarily disabled.
//  */
// export async function backfillPendingGenerationCount(): Promise<void> {
//   const { dbWrite } = await import("../db/client.js");

//   await dbWrite.execute(`
//     UPDATE pages
//     SET pending_generation_count = (
//       SELECT COUNT(*)
//       FROM jsonb_array_elements(actions) AS action
//       WHERE (
//         (action->'destinationPageIds') IS NULL
//         OR jsonb_typeof(action->'destinationPageIds') <> 'array'
//         OR jsonb_array_length(action->'destinationPageIds') = 0
//       )
//     )
//     WHERE pending_generation_count != (
//       SELECT COUNT(*)
//       FROM jsonb_array_elements(actions) AS action
//       WHERE (
//         (action->'destinationPageIds') IS NULL
//         OR jsonb_typeof(action->'destinationPageIds') <> 'array'
//         OR jsonb_array_length(action->'destinationPageIds') = 0
//       )
//     )
//   `);
//   console.log("✅ Backfilled pending_generation_count for mismatched rows");
// }

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
 * - Creates user favorites cleanup trigger
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
    // Drop all existing triggers first to ensure clean state
    await dropAllTriggers();

    // // Pre-fill correct pending generation count values
    // await backfillPendingGenerationCount();
    
    // Create user session exclusivity trigger
    await ensureUserSessionTrigger();

    // Create denormalization triggers for performance
    await ensureBookReadCountTrigger();
    await ensureBookBranchesIncrementTrigger();
    await ensureBookBranchesDecrementTrigger();
    await ensurePageVisitCountIncrementTrigger();
    await ensureBookCommentsCountTrigger();
    await ensureBookCompleteCountTrigger();

    // Create user favorites cleanup trigger
    await ensureUserFavoritesCleanupTrigger();

    // Clean up legacy triggers
    await dbWrite.execute(`
      DROP TRIGGER IF EXISTS pages_insert_pending_count_trigger ON pages;
      DROP TRIGGER IF EXISTS pages_update_pending_count_trigger ON pages;
      DROP FUNCTION IF EXISTS update_pending_generation_count();
    `);

    // // Create pending generation count trigger
    // await ensurePendingGenerationCountTrigger();

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
