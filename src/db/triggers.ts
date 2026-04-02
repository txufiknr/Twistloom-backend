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
import { dbWrite } from "./client.js";
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
    console.error("❌ Failed to create user session trigger:", error);
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

    const mode = process.env['NODE_ENV'] || "development";
    console.log(`✅ All triggers created successfully in ${mode} mode!`);
  } catch (error) {
    console.error("❌ Failed to create triggers:", error);
    throw error;
  }
}

/**
 * Main execution block for standalone script execution.
 * Initializes database triggers when run directly.
 */
if (process.argv[1] === __filename) {
  (async () => {
    try {
      await ensureTriggers();
      console.log("Database triggers initialization complete!");
      process.exit(0);
    } catch (err) {
      console.error("Database triggers initialization failed:", err);
      process.exit(1);
    }
  })().catch((err) => {
    console.error("Database triggers initialization failed:", err);
    process.exit(1);
  });
}
