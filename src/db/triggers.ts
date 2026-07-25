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
import { eq, sql } from "drizzle-orm";
import { dbWrite } from "./client.js";
import { getErrorMessage } from "../utils/error.js";
import { users } from "./schema.js";
import { generateId } from "../utils/uuid.js";
import { APP_EMAIL, APP_NAME, APP_NAME_SLUG, APP_TAGLINE } from "../config/constants.js";
import { hashPassword } from "../utils/password.js";
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
 * 1. Trigger fires BEFORE INSERT OR UPDATE on user_sessions table
 * 2. Whenever a row's status is (or becomes) 'active', deactivates all other
 *    active sessions for that user (i.e. sessions belonging to other books)
 * 3. Ensures data consistency without relying on application logic
 * 
 * Why INSERT must also be covered (not just UPDATE):
 * - `user_sessions.status` defaults to 'active' at the column level, so a
 *   brand-new session for a book the user has never opened before is
 *   inserted directly as 'active' — no UPDATE ever fires for that row. A
 *   BEFORE UPDATE-only trigger silently misses this case, letting a user
 *   end up with two simultaneously "active" sessions (their previous book,
 *   still active, plus the freshly-inserted one) until the next unrelated
 *   UPDATE happens to run and clean it up.
 * 
 * Idempotency:
 * - Uses DROP TRIGGER IF EXISTS and CREATE OR REPLACE FUNCTION
 * - Safe to run multiple times without errors
 * - Trigger only takes action when status is (or becomes) 'active'
 */
