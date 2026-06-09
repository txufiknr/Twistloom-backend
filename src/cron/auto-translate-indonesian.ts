/**
 * @summary Auto-translates books and pages to Indonesian using AI
 * @description Translates books and pages that don't have AI-generated Indonesian translations
 *
 * This cron job:
 * - Finds books without Indonesian translation or with non-AI translation
 * - Finds pages (from active, non-Indonesian books) without Indonesian translation or with non-AI translation
 * - Translates them to Indonesian using AI in bulk batches
 * - Inserts/updates the translations in the database
 *
 * Should be run daily via cron job
 */
import { dbRead, dbWrite } from "../db/client.js";
import { books, pages, bookTranslations, pageTranslations } from "../db/schema.js";
import { eq, and, sql, ne } from "drizzle-orm";
import { getErrorMessage } from "../utils/error.js";
import { translateBooksBulk, translatePagesBulk } from "../utils/prompt-translation.js";
import { MAX_BOOKS_PER_TRANSLATION_RUN, MAX_PAGES_PER_TRANSLATION_RUN, BOOKS_PER_BULK_TRANSLATION, PAGES_PER_BULK_TRANSLATION } from "../config/translation.js";
import { getBook, mapBookFromDb, mapToPersistedStoryPage } from "../services/book.js";
import { getStoryStateWithBranch } from "../services/story-branch.js";
import type { DBBook, DBNewBookTranslations, DBNewPageTranslations, DBPage } from "../types/schema.js";
import type { BookToTranslate, BookTranslation, PageToTranslate, PageTranslation } from "../types/book.js";
import type { ResourceTranslatorProvider, ResourceTranslatorType } from "../types/api.js";

const TARGET_LANGUAGE = 'id'; // Indonesian (ISO 639-1)

/**
 * Translates books to Indonesian in bulk
 */
async function translateBooksToIndonesianBulk(dbBooks: DBBook[]): Promise<void> {
  if (dbBooks.length === 0) return;

  try {
    console.log(`[auto-translate-id] 📚 Translating ${dbBooks.length} books to Indonesian in bulk...`);

    const booksWithIds: BookToTranslate[] = dbBooks.map(mapBookFromDb);

    const { provider: providerName, model: aiModel, translations } = await translateBooksBulk(booksWithIds, TARGET_LANGUAGE);
    const providerType: ResourceTranslatorType = 'ai';

    for (const translation of translations) {
      const translationValues = {
        title:       translation.title,
        hook:        translation.hook,
        summary:     translation.summary,
        keywords:    translation.keywords,
        mc:          translation.mc,
        providerType,
        providerName,
        aiModel,
        updatedAt:   new Date(),
      } satisfies Record<keyof BookTranslation | ResourceTranslatorProvider | 'updatedAt', unknown>;

      await dbWrite
        .insert(bookTranslations)
        .values({
          bookId:   translation.bookId,
          language: TARGET_LANGUAGE,
          ...translationValues,
        } satisfies DBNewBookTranslations)
        .onConflictDoUpdate({
          target: [bookTranslations.bookId, bookTranslations.language],
          set: translationValues,
        });
    }

    console.log(`[auto-translate-id] ✅ Translated ${translations.length} books to Indonesian`);
  } catch (error) {
    console.error(`[auto-translate-id] ❌ Failed to translate books in bulk:`, getErrorMessage(error));
    throw error;
  }
}

/**
 * Translates pages to Indonesian in bulk.
 *
 * Books are deduplicated and fetched once up-front to avoid N+1 DB calls when
 * a single book has many pages in the batch.
 */
