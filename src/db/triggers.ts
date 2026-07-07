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
import { APP_EMAIL, APP_NAME, APP_NAME_SLUG, APP_TAGLINE } from "../config/constants.js";
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
            completion_rate = CASE WHEN (
              SELECT COUNT(DISTINCT user_id)
              FROM user_sessions
              WHERE book_id = NEW.book_id
            ) > 0 THEN
              ROUND(complete_count::numeric / (
                SELECT COUNT(DISTINCT user_id)
                FROM user_sessions
                WHERE book_id = NEW.book_id
              ) * 100)
            ELSE NULL END,
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
      email: APP_EMAIL,
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
  // -- In update_book_complete_count() (triggers.ts, ~line 470) — add after the complete_count UPDATE:
  // CREATE OR REPLACE FUNCTION update_book_complete_count()
  // RETURNS TRIGGER AS $$
  // BEGIN
  //   UPDATE books
  //   SET complete_count = (
  //         SELECT COUNT(DISTINCT user_id) FROM user_completed_books WHERE book_id = NEW.book_id
  //       ),
  //       completion_rate = CASE WHEN read_count > 0 THEN
  //         ROUND((SELECT COUNT(DISTINCT user_id) FROM user_completed_books WHERE book_id = NEW.book_id)::numeric / read_count * 100)
  //         ELSE NULL END,
  //       updated_at = NOW()
  //   WHERE id = NEW.book_id;
  //   RETURN NEW;
  // END;
  // $$ LANGUAGE plpgsql;

  // -- In update_book_read_count() (triggers.ts, ~line 144) — add after the read_count UPDATE:
  // CREATE OR REPLACE FUNCTION update_book_read_count()
  // RETURNS TRIGGER AS $$
  // DECLARE
  //   v_page_1_id UUID;
  // BEGIN
  //   UPDATE books
  //   SET read_count = (SELECT COUNT(DISTINCT user_id) FROM user_sessions WHERE book_id = NEW.book_id),
  //       completion_rate = CASE WHEN (SELECT COUNT(DISTINCT user_id) FROM user_sessions WHERE book_id = NEW.book_id) > 0 THEN
  //         ROUND(complete_count::numeric / (SELECT COUNT(DISTINCT user_id) FROM user_sessions WHERE book_id = NEW.book_id) * 100)
  //         ELSE NULL END,
  //       trending_score = trending_score + 0.5,
  //       updated_at = NOW()
  //   WHERE id = NEW.book_id;
  //   -- ...(page 1 visit_count block unchanged)
  // END;
  // $$ LANGUAGE plpgsql;
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
            completion_rate = CASE WHEN read_count > 0 THEN
              ROUND((
                SELECT COUNT(DISTINCT user_id)
                FROM user_completed_books
                WHERE book_id = NEW.book_id
              )::numeric / read_count * 100)
            ELSE NULL END,
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
 * Creates highly optimized delta triggers to keep the `user_counters`
 * denormalized table in sync with the source tables used by achievement metrics.
 *
 * Trigger map and calculation logic:
 *  1. user_page_progress → pages_read
 *     Counts the number of distinct `actioned_page_id` values for each user,
 *     so a user is counted once per page they have progressed through.
 *  2. books → books_generated
 *     Counts one generated book per inserted row for the owning user.
 *  3. pages → pages_generated
 *     Counts the total number of page rows owned by the user.
 *  4. user_completed_books → books_completed
 *     Counts one completed-book record per row for the owning user.
 *  5. user_follows → followers_count
 *     Counts the number of follow relationships pointing to the followed user.
 *  6. transactions → topup_credits
 *     Sums the `credits` value for purchase transactions belonging to the user.
 *  7. users → referred_users
 *     Counts how many users were referred by a given referrer.
 *  8. user_checkins → active_checkin_streak / max_checkin_streak
 *     Recomputes the streak from the latest consecutive daily check-ins.
 *  9. pages → branches_opened
 *     Counts the number of distinct branch IDs created by the user.
 * 10. custom_actions → custom_actions_written
 *     Counts accepted custom actions where `outcome = 'allow'`.
 *
 * Achievement Philosophy:
 * - Type A (Lifetime): Never decrease (books, pages gen, completed, topups, branches, custom actions).
 * - Type B (Current): Fluctuate based on state (followers, pages read, active streak).
 * - Type C (Maxima): Never decrease, tracks peaks (max checkin streak).
 * 
 * Performance:
 * Uses O(1) increment/decrement deltas or indexed EXISTS checks instead of full table COUNT() scans.
 */
