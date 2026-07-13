/**
 * @overview Database Extensions Module
 * 
 * Creates and manages database extensions for enhanced functionality.
 * Provides idempotent extension creation with proper error handling.
 * 
 * Features:
 * - pg_trgm extension for trigram-based text search
 * - Enables efficient ILIKE searches with leading wildcards
 * - vector extension (pgvector) for semantic embedding search
 * - Idempotent operations using CREATE EXTENSION IF NOT EXISTS
 * - Environment-aware logging and error handling
 */

import { fileURLToPath } from "url";
import { dbWrite } from "./client.js";
import { getErrorMessage } from "../utils/error.js";

const __filename = fileURLToPath(import.meta.url);

/**
 * Minimum pgvector version this codebase was designed against.
 *
 * pgvector 0.7.x, 0.8.0, and 0.8.1 carry CVE-2026-3172 (CVSS 8.1 buffer
 * overflow during PARALLEL HNSW index builds on populated tables — not
 * triggered by building an index on an empty table, which is what the
 * initial migration does). Fixed in 0.8.2.
 *
 * As of this writing, Neon's supported extensions table caps pgvector at
 * 0.8.0 (PG14-17) / 0.8.1 (PG18) on every plan — 0.8.2 isn't available on
 * Neon yet, for anyone. So this warning is expected to fire on Neon today;
 * it's not misconfiguration, and there's no version to upgrade to yet.
 * The iterative-index-scan feature (the other reason this file originally
 * cared about 0.8.2) landed in 0.8.0 as a feature release, not 0.8.2 — 0.8.2
 * was a pure security patch — so Neon's current ceiling already has that.
 *
 * Actionable mitigation until Neon ships 0.8.2+: before any future
 * CREATE INDEX/REINDEX on a populated embedding table (not needed for the
 * initial empty-table migration), run `SET max_parallel_maintenance_workers
 * = 0;` first — that disables parallel builds for that one operation,
 * sidestepping the CVE's trigger condition regardless of pgvector version.
 */
const MIN_PGVECTOR_VERSION = "0.8.2";

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
 * Creates the vector extension (pgvector) for semantic embedding search
 *
 * This extension enables:
 * 1. The `vector` column type used by page_embeddings, character_embeddings,
 *    place_embeddings, and future_note_embeddings
 * 2. HNSW indexes with vector_cosine_ops for fast approximate nearest-neighbor
 *    similarity search
 * 3. The `<=>` cosine distance operator used throughout the semantic memory
 *    query layer
 *
 * Required for:
 * - pgvector semantic memory (jina-embeddings-v5-text-small embeddings)
 *
 * Idempotency:
 * - Uses CREATE EXTENSION IF NOT EXISTS
 * - Safe to run multiple times without errors
 *
 * Version check:
 * - Warns (does not throw) if the installed version is below
 *   MIN_PGVECTOR_VERSION, since Neon may only offer a narrow range of
 *   versions and blocking startup over this would be too aggressive for
 *   a first pass. Treat the warning as a hard blocker before enabling any
 *   HNSW index build on a branch with real traffic — see MIN_PGVECTOR_VERSION
 *   doc comment for why.
 */
async function ensureVectorExtension(): Promise<void> {
  try {
    await dbWrite.execute(`
      CREATE EXTENSION IF NOT EXISTS vector;
    `);

    // Confirmed against db/client.ts: this project uses drizzle-orm/neon-serverless
    // (Pool-based, node-postgres-compatible), so db.execute() returns a
    // QueryResult with a real .rows array — no shape-guessing needed.
    const result = await dbWrite.execute<{ extversion: string }>(`
      SELECT extversion FROM pg_extension WHERE extname = 'vector';
    `);
    const installedVersion = result.rows[0]?.extversion;

    if (installedVersion && compareVersions(installedVersion, MIN_PGVECTOR_VERSION) < 0) {
      console.warn(
        `⚠️ pgvector ${installedVersion} is installed (CVE-2026-3172, buffer overflow in ` +
        `PARALLEL HNSW builds on populated tables — see MIN_PGVECTOR_VERSION doc comment). ` +
        `Neon doesn't offer ${MIN_PGVECTOR_VERSION}+ yet as of when this was written, so this is ` +
        `expected, not a misconfiguration. Before any future CREATE INDEX/REINDEX on a ` +
        `populated embedding table, run "SET max_parallel_maintenance_workers = 0;" first ` +
        `to sidestep the CVE's trigger condition. Check https://neon.com/docs/changelog ` +
        `periodically for when a newer pgvector version becomes available.`
      );
    }

    console.log(`✅ vector extension created successfully! (version: ${installedVersion ?? "unknown"})`);
  } catch (error) {
    console.error("Failed to create vector extension:", getErrorMessage(error));
    throw error;
  }
}

/**
 * Minimal semver-ish comparator sufficient for pgvector's "X.Y.Z" version
 * strings. Returns negative if `a` < `b`, positive if `a` > `b`, 0 if equal.
 */
function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
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
 * - Creates vector extension for semantic embedding search
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

    // Create vector extension for semantic embedding search
    await ensureVectorExtension();

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
