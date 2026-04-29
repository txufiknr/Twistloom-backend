/**
 * @overview Database Extensions Module
 * 
 * Creates and manages database extensions for enhanced functionality.
 * Provides idempotent extension creation with proper error handling.
 * 
 * Features:
 * - pg_trgm extension for trigram-based text search
 * - Enables efficient ILIKE searches with leading wildcards
 * - Idempotent operations using CREATE EXTENSION IF NOT EXISTS
 * - Environment-aware logging and error handling
 */

import { fileURLToPath } from "url";
import { dbWrite } from "./client.js";
import { getErrorMessage } from "../utils/error.js";

const __filename = fileURLToPath(import.meta.url);

/**
 * Creates pg_trgm extension for trigram-based text search
 * 
 * This extension enables:
 * 1. GIN indexes with gin_trgm_ops operator class
 * 2. Efficient ILIKE searches with leading wildcards (%pattern%)
 * 3. Trigram similarity functions and operators
 * 
 * Required for:
 * - books.title GIN index for explore endpoint search
 * - books.hook GIN index for explore endpoint search  
 * - books.summary GIN index for explore endpoint search
 * 
 * Idempotency:
 * - Uses CREATE EXTENSION IF NOT EXISTS
 * - Safe to run multiple times without errors
 * - Extension creation is a one-time operation per database
 */
async function ensurePgTrgmExtension(): Promise<void> {
  try {
    await dbWrite.execute(`
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
    `);
    
    console.log("✅ pg_trgm extension created successfully!");
  } catch (error) {
    console.error("Failed to create pg_trgm extension:", getErrorMessage(error));
    throw error;
  }
}

/**
 * Creates all necessary database extensions
 * 
 * Sets up extensions for enhanced database functionality.
 * Runs idempotently and provides comprehensive error handling.
 * 
 * @returns Promise that resolves when all extensions are created
 * 
 * Behavior:
 * - Creates pg_trgm extension for text search
 * - Logs successful creation operations
 * - Handles errors gracefully with detailed logging
 * 
 * Idempotency:
 * - Safe to run multiple times without errors
 * - Uses IF NOT EXISTS for existing extensions
 * - Preserves existing functionality while updating logic
 */
export async function ensureExtensions(): Promise<void> {
  console.log("\n⏳ Creating database extensions...");

  try {
    // Create pg_trgm extension for text search
    await ensurePgTrgmExtension();

    const mode = process.env['NODE_ENV'] || "development";
    console.log(`✅ All extensions created successfully in ${mode} mode!`);
  } catch (error) {
    console.error("❌ Failed to create extensions:", getErrorMessage(error));
    throw error;
  }
}

/**
 * Main execution block for standalone script execution.
 * Initializes database extensions when run directly.
 */
if (process.argv[1] === __filename) {
  (async () => {
    await ensureExtensions();
    console.log("✅ Database extensions initialization complete!");
    process.exit(0);
  })().catch((err) => {
    console.error("❌ Database extensions initialization failed:", getErrorMessage(err));
    process.exit(1);
  });
}