export async function ensureUserCountersTriggers(): Promise<void> {
  try {
    console.log("⚙️ Ensuring user_counters DB triggers...");

    // ==========================================
    // 1. PAGES READ (Type B: Current State)
    // ==========================================
    // O(1) tracking. The unique constraint on user_page_progress guarantees
    // each insert is a uniquely read page for that book/user combo.
    await dbWrite.execute(`
      CREATE OR REPLACE FUNCTION update_user_pages_read() RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          INSERT INTO user_counters (user_id, pages_read, updated_at)
          VALUES (NEW.user_id, 1, NOW())
          ON CONFLICT (user_id) DO UPDATE SET
            pages_read = user_counters.pages_read + 1,
            updated_at = NOW();
          RETURN NEW;
        ELSIF TG_OP = 'DELETE' THEN
          UPDATE user_counters SET pages_read = GREATEST(0, pages_read - 1), updated_at = NOW() WHERE user_id = OLD.user_id;
          RETURN OLD;
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await dbWrite.execute(`DROP TRIGGER IF EXISTS user_page_progress_pages_read_trigger ON user_page_progress;`);
    await dbWrite.execute(`
      CREATE TRIGGER user_page_progress_pages_read_trigger
        AFTER INSERT OR DELETE ON user_page_progress
        FOR EACH ROW EXECUTE FUNCTION update_user_pages_read();
    `);
    console.log("✅ Trigger created: Pages Read (Current State)");

    // ==========================================
    // 2. BOOKS GENERATED (Type A: Lifetime)
    // ==========================================
    await dbWrite.execute(`
      CREATE OR REPLACE FUNCTION update_user_books_generated() RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          INSERT INTO user_counters (user_id, books_generated, updated_at) VALUES (NEW.user_id, 1, NOW())
          ON CONFLICT (user_id) DO UPDATE SET books_generated = user_counters.books_generated + 1, updated_at = NOW();
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await dbWrite.execute(`DROP TRIGGER IF EXISTS books_user_generated_trigger ON books;`);
    await dbWrite.execute(`
      CREATE TRIGGER books_user_generated_trigger
        AFTER INSERT ON books
        FOR EACH ROW EXECUTE FUNCTION update_user_books_generated();
    `);
    console.log("✅ Trigger created: Books Generated (Lifetime)");

    // ==========================================
    // 3. PAGES GENERATED (Type A: Lifetime)
    // ==========================================
    await dbWrite.execute(`
      CREATE OR REPLACE FUNCTION update_user_pages_generated() RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          INSERT INTO user_counters (user_id, pages_generated, updated_at)
          VALUES (NEW.user_id, 1, NOW())
          ON CONFLICT (user_id) DO UPDATE SET pages_generated = user_counters.pages_generated + 1, updated_at = NOW();
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await dbWrite.execute(`DROP TRIGGER IF EXISTS pages_user_pages_generated_trigger ON pages;`);
    await dbWrite.execute(`
      CREATE TRIGGER pages_user_pages_generated_trigger
        AFTER INSERT ON pages
        FOR EACH ROW EXECUTE FUNCTION update_user_pages_generated();
    `);
    console.log("✅ Trigger created: Pages Generated (Lifetime)");

    // ==========================================
    // 4. BOOKS COMPLETED (Type A: Lifetime)
    // ==========================================
    await dbWrite.execute(`
      CREATE OR REPLACE FUNCTION update_user_books_completed() RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          INSERT INTO user_counters (user_id, books_completed, updated_at) VALUES (NEW.user_id, 1, NOW())
          ON CONFLICT (user_id) DO UPDATE SET books_completed = user_counters.books_completed + 1, updated_at = NOW();
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await dbWrite.execute(`DROP TRIGGER IF EXISTS user_completed_books_trigger ON user_completed_books;`);
    await dbWrite.execute(`
      CREATE TRIGGER user_completed_books_trigger
        AFTER INSERT ON user_completed_books
        FOR EACH ROW EXECUTE FUNCTION update_user_books_completed();
    `);
    console.log("✅ Trigger created: Books Completed (Lifetime)");

    // ==========================================
    // 5. FOLLOWERS COUNT (Type B: Current State)
    // ==========================================
    await dbWrite.execute(`
      CREATE OR REPLACE FUNCTION update_user_followers_count() RETURNS TRIGGER AS $$
      BEGIN
        -- Targets following_id (the person being followed)
        IF TG_OP = 'INSERT' THEN
          INSERT INTO user_counters (user_id, followers_count, updated_at) VALUES (NEW.following_id, 1, NOW())
          ON CONFLICT (user_id) DO UPDATE SET followers_count = user_counters.followers_count + 1, updated_at = NOW();
          RETURN NEW;
        ELSIF TG_OP = 'DELETE' THEN
          UPDATE user_counters SET followers_count = GREATEST(0, followers_count - 1), updated_at = NOW() WHERE user_id = OLD.following_id;
          RETURN OLD;
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await dbWrite.execute(`DROP TRIGGER IF EXISTS user_follows_count_trigger ON user_follows;`);
    await dbWrite.execute(`
      CREATE TRIGGER user_follows_count_trigger
        AFTER INSERT OR DELETE ON user_follows
        FOR EACH ROW EXECUTE FUNCTION update_user_followers_count();
    `);
    console.log("✅ Trigger created: Followers Count (Current State)");

    // ==========================================
    // 6. TOPUP CREDITS (Type A: Lifetime)
    // ==========================================
    await dbWrite.execute(`
      CREATE OR REPLACE FUNCTION update_user_topup_credits() RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'INSERT' AND NEW.type = 'purchase' THEN
          INSERT INTO user_counters (user_id, topup_credits, updated_at) VALUES (NEW.user_id, NEW.credits, NOW())
          ON CONFLICT (user_id) DO UPDATE SET topup_credits = user_counters.topup_credits + NEW.credits, updated_at = NOW();
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await dbWrite.execute(`DROP TRIGGER IF EXISTS transactions_topup_trigger ON transactions;`);
    await dbWrite.execute(`
      CREATE TRIGGER transactions_topup_trigger
        AFTER INSERT ON transactions
        FOR EACH ROW EXECUTE FUNCTION update_user_topup_credits();
    `);
    console.log("✅ Trigger created: Topup Credits (Lifetime)");

    // ==========================================
    // 7. REFERRED USERS (Type A: Lifetime)
    // ==========================================
    await dbWrite.execute(`
      CREATE OR REPLACE FUNCTION update_referred_users() RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'INSERT' AND NEW.referrer_id IS NOT NULL THEN
          INSERT INTO user_counters (user_id, referred_users, updated_at) VALUES (NEW.referrer_id, 1, NOW())
          ON CONFLICT (user_id) DO UPDATE SET referred_users = user_counters.referred_users + 1, updated_at = NOW();
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await dbWrite.execute(`DROP TRIGGER IF EXISTS users_referral_trigger ON users;`);
    await dbWrite.execute(`
      CREATE TRIGGER users_referral_trigger
        AFTER INSERT ON users
        FOR EACH ROW EXECUTE FUNCTION update_referred_users();
    `);
    console.log("✅ Trigger created: Referred Users (Lifetime)");

    // ==========================================
    // 8. CHECK-IN STREAK (Type B/C: Recomputed State)
    // ==========================================
    await dbWrite.execute(`
      CREATE OR REPLACE FUNCTION update_user_checkin_streak()
      RETURNS TRIGGER AS $$
      DECLARE
        target_user_id UUID;
        active_streak INT := 0;
        max_streak INT := 0;
        current_streak INT := 0;
        prev_date DATE := NULL;
        rec RECORD;
      BEGIN
        target_user_id := COALESCE(NEW.user_id, OLD.user_id);

        -- Compute ACTIVE streak
        FOR rec IN SELECT DISTINCT date::date AS date FROM user_checkins WHERE user_id = target_user_id ORDER BY date DESC
        LOOP
          IF prev_date IS NULL THEN
            active_streak := 1;
          ELSIF prev_date = rec.date + 1 THEN
            active_streak := active_streak + 1;
          ELSE
            EXIT;
          END IF;
          prev_date := rec.date;
        END LOOP;

        -- Compute MAX streak
        prev_date := NULL;
        FOR rec IN SELECT DISTINCT date::date AS date FROM user_checkins WHERE user_id = target_user_id ORDER BY date ASC
        LOOP
          IF prev_date IS NULL THEN
            current_streak := 1;
          ELSIF rec.date = prev_date + 1 THEN
            current_streak := current_streak + 1;
          ELSE
            current_streak := 1;
          END IF;

          IF current_streak > max_streak THEN
            max_streak := current_streak;
          END IF;
          prev_date := rec.date;
        END LOOP;

        -- Upsert counters
        INSERT INTO user_counters (user_id, active_checkin_streak, max_checkin_streak, updated_at)
        VALUES (target_user_id, active_streak, max_streak, NOW())
        ON CONFLICT (user_id) DO UPDATE SET
          active_checkin_streak = EXCLUDED.active_checkin_streak,
          max_checkin_streak = EXCLUDED.max_checkin_streak,
          updated_at = NOW();

        RETURN COALESCE(NEW, OLD);
      END;
      $$ LANGUAGE plpgsql;
    `);
    await dbWrite.execute(`DROP TRIGGER IF EXISTS user_checkins_streak_trigger ON user_checkins;`);
    await dbWrite.execute(`
      CREATE TRIGGER user_checkins_streak_trigger
        AFTER INSERT OR UPDATE OR DELETE ON user_checkins
        FOR EACH ROW EXECUTE FUNCTION update_user_checkin_streak();
    `);
    console.log("✅ Trigger created: Check-in Streak (Current/Max State)");

    // ==========================================
    // 9. BRANCHES OPENED (Type A: Lifetime)
    // ==========================================
    // O(1) lookup to ensure we only increment if the user has NEVER opened this specific branch ID before.
    await dbWrite.execute(`
      CREATE OR REPLACE FUNCTION update_user_branches_opened() RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'INSERT' AND NEW.branch_id IS NOT NULL THEN
          IF NOT EXISTS (SELECT 1 FROM pages WHERE user_id = NEW.user_id AND branch_id = NEW.branch_id AND id != NEW.id LIMIT 1) THEN
            INSERT INTO user_counters (user_id, branches_opened, updated_at)
            VALUES (NEW.user_id, 1, NOW())
            ON CONFLICT (user_id) DO UPDATE SET
              branches_opened = user_counters.branches_opened + 1,
              updated_at = NOW();
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await dbWrite.execute(`DROP TRIGGER IF EXISTS pages_user_branches_opened_trigger ON pages;`);
    await dbWrite.execute(`
      CREATE TRIGGER pages_user_branches_opened_trigger
        AFTER INSERT ON pages
        FOR EACH ROW EXECUTE FUNCTION update_user_branches_opened();
    `);
    console.log("✅ Trigger created: Branches Opened (Lifetime)");

    // ==========================================
    // 10. CUSTOM ACTIONS WRITTEN (Type A: Lifetime)
    // ==========================================
    // Captures both instant 'allow' and asynchronous updates turning a 'reject/pending' into 'allow'.
    await dbWrite.execute(`
      CREATE OR REPLACE FUNCTION update_user_custom_actions_written() RETURNS TRIGGER AS $$
      BEGIN
        IF (TG_OP = 'INSERT' AND NEW.outcome = 'allow') OR 
           (TG_OP = 'UPDATE' AND OLD.outcome != 'allow' AND NEW.outcome = 'allow') THEN
          INSERT INTO user_counters (user_id, custom_actions_written, updated_at)
          VALUES (NEW.user_id, 1, NOW())
          ON CONFLICT (user_id) DO UPDATE SET
            custom_actions_written = user_counters.custom_actions_written + 1,
            updated_at = NOW();
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await dbWrite.execute(`DROP TRIGGER IF EXISTS custom_actions_written_trigger ON custom_actions;`);
    await dbWrite.execute(`
      CREATE TRIGGER custom_actions_written_trigger
        AFTER INSERT OR UPDATE ON custom_actions
        FOR EACH ROW EXECUTE FUNCTION update_user_custom_actions_written();
    `);
    console.log("✅ Trigger created: Custom Actions Written (Lifetime)");

    console.log("🎉 All user_counters DB triggers successfully deployed.");
  } catch (error) {
    console.error("❌ Failed to create user_counters triggers:", getErrorMessage(error));
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

/**
 * Creates trigger to set user's `image_url` when they upload a profile image
 *
 * Fires AFTER INSERT OR UPDATE on `uploaded_images`:
 * - When a new row with `type = 'user'` is inserted, update the corresponding user's `image_url`.
 * - When an existing uploaded image is updated to `type = 'user'` or its `image_url` changes,
 *   update the user's `image_url` as well.
 *
 * Idempotency:
 * - Uses CREATE OR REPLACE FUNCTION and DROP TRIGGER IF EXISTS so it's safe to run multiple times.
 */
async function ensureUploadedUserImageTrigger(): Promise<void> {
  try {
    await dbWrite.execute(`
      CREATE OR REPLACE FUNCTION set_user_image_url_from_upload()
      RETURNS TRIGGER AS $$
      BEGIN
        -- Insert or update where upload is a profile image: set users.image_url to the new URL
        IF (TG_OP = 'INSERT' AND NEW.type = 'user') OR
           (TG_OP = 'UPDATE' AND NEW.type = 'user' AND (
              OLD.image_id IS DISTINCT FROM NEW.image_id OR
              OLD.image_url IS DISTINCT FROM NEW.image_url OR
              OLD.type IS DISTINCT FROM NEW.type
           )) THEN
          UPDATE users
          SET image_url = NEW.image_url,
              updated_at = NOW()
          WHERE user_id = NEW.user_id;

        -- Handle delete: if a user-uploaded image row is removed, clear the user's image_url
        ELSIF TG_OP = 'DELETE' AND OLD.type = 'user' THEN
          UPDATE users
          SET image_url = NULL,
              updated_at = NOW()
          WHERE user_id = OLD.user_id
            AND (users.image_url IS NOT DISTINCT FROM OLD.image_url);

        -- Handle update-away-from-'user': if an upload was changed from type 'user' to something else,
        -- clear the user's image_url only if it still matches the old upload's URL
        ELSIF TG_OP = 'UPDATE' AND OLD.type = 'user' AND NEW.type IS DISTINCT FROM 'user' THEN
          UPDATE users
          SET image_url = NULL,
              updated_at = NOW()
          WHERE user_id = OLD.user_id
            AND (users.image_url IS NOT DISTINCT FROM OLD.image_url);
        END IF;
        RETURN COALESCE(NEW, OLD);
      END;
      $$ LANGUAGE plpgsql;
    `);

    await dbWrite.execute(`DROP TRIGGER IF EXISTS uploaded_images_user_update_trigger ON uploaded_images;`);

    await dbWrite.execute(`
      CREATE TRIGGER uploaded_images_user_update_trigger
        AFTER INSERT OR UPDATE ON uploaded_images
        FOR EACH ROW
        EXECUTE FUNCTION set_user_image_url_from_upload();
    `);

    console.log("✅ Uploaded user image -> users.image_url trigger created successfully!");
  } catch (error) {
    console.error("❌ Failed to create uploaded_images -> users.image_url trigger:", getErrorMessage(error));
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

    // Create user session exclusivity trigger
    await ensureUserSessionTrigger();

    // Create denormalization triggers for performance
    await ensureBookReadCountTrigger();
    await ensureBookBranchesIncrementTrigger();
    await ensureBookBranchesDecrementTrigger();
    await ensurePageVisitCountIncrementTrigger();
    await ensureBookCommentsCountTrigger();
    await ensureBookCompleteCountTrigger();

    // Create user_counters synchronization triggers
    await ensureUserCountersTriggers();

    // Create user favorites cleanup trigger
    await ensureUserFavoritesCleanupTrigger();

    // Update user's profile image when they upload an image with type 'user'
    await ensureUploadedUserImageTrigger();

    // Clean up legacy triggers
    await dbWrite.execute(`
      DROP TRIGGER IF EXISTS pages_insert_pending_count_trigger ON pages;
      DROP TRIGGER IF EXISTS pages_update_pending_count_trigger ON pages;
      DROP FUNCTION IF EXISTS update_pending_generation_count();
    `);

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