async function translatePagesToIndonesianBulk(dbPages: DBPage[]): Promise<void> {
  if (dbPages.length === 0) return;

  try {
    console.log(`[auto-translate-id] 📄 Translating ${dbPages.length} pages to Indonesian in bulk...`);

    // ── Deduplicate book fetches ─────────────────────────────────────────────
    // A single book can own many pages in one batch; fetching it once per unique
    // bookId avoids O(N) round-trips when the batch contains pages from few books.
    const uniqueBookIds = [...new Set(dbPages.map((p) => p.bookId))];
    const bookMap = new Map(
      (
        await Promise.all(
          uniqueBookIds.map(async (bookId) => {
            const book = await getBook(bookId);
            return book ? ([bookId, book] as const) : null;
          })
        )
      ).filter((entry): entry is [string, NonNullable<Awaited<ReturnType<typeof getBook>>>] => entry !== null)
    );

    // ── Build PageToTranslate objects ────────────────────────────────────────
    const pagesWithIds: PageToTranslate[] = [];

    for (const p of dbPages) {
      const book = bookMap.get(p.bookId);
      if (!book) {
        console.warn(`[auto-translate-id] ⚠️ Skipping page ${p.id} — book ${p.bookId} not found`);
        continue;
      }

      const state = await getStoryStateWithBranch(p.bookId, p.id);
      if (!state) {
        console.warn(`[auto-translate-id] ⚠️ Skipping page ${p.id} — story state not found`);
        continue;
      }

      pagesWithIds.push({ ...mapToPersistedStoryPage(p), state, book });
    }

    if (pagesWithIds.length === 0) {
      console.log(`[auto-translate-id] ℹ️ No valid pages to translate after hydration`);
      return;
    }

    const { provider: providerName, model: aiModel, translations } = await translatePagesBulk(pagesWithIds, TARGET_LANGUAGE);
    const providerType: ResourceTranslatorType = 'ai';

    for (const translation of translations) {
      const translationValues = {
        text:             translation.text,
        place:            translation.place,
        timeOfDay:        translation.timeOfDay,
        mood:             translation.mood,
        weather:          translation.weather,
        keyEvents:        translation.keyEvents,
        importantObjects: translation.importantObjects,
        contextHistory:   translation.contextHistory,
        actions:          translation.actions,
        providerType,
        providerName,
        aiModel,
        updatedAt:        new Date(),
      } satisfies Record<keyof PageTranslation | ResourceTranslatorProvider | 'updatedAt', unknown>;

      await dbWrite
        .insert(pageTranslations)
        .values({
          pageId:   translation.pageId,
          language: TARGET_LANGUAGE,
          ...translationValues,
        } satisfies DBNewPageTranslations)
        .onConflictDoUpdate({
          target: [pageTranslations.pageId, pageTranslations.language],
          set: translationValues,
        });
    }

    console.log(`[auto-translate-id] ✅ Translated ${translations.length} pages to Indonesian`);
  } catch (error) {
    console.error(`[auto-translate-id] ❌ Failed to translate pages in bulk:`, getErrorMessage(error));
    throw error;
  }
}

/**
 * Finds books that need Indonesian translation.
 *
 * Returns active books whose language is not Indonesian and that either:
 * - have no Indonesian translation at all, or
 * - have only a non-AI (e.g. LibreTranslate) Indonesian translation.
 *
 * Uses `dbRead` because these are read-only queries.
 */
async function findBooksNeedingTranslation(): Promise<DBBook[]> {
  // FIX: use dbRead (not dbWrite) for read-only queries
  const booksWithoutTranslation = await dbRead
    .select()
    .from(books)
    .where(
      and(
        eq(books.status, 'active'),
        ne(books.language, TARGET_LANGUAGE),
        sql`NOT EXISTS (
          SELECT 1 FROM book_translations
          WHERE book_translations.book_id = books.id
            AND book_translations.language = ${TARGET_LANGUAGE}
        )`
      )
    )
    .limit(MAX_BOOKS_PER_TRANSLATION_RUN);

  const booksWithNonAiTranslation = await dbRead
    .select()
    .from(books)
    .where(
      and(
        eq(books.status, 'active'),
        ne(books.language, TARGET_LANGUAGE),
        sql`EXISTS (
          SELECT 1 FROM book_translations
          WHERE book_translations.book_id = books.id
            AND book_translations.language = ${TARGET_LANGUAGE}
            AND book_translations.provider_type != 'ai'
        )`
      )
    )
    .limit(MAX_BOOKS_PER_TRANSLATION_RUN);

  // Combine and deduplicate by id
  const allBooks = [...booksWithoutTranslation, ...booksWithNonAiTranslation];
  const uniqueBooks = new Map(allBooks.map((book) => [book.id, book]));
  return Array.from(uniqueBooks.values());
}

/**
 * Finds pages that need Indonesian translation.
 *
 * Only considers pages that belong to **active, non-Indonesian books** — pages
 * from draft/archived books or books already in Indonesian are excluded via
 * correlated EXISTS subqueries on the `books` table.
 *
 * Returns pages that either:
 * - have no Indonesian translation at all, or
 * - have only a non-AI (e.g. LibreTranslate) Indonesian translation.
 *
 * Uses `dbRead` because these are read-only queries.
 */
