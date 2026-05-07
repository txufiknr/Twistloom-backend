/**
 * @summary Daily cron job to generate Twistloom Originals (auto-generated books)
 * @description Generates one original psychological thriller book per day using AI
 * 
 * Idempotency:
 * - Safe to run multiple times: creates new books with unique IDs
 * - Uses system user ID for ownership (configured via env var)
 * - AI generates unique themes each time
 * 
 * Should be run once per day via cron job
 */
import { getErrorMessage } from "../utils/error.js";
import { generateBookCreationPromptText } from "../utils/prompt.js";
import { createBookCore } from "../services/book-creation.js";
import { invalidateExploreCache } from "../services/cache.js";
import type { CreateBookResponse } from "../types/book.js";
import { SYSTEM_USER_ID } from "../utils/env.js";

export async function generateOriginalBook(): Promise<void> {
  const startedAt = Date.now();

  try {
    console.log("[generate-originals] 🎨 Starting Twistloom Original generation...");

    // Loop step 1-2: generate theme and try to create book; on failure regenerate theme and retry
    const MAX_ATTEMPTS = 3;
    let result: CreateBookResponse | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Step 1: Generate creative theme using AI (non-streaming for cron job)
      console.log(`[generate-originals] 💭 Generating creative theme... (attempt ${attempt}/${MAX_ATTEMPTS})`);
      const theme = await generateBookCreationPromptText();
      console.log(`[generate-originals] 💭 Generated theme: "${theme.substring(0, 100)}${theme.length > 100 ? '...' : ''}"`);

      // Step 2: Try creating the book with the generated theme
      console.log(`[generate-originals] 📔 Creating original book... (attempt ${attempt}/${MAX_ATTEMPTS})`);
      try {
        result = await createBookCore({
          userId: SYSTEM_USER_ID,
          theme,
          isOriginal: true,
          generateCoverImage: false, // Generate cover image for original books
        });
        // Success -> break out of retry loop
        break;
      } catch (err) {
        console.error(`[generate-originals] ⚠️ createBookCore failed on attempt ${attempt}:`, getErrorMessage(err));
        if (attempt < MAX_ATTEMPTS) {
          console.log('[generate-originals] 🔁 Retrying with a new theme...');
          continue;
        }
        // Last attempt failed -> rethrow to be handled by outer catch
        throw err;
      }
    }

    console.log("[generate-originals] ✅ Original book created successfully:", {
      bookId: result!.book.id,
      title: result!.book.title,
      totalPages: result!.book.totalPages,
      isOriginal: result!.book.isOriginal,
    });

    // Step 3: Invalidate explore cache so new original appears
    console.log("[generate-originals] 🔄 Invalidating explore cache...");
    await invalidateExploreCache();

    const durationMs = Date.now() - startedAt;
    console.log(`[generate-originals] ✅ Completed in ${durationMs}ms`);
  } catch (error) {
    console.error("[generate-originals] ❌ Failed to generate original book:", getErrorMessage(error));
    throw error;
  }
}

/**
 * Main execution function for generate-originals cron job
 */
async function main(): Promise<void> {
  const startedAt = Date.now();

  try {
    await generateOriginalBook();
    const durationMs = Date.now() - startedAt;
    console.log(`[generate-originals] ✅ Completed in ${durationMs}ms`);
    process.exit(0);
  } catch (error) {
    console.error("[generate-originals] ❌ Original generation job failed:", getErrorMessage(error));
    process.exit(1);
  }
}

/**
 * Ensure unhandled async failures terminate the process.
 * Important for GitHub Actions correctness.
 */
process.on("unhandledRejection", (reason) => {
  console.error("[generate-originals] Unhandled promise rejection", reason);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  console.error("[generate-originals] Uncaught exception", getErrorMessage(error));
  process.exit(1);
});

void main();