async function ensureUserSessionTrigger(): Promise<void> {
  try {
    // Create the trigger function
    await dbWrite.execute(`
      CREATE OR REPLACE FUNCTION deactivate_other_user_sessions()
      RETURNS TRIGGER AS $$
      BEGIN
        -- Whenever a row is (or becomes) 'active', deactivate every other
        -- active session this same user has for a different book.
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
    
    // Drop existing trigger(s) if they exist (covers the legacy UPDATE-only name too)
    await dbWrite.execute(`
      DROP TRIGGER IF EXISTS user_sessions_update_trigger ON user_sessions;
    `);
    await dbWrite.execute(`
      DROP TRIGGER IF EXISTS user_sessions_exclusivity_trigger ON user_sessions;
    `);
    
    // Create the trigger — now covers INSERT as well as UPDATE
    await dbWrite.execute(`
      CREATE TRIGGER user_sessions_exclusivity_trigger
        BEFORE INSERT OR UPDATE ON user_sessions
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
 * 1. INSERT — the `user_sessions_user_book_unique` constraint guarantees
 *    (user_id, book_id) is unique, so a fresh INSERT is *always* a brand-new
 *    unique reader for that book. We increment read_count/completion_rate/
 *    page-1 visit_count by 1 (O(1)) instead of re-scanning the whole table
 *    with COUNT(DISTINCT ...).
 * 2. UPDATE — an UPDATE on this table only ever represents a session status
 *    flip (active <-> past, see deactivate_other_user_sessions()), which can
 *    NEVER change the number of unique readers. We skip the count recompute
 *    entirely here and only bump trending_score, since re-engaging with a
 *    book (resuming or switching back to it) is still a meaningful trending
 *    signal — this preserves the original "hybrid approach" behavior while
 *    dropping the wasted full-table recompute that used to run on every
 *    single status flip.
 * 
 * Note: This counts unique users (distinct user_id), not total page visits.
 * Page 1 visit count is consolidated with book read count since every reader visits page 1.
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
        IF TG_OP = 'INSERT' THEN
          -- A new (user_id, book_id) row is guaranteed to be a brand-new
          -- unique reader (user_sessions_user_book_unique), so a plain +1
          -- is correct and avoids a full COUNT(DISTINCT) table scan.
          UPDATE books
          SET read_count = read_count + 1,
              completion_rate = CASE WHEN (read_count + 1) > 0 THEN
                ROUND(complete_count::numeric / (read_count + 1) * 100)
              ELSE NULL END,
              trending_score = trending_score + 0.5, -- Incremental update for hybrid approach
              updated_at = NOW()
          WHERE id = NEW.book_id;

          -- Update page 1's visit_count to match book's read_count
          -- Every book reader visits page 1, so visit_count tracks read_count
          SELECT id INTO v_page_1_id
          FROM pages
          WHERE book_id = NEW.book_id AND page = 1
          LIMIT 1;

          IF v_page_1_id IS NOT NULL THEN
            UPDATE pages
            SET visit_count = visit_count + 1,
                updated_at = NOW()
            WHERE id = v_page_1_id;
          END IF;

        ELSIF TG_OP = 'UPDATE' THEN
          -- Session status flips (active <-> past) never change the unique
          -- reader count, so only the trending signal needs a bump here.
          UPDATE books
          SET trending_score = trending_score + 0.5,
              updated_at = NOW()
          WHERE id = NEW.book_id;
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
  
  // Hash system password if provided in env (enables email/password login for system account)
  const systemPassword = process.env['SYSTEM_USER_PASSWORD'];
  let passwordHash: string | undefined;
  if (systemPassword) {
    passwordHash = await hashPassword(systemPassword);
  } else {
    console.warn("⚠️ SYSTEM_USER_PASSWORD not set — system account will not support password login.");
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
      passwordHash,
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
 * 2. Recomputes visit_count for whichever actionedPageId/nextPageId the NEW
 *    row currently points to (unique users)
 * 3. On UPDATE, ALSO recomputes visit_count for the OLD actionedPageId/
 *    nextPageId if they differ from the NEW ones. Without this, a page that
 *    a row's action/destination moves away from (e.g. when async candidate
 *    generation resolves a placeholder destination to its final page) is
 *    left with a stale, permanently-too-high visit_count — nothing else
 *    ever revisits it once the row stops pointing there.
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
        -- Recompute visit_count for the page(s) this row currently points to
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

        -- On UPDATE, if the row moved away from its previous actioned/next
        -- page, that old page's visit_count is now stale — recompute it too.
        IF TG_OP = 'UPDATE' THEN
          IF OLD.actioned_page_id IS NOT NULL AND OLD.actioned_page_id IS DISTINCT FROM NEW.actioned_page_id THEN
            UPDATE pages
            SET visit_count = (
              SELECT COUNT(DISTINCT user_id)
              FROM user_page_progress
              WHERE actioned_page_id = OLD.actioned_page_id
            ),
                updated_at = NOW()
            WHERE id = OLD.actioned_page_id;
          END IF;

          IF OLD.next_page_id IS NOT NULL AND OLD.next_page_id IS DISTINCT FROM NEW.next_page_id THEN
            UPDATE pages
            SET visit_count = (
              SELECT COUNT(DISTINCT user_id)
              FROM user_page_progress
              WHERE next_page_id = OLD.next_page_id
            ),
                updated_at = NOW()
            WHERE id = OLD.next_page_id;
          END IF;
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
    
    // Drop existing triggers if they exist (including the legacy split INSERT/DELETE names)
    await dbWrite.execute(`
      DROP TRIGGER IF EXISTS user_comments_insert_comments_trigger ON user_comments;
    `);
    await dbWrite.execute(`
      DROP TRIGGER IF EXISTS user_comments_delete_comments_trigger ON user_comments;
    `);
    await dbWrite.execute(`
      DROP TRIGGER IF EXISTS user_comments_count_trigger ON user_comments;
    `);
    
    // Create a single combined trigger — the function already branches on
    // TG_OP, so one AFTER INSERT OR DELETE trigger covers both cases
    // (previously this was two separate, identically-configured triggers)
    await dbWrite.execute(`
      CREATE TRIGGER user_comments_count_trigger
        AFTER INSERT OR DELETE ON user_comments
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
 * Note: Counts unique users (DISTINCT user_id) who completed the book — a
 * single user who discovers multiple distinct endings for the same book is
 * still only counted once here (books.complete_count answers "how many
 * people have finished this book at least once"). This is intentionally
 * different from `user_counters.books_completed`, which counts rows — i.e.
 * counts every unique ending discovered (see ensureUserCountersTriggers below).
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
      DECLARE
        v_complete_count INT;
      BEGIN
        SELECT COUNT(DISTINCT user_id) INTO v_complete_count
        FROM user_completed_books
        WHERE book_id = NEW.book_id;

        UPDATE books
        SET complete_count = v_complete_count,
            completion_rate = CASE WHEN read_count > 0 THEN
              ROUND(v_complete_count::numeric / read_count * 100)
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
 * Achievement Philosophy (see TODO-counter-trigger.md for the full discussion):
 * - Type A (Lifetime): Never decrease. The action happened once and the
 *   achievement stays earned even if the underlying row is later deleted,
 *   edited, or the entity it refers to is removed.
 *   (books_generated, pages_generated, books_completed, topup_credits,
 *   referred_users, branches_opened, custom_actions_written)
 * - Type B (Current): Fluctuates with live state — can go up AND down.
 *   (followers_count, pages_read)
 * - Type C (Maxima): Tracks the highest-ever value of a Type B metric; never
 *   decreases even though the Type B metric it's derived from can.
 *   (max_checkin_streak, derived alongside active_checkin_streak)
 *
 * Trigger map, calculation logic, and review notes:
 *  1. user_page_progress → pages_read (Type B)
 *     O(1) delta. The unique constraint on (user_id, book_id, actioned_page_id)
 *     guarantees every INSERT is a newly-read page for that user; every DELETE
 *     removes exactly one previously-read page. Kept as a fluctuating "current"
 *     metric (not lifetime) per the design discussion in TODO-counter-trigger.md.
 *  2. books → books_generated (Type A)
 *     +1 per book row a user creates. Deleting the book later doesn't revoke it.
 *  3. pages → pages_generated (Type A)
 *     +1 per page row "initiated" by a user.
 *  4. user_completed_books → books_completed (Type A)
 *     +1 per completion row. NOTE: one row = one *unique ending* discovered
 *     (see that table's unique constraint on user_id/book_id/page_id), so a
 *     user who finds 3 distinct endings in the same book increments this 3
 *     times. This intentionally differs from `books.complete_count`, which
 *     counts distinct users instead (see ensureBookCompleteCountTrigger
 *     above). If you want "distinct books finished" semantics here instead,
 *     scope the increment to only fire the first time a given
 *     (user_id, book_id) pair appears in this table.
 *  5. user_follows → followers_count (Type B)
 *     +1/-1 on follow/unfollow of the followed user (following_id).
 *  6. transactions → topup_credits (Type A)
 *     Sums `credits` for `type = 'purchase'` transactions. NOTE: this only
 *     observes the `transactions` table — credits granted via
 *     `subscription_transactions` (recurring subscription allocations) are
 *     NOT included. Add a mirroring trigger on that table if lifetime
 *     "credits acquired" should also include subscription credits.
 *  7. users → referred_users (Type A)
 *     +1 to the referrer when a new user signs up with referrer_id set, AND
 *     when an existing user's referrer_id is set later for the first time
 *     (NULL -> non-NULL via UPDATE — e.g. entering a referral code after
 *     signup, if your onboarding flow allows that). Assumes referrer_id,
 *     once non-NULL, is never reassigned to a *different* referrer — only
 *     INSERT and the initial NULL -> value UPDATE are counted, so a later
 *     change would not double-count or transfer credit.
 *  8. user_checkins → active_checkin_streak / max_checkin_streak (Type B / C)
 *     Recomputes both streaks from the user's full check-in history on every
 *     mutation. max_checkin_streak is clamped with GREATEST() so it can never
 *     drop even if a check-in row is later deleted (a fresh recompute over a
 *     smaller row set could otherwise produce a lower "all-time max", which
 *     would violate the Type C "never decreases" guarantee). NOTE: because
 *     this only runs when a check-in row changes, active_checkin_streak will
 *     not "decay" purely from time passing — if a user simply stops checking
 *     in, the stored value stays at its last computed streak until their next
 *     check-in event recomputes it. If the streak must reflect a break the
 *     moment a day is missed (not just on the next check-in), that requires a
 *     scheduled job or an on-read recalculation, since triggers only fire on
 *     data mutations.
 *  9. pages → branches_opened (Type A)
 *     +1 the first time a user opens a given branch_id *within a specific
 *     book*. Deliberately excludes the default 'main' branch_id, since every
 *     book starts there — it's the trunk story path, not a genuine fork, so
 *     it shouldn't count as "opening a branch". Uniqueness is scoped to
 *     (user_id, book_id, branch_id) rather than just (user_id, branch_id),
 *     because branch_id is only guaranteed unique *within* a book, not
 *     globally — the previous (user_id, branch_id)-only check meant a user's
 *     'main' page in their very first book counted as "opening a branch",
 *     while 'main' in every subsequent book silently did NOT (since a row
 *     with that user_id + branch_id='main' already existed from book #1).
 * 10. custom_actions → custom_actions_written (Type A)
 *     +1 when a custom action is inserted as 'allow', or updated into
 *     'allow' from a non-'allow' outcome (covers async moderation resolving
 *     a pending/rejected action into an approved one). NOTE: if a single row
 *     can flip allow -> reject -> allow again (e.g. an appealed moderation
 *     decision), this counts that one row twice. Treated as an acceptable
 *     rare edge case rather than guarded against; add a boolean
 *     "already counted" flag on custom_actions if strict per-row idempotency
 *     is required.
 *
 * Performance:
 * Uses O(1) increment/decrement deltas or indexed EXISTS checks instead of
 * full table COUNT() scans, wherever the underlying schema's unique
 * constraints make that safe.
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
    // Handles both:
    // - INSERT with referrer_id already set (referred at signup)
    // - UPDATE where referrer_id goes from NULL to a value (referral code
    //   entered after signup, if your onboarding flow allows that)
    // Assumes referrer_id is never reassigned from one non-NULL referrer to
    // a different one — only a NULL -> value transition is counted.
    await dbWrite.execute(`
      CREATE OR REPLACE FUNCTION update_referred_users() RETURNS TRIGGER AS $$
      BEGIN
        IF (TG_OP = 'INSERT' AND NEW.referrer_id IS NOT NULL) OR
           (TG_OP = 'UPDATE' AND OLD.referrer_id IS NULL AND NEW.referrer_id IS NOT NULL) THEN
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
        AFTER INSERT OR UPDATE ON users
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

        -- Compute ACTIVE streak (consecutive days counting back from the
        -- user's most recent check-in date — not necessarily "today"; see
        -- the staleness note in this function's block comment above)
        FOR rec IN SELECT DISTINCT date::date AS checkin_date FROM user_checkins WHERE user_id = target_user_id ORDER BY checkin_date DESC
        LOOP
          IF prev_date IS NULL THEN
            active_streak := 1;
          ELSIF prev_date = rec.checkin_date + 1 THEN
            active_streak := active_streak + 1;
          ELSE
            EXIT;
          END IF;
          prev_date := rec.checkin_date;
        END LOOP;

        -- Compute MAX streak (longest run of consecutive days ever)
        prev_date := NULL;
        FOR rec IN SELECT DISTINCT date::date AS checkin_date FROM user_checkins WHERE user_id = target_user_id ORDER BY checkin_date ASC
        LOOP
          IF prev_date IS NULL THEN
            current_streak := 1;
          ELSIF rec.checkin_date = prev_date + 1 THEN
            current_streak := current_streak + 1;
          ELSE
            current_streak := 1;
          END IF;

          IF current_streak > max_streak THEN
            max_streak := current_streak;
          END IF;
          prev_date := rec.checkin_date;
        END LOOP;

        -- Upsert counters. max_checkin_streak is clamped with GREATEST so a
        -- DELETE that shrinks the check-in history can never pull the
        -- all-time max streak back down (Type C: never decreases).
        INSERT INTO user_counters (user_id, active_checkin_streak, max_checkin_streak, updated_at)
        VALUES (target_user_id, active_streak, max_streak, NOW())
        ON CONFLICT (user_id) DO UPDATE SET
          active_checkin_streak = EXCLUDED.active_checkin_streak,
          max_checkin_streak = GREATEST(user_counters.max_checkin_streak, EXCLUDED.max_checkin_streak),
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
    // O(1) lookup to ensure we only increment the first time a user opens a
    // given branch_id *within a specific book*. Excludes the default 'main'
    // branch, since every book starts there — it's the trunk path, not a
    // deliberately-opened fork (see the fix note in the JSDoc block above).
    await dbWrite.execute(`
      CREATE OR REPLACE FUNCTION update_user_branches_opened() RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'INSERT' AND NEW.branch_id IS NOT NULL AND NEW.branch_id != 'main' THEN
          IF NOT EXISTS (
            SELECT 1 FROM pages
            WHERE user_id = NEW.user_id
              AND book_id = NEW.book_id
              AND branch_id = NEW.branch_id
              AND id != NEW.id
            LIMIT 1
          ) THEN
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
 * Fires AFTER INSERT OR UPDATE OR DELETE on `uploaded_images`:
 * - When a new row with `type = 'user'` is inserted, update the corresponding user's `image_url`.
 * - When an existing uploaded image is updated to `type = 'user'` or its `image_url` changes,
 *   update the user's `image_url` as well.
 * - When a `type = 'user'` row is deleted, or updated away from `type = 'user'`, clear the
 *   user's `image_url` (only if it still matches the removed upload, so a newer image set by
 *   a different row in the meantime isn't clobbered).
 *
 * NOTE (fixed during review): the DELETE-handling branch below previously existed in the
 * function body but could never run, because the trigger itself was only registered for
 * `AFTER INSERT OR UPDATE` — `DELETE` was missing from the trigger's event list. The function
 * logic was correct; only the trigger registration was incomplete.
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
        AFTER INSERT OR UPDATE OR DELETE ON uploaded_images
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
 * - Creates book read count / completion-rate trigger
 * - Creates book branches count increment/decrement triggers
 * - Creates page visit count trigger
 * - Creates book comments count trigger
 * - Creates book complete count / completion-rate trigger
 * - Creates all user_counters (achievement metric) sync triggers
 * - Creates user favorites cleanup trigger
 * - Creates uploaded-image -> user profile picture sync trigger
 * - Logs successful creation operations
 * - Handles errors gracefully with detailed logging
 * 
 * NOTE: `books.likes_count` currently has no corresponding trigger in this
 * file (an older version of this doc block mentioned one, but it doesn't
 * exist here) — confirm whether it's intentionally maintained by application
 * code, or whether it's a genuinely missing trigger that should follow the
 * same pattern as the other denormalized counts above.
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

    const mode = process.env['NODE_ENV'] || "development";
    console.log(`✅ All triggers created successfully in ${mode} mode!`);
  } catch (error) {
    console.error("❌ Failed to create triggers:", getErrorMessage(error));
    throw error;
  }
}

/**
 * Updates system user's password hash if null and SYSTEM_USER_PASSWORD is set
 * 
 * This enables re-running `pnpm db:triggers` to set the system account password
 * for an existing system user that was created before SYSTEM_USER_PASSWORD support
 * was added.
 * 
 * @returns Promise that resolves when the update is complete
 */
async function updateSystemUserPassword(): Promise<void> {
  const systemPassword = process.env['SYSTEM_USER_PASSWORD'];
  if (!systemPassword) {
    console.log("ℹ️ SYSTEM_USER_PASSWORD not set, skipping password update.");
    return;
  }

  const [systemUser] = await dbWrite
    .select({ userId: users.userId, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.username, APP_NAME_SLUG))
    .limit(1);

  if (!systemUser) {
    console.log("ℹ️ System user not found, skipping password update.");
    return;
  }

  if (systemUser.passwordHash) {
    console.log("ℹ️ System user already has a password hash, skipping update.");
    return;
  }

  const passwordHash = await hashPassword(systemPassword);
  await dbWrite
    .update(users)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(users.userId, systemUser.userId));

  console.log("✅ System user password hash updated successfully!");
}

/**
 * Main execution block for standalone script execution.
 * Initializes database triggers and creates initial Admin user when run directly.
 */
if (process.argv[1] === __filename) {
  (async () => {
    await ensureTriggers();
    console.log("✅ Database triggers initialization complete!");
    
    // Create initial Admin user (if users table is empty)
    const adminUser = await createInitialAdminUser();
    if (adminUser) {
      console.log("🕵️‍♂️ Created Admin user:", adminUser);
    }
    
    // Fill system user password hash if it's null (idempotent on re-run)
    await updateSystemUserPassword();
    
    process.exit(0);
  })().catch((err) => {
    console.error("❌ Database triggers initialization failed:", getErrorMessage(err));
    process.exit(1);
  });
}