async function findPagesNeedingTranslation(): Promise<DBPage[]> {
  // Shared predicate: page belongs to an active, non-Indonesian book
  const activeNonIndonesianBook = sql`EXISTS (
    SELECT 1 FROM books b
    WHERE b.id = pages.book_id
      AND b.status = 'active'
      AND b.language != ${TARGET_LANGUAGE}
  )`;

  // FIX: use dbRead (not dbWrite) for read-only queries
  // FIX: filter pages to active, non-Indonesian books (was missing entirely)
  const pagesWithoutTranslation = await dbRead
    .select()
    .from(pages)
    .where(
      and(
        activeNonIndonesianBook,
        sql`NOT EXISTS (
          SELECT 1 FROM page_translations
          WHERE page_translations.page_id = pages.id
            AND page_translations.language = ${TARGET_LANGUAGE}
        )`
      )
    )
    .limit(MAX_PAGES_PER_TRANSLATION_RUN);

  const pagesWithNonAiTranslation = await dbRead
    .select()
    .from(pages)
    .where(
      and(
        activeNonIndonesianBook,
        sql`EXISTS (
          SELECT 1 FROM page_translations
          WHERE page_translations.page_id = pages.id
            AND page_translations.language = ${TARGET_LANGUAGE}
            AND page_translations.provider_type != 'ai'
        )`
      )
    )
    .limit(MAX_PAGES_PER_TRANSLATION_RUN);

  // Combine and deduplicate by id
  const allPages = [...pagesWithoutTranslation, ...pagesWithNonAiTranslation];
  const uniquePages = new Map(allPages.map((page) => [page.id, page]));
  return Array.from(uniquePages.values());
}

/**
 * Main function to auto-translate books and pages to Indonesian
 */
export async function autoTranslateIndonesian(): Promise<void> {
  const startedAt = Date.now();

  try {
    console.log("[auto-translate-id] 🌍 Starting Indonesian auto-translation...");

    // ── Translate books ──────────────────────────────────────────────────────
    const booksToTranslate = await findBooksNeedingTranslation();
    console.log(`[auto-translate-id] 📚 Found ${booksToTranslate.length} books needing Indonesian translation`);

    let booksTranslated = 0;
    for (let i = 0; i < booksToTranslate.length; i += BOOKS_PER_BULK_TRANSLATION) {
      const chunk = booksToTranslate.slice(i, i + BOOKS_PER_BULK_TRANSLATION);
      try {
        await translateBooksToIndonesianBulk(chunk);
        booksTranslated += chunk.length;
      } catch {
        console.log(`[auto-translate-id] ⏩ Skipping book batch ${Math.floor(i / BOOKS_PER_BULK_TRANSLATION) + 1} due to error`);
      }
    }

    // ── Translate pages ──────────────────────────────────────────────────────
    const pagesToTranslate = await findPagesNeedingTranslation();
    console.log(`[auto-translate-id] 📄 Found ${pagesToTranslate.length} pages needing Indonesian translation`);

    let pagesTranslated = 0;
    for (let i = 0; i < pagesToTranslate.length; i += PAGES_PER_BULK_TRANSLATION) {
      const chunk = pagesToTranslate.slice(i, i + PAGES_PER_BULK_TRANSLATION);
      try {
        await translatePagesToIndonesianBulk(chunk);
        pagesTranslated += chunk.length;
      } catch {
        console.log(`[auto-translate-id] ⏩ Skipping page batch ${Math.floor(i / PAGES_PER_BULK_TRANSLATION) + 1} due to error`);
      }
    }

    const durationMs = Date.now() - startedAt;
    console.log(`[auto-translate-id] ✅ Completed: ${booksTranslated} books, ${pagesTranslated} pages translated in ${durationMs}ms`);
  } catch (error) {
    console.error("[auto-translate-id] ❌ Failed to auto-translate:", getErrorMessage(error));
    throw error;
  }
}

/**
 * Main execution function for auto-translation cron job.
 * Timing and completion logging are handled inside `autoTranslateIndonesian`.
 */
async function main(): Promise<void> {
  try {
    await autoTranslateIndonesian();
    process.exit(0);
  } catch (error) {
    console.error("[auto-translate-id] ❌ Auto-translation failed:", error);
    process.exit(1);
  }
}

/**
 * Ensure unhandled async failures terminate the process.
 * Important for GitHub Actions correctness.
 */
process.on("unhandledRejection", (reason) => {
  console.error("[auto-translate-id] Unhandled promise rejection", reason);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  console.error("[auto-translate-id] Uncaught exception", error);
  process.exit(1);
});

void main();