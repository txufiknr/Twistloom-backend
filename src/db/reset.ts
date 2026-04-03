/**
 * @overview Database Reset Module
 * 
 * Provides complete database reset functionality for development and testing.
 * Safely drops all tables with cascade deletion for clean database state.
 * This also drops Drizzle's tracking tables, allowing migrations to be re-applied fresh.
 * 
 * Features:
 * - Complete table removal with CASCADE constraints
 * - Production safety checks to prevent accidental data loss
 * - Comprehensive logging and error handling
 * - Idempotent operation using IF EXISTS clauses
 * - Clears migration tracking
 * 
 * Security:
 * - Production environment protection with explicit error
 * - Cascade deletion ensures complete cleanup
 * - Safe table dropping with proper SQL quoting
 */

import { db } from "./client.js";
import { sql } from "drizzle-orm";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);

/**
 * Drops all tables in the public schema for complete database reset.
 * Uses cascade deletion to handle foreign key constraints automatically.
 * 
 * @returns Promise that resolves when all tables are dropped
 * 
 * Behavior:
 * - Iterates through all tables in public schema
 * - Drops each table with CASCADE to handle dependencies
 * - Uses quote_ident for safe SQL identifier handling
 * - Provides comprehensive logging and error handling
 * 
 * Warning:
 * - Use only in development/testing environments
 * - Ensure you have database backups if needed
 * - All data will be permanently lost
 */
export async function resetDatabase() {
  console.log("Starting database reset... 🔄");
  
  try {
    await db.execute(sql`
      DO $$ DECLARE
        r RECORD;
      BEGIN
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
          EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
        END LOOP;
      END $$;
    `);
    
    // Also clear drizzle migration tracking
    await db.execute(sql`
      DROP TABLE IF EXISTS "drizzle"."__drizzle_migrations" CASCADE;
    `);
    
    console.log("All tables dropped successfully! ✅");
  } catch (error) {
    console.error("Failed to drop tables:", getErrorMessage(error));
    throw error;
  }
}

/**
 * Main execution block for standalone script execution.
 * Provides production safety checks and database reset when run directly.
 * 
 * Warning:
 * - This will permanently delete all tables and data
 * - Never run in production environment
 * - Operation cannot be reversed
 */
if (process.argv[1] === __filename) {
  // 1. Check production environment protection
  if (process.env['NODE_ENV'] === "production") {
    throw new Error("Database reset is not allowed in production environment.");
  }
  
  (async () => {
    try {
      // 2. Execute database reset operation
      await resetDatabase();

      // 3. Operation successful
      process.exit(0);
    } catch (err) {
      console.error("Database reset failed:", err);
      process.exit(1);
    }
  })().catch((err) => {
    console.error("Database reset failed:", err);
    process.exit(1);
  });
}
