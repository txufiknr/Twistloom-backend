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
 * Creates trigger to increment book likes count when a user likes a book
 * 
 * This trigger fires AFTER INSERT on user_likes table:
 * 1. When a user likes a book (target_type = 'book')
 * 2. Increments the likes_count column in books table
 * 3. Ensures denormalized count stays synchronized
 * 
 * Idempotency:
 * - Uses CREATE OR REPLACE FUNCTION
 * - Safe to run multiple times without errors
 */
async function ensureBookLikesIncrementTrigger(): Promise<void> {
  try {
    // Create the trigger function
    await dbWrite.execute(`
      CREATE OR REPLACE FUNCTION increment_book_likes_count()
      RETURNS TRIGGER AS $$
      BEGIN
        -- Only increment for book likes
        IF NEW.target_type = 'book' THEN
          UPDATE books 
          SET likes_count = likes_count + 1,
              updated_at = NOW()
          WHERE id = NEW.target_id;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    
    // Drop existing trigger if it exists
    await dbWrite.execute(`
      DROP TRIGGER IF EXISTS user_likes_insert_trigger ON user_likes;
    `);
    
    // Create the trigger
    await dbWrite.execute(`
      CREATE TRIGGER user_likes_insert_trigger
        AFTER INSERT ON user_likes
        FOR EACH ROW
        EXECUTE FUNCTION increment_book_likes_count();
    `);
    
    console.log("✅ Book likes increment trigger created successfully!");
  } catch (error) {
    console.error("❌ Failed to create book likes increment trigger:", getErrorMessage(error));
    throw error;
  }
}

/**
 * Creates trigger to decrement book likes count when a user unlikes a book
 * 
 * This trigger fires AFTER DELETE on user_likes table:
 * 1. When a user unlikes a book (target_type = 'book')
 * 2. Decrements the likes_count column in books table
 * 3. Ensures denormalized count stays synchronized
 * 
 * Idempotency:
 * - Uses CREATE OR REPLACE FUNCTION
 * - Safe to run multiple times without errors
 */
async function ensureBookLikesDecrementTrigger(): Promise<void> {
  try {
    // Create the trigger function
    await dbWrite.execute(`
      CREATE OR REPLACE FUNCTION decrement_book_likes_count()
      RETURNS TRIGGER AS $$
      BEGIN
        -- Only decrement for book likes
        IF OLD.target_type = 'book' THEN
          UPDATE books 
          SET likes_count = GREATEST(likes_count - 1, 0),
              updated_at = NOW()
          WHERE id = OLD.target_id;
        END IF;
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql;
    `);
    
    // Drop existing trigger if it exists
    await dbWrite.execute(`
      DROP TRIGGER IF EXISTS user_likes_delete_trigger ON user_likes;
    `);
    
    // Create the trigger
    await dbWrite.execute(`
      CREATE TRIGGER user_likes_delete_trigger
        AFTER DELETE ON user_likes
        FOR EACH ROW
        EXECUTE FUNCTION decrement_book_likes_count();
    `);
    
    console.log("✅ Book likes decrement trigger created successfully!");
  } catch (error) {
    console.error("❌ Failed to create book likes decrement trigger:", getErrorMessage(error));
    throw error;
  }
}

/**
 * Creates trigger to increment book read count when a user starts a session
 * 
 * This trigger fires AFTER INSERT on user_sessions table:
 * 1. When a user creates a reading session for a book
 * 2. Increments the read_count column in books table
 * 3. Ensures denormalized count stays synchronized
 * 
 * Note: This counts unique reads (sessions), not page views
 * 
 * Idempotency:
 * - Uses CREATE OR REPLACE FUNCTION
 * - Safe to run multiple times without errors
 */
async function ensureBookReadCountTrigger(): Promise<void> {
  try {
    // Create the trigger function
    await dbWrite.execute(`
      CREATE OR REPLACE FUNCTION increment_book_read_count()
      RETURNS TRIGGER AS $$
      BEGIN
        UPDATE books 
        SET read_count = read_count + 1,
            updated_at = NOW()
        WHERE id = NEW.book_id;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    
    // Drop existing trigger if it exists
    await dbWrite.execute(`
      DROP TRIGGER IF EXISTS user_sessions_insert_trigger ON user_sessions;
    `);
    
    // Create the trigger
    await dbWrite.execute(`
      CREATE TRIGGER user_sessions_insert_trigger
        AFTER INSERT ON user_sessions
        FOR EACH ROW
        EXECUTE FUNCTION increment_book_read_count();
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
async function createInitialAdminUser(): Promise<any> {
  // Check if users table is empty
  const [existingUsers] = await dbWrite
    .select({ count: sql<number>`count(*)` })
    .from(users);
  
  if (existingUsers.count > 0) {
    console.log("ℹ️ Users table not empty, skipping initial Admin user creation.");
    return null;
  }
  
  const adminUserId = generateId();
  
  const [createdUser] = await dbWrite
    .insert(users)
    .values({
      userId: adminUserId,
      name: "Admin",
    })
    .returning();
  
  console.log("✅ Initial Admin user created successfully!");
  return createdUser;
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
    await ensureBookLikesIncrementTrigger();
    await ensureBookLikesDecrementTrigger();
    await ensureBookReadCountTrigger();

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
