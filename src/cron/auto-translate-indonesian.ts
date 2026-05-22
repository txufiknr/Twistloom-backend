/**
 * @summary Auto-translates books and pages to Indonesian using AI
 * @description Translates books and pages that don't have AI-generated Indonesian translations
 *
 * This cron job:
 * - Finds books without Indonesian translation or with non-AI translation
 * - Finds pages without Indonesian translation or with non-AI translation
 * - Translates them to Indonesian using AI
 * - Inserts/updates the translations in the database
 *
 * Should be run daily via cron job
 */
import { dbWrite } from "../db/client.js";
import { books, pages, bookTranslations, pageTranslations } from "../db/schema.js";
import { eq, and, sql } from "drizzle-orm";
import { getErrorMessage } from "../utils/error.js";
import { translateBooksBulk, translatePagesBulk } from "../utils/prompt-translation.js";
import { MAX_BOOKS_PER_TRANSLATION_RUN, MAX_PAGES_PER_TRANSLATION_RUN, BOOKS_PER_BULK_TRANSLATION, PAGES_PER_BULK_TRANSLATION } from "../config/translation.js";
import type { DBBook, DBPage } from "../types/schema.js";

const TARGET_LANGUAGE = 'id'; // Indonesian (ISO 639-1)

/**
 * Translates books to Indonesian in bulk
 */
async function translateBooksToIndonesianBulk(books: DBBook[]): Promise<void> {
  if (books.length === 0) return;

  try {
    console.log(`[auto-translate-id] 📚 Translating ${books.length} books to Indonesian in bulk...`);

    const booksWithIds = books.map(book => ({
      id: book.id,
      title: book.title,
      hook: book.hook || '',
      summary: book.summary || '',
      keywords: book.keywords || [],
      language: book.language || 'en',
    }));

    const { provider, model, translations } = await translateBooksBulk(booksWithIds, TARGET_LANGUAGE);
    const providerName = `${provider}${model ? ` (${model})` : ''}`;

    // Insert or update translations in bulk
    for (const translation of translations) {
      await dbWrite
        .insert(bookTranslations)
        .values({
          bookId: translation.bookId,
          language: TARGET_LANGUAGE,
          title: translation.title,
          hook: translation.hook,
          summary: translation.summary,
          keywords: translation.keywords,
          providerType: 'ai',
          providerName,
        })
        .onConflictDoUpdate({
          target: [bookTranslations.bookId, bookTranslations.language],
          set: {
            title: translation.title,
            hook: translation.hook,
            summary: translation.summary,
            keywords: translation.keywords,
            providerType: 'ai',
            providerName,
            updatedAt: new Date(),
          },
        });
    }

    console.log(`[auto-translate-id] ✅ Translated ${translations.length} books to Indonesian`);
  } catch (error) {
    console.error(`[auto-translate-id] ❌ Failed to translate books in bulk:`, getErrorMessage(error));
    throw error;
  }
}

/**
 * Translates pages to Indonesian in bulk
 */
async function translatePagesToIndonesianBulk(pages: DBPage[]): Promise<void> {
  if (pages.length === 0) return;

  try {
    console.log(`[auto-translate-id] 📄 Translating ${pages.length} pages to Indonesian in bulk...`);

    const pagesWithIds = pages.map(page => ({
      id: page.id,
      text: page.text,
      place: page.place || '',
      keyEvents: page.keyEvents || [],
      importantObjects: page.importantObjects || [],
      actions: page.actions || [],
    }));

    const { provider, model, translations } = await translatePagesBulk(pagesWithIds, TARGET_LANGUAGE);
    const providerName = `${provider}${model ? ` (${model})` : ''}`;

    // Insert or update translations in bulk
    for (const translation of translations) {
      await dbWrite
        .insert(pageTranslations)
        .values({
          pageId: translation.pageId,
          language: TARGET_LANGUAGE,
          text: translation.text,
          place: translation.place,
          keyEvents: translation.keyEvents,
          importantObjects: translation.importantObjects,
          actions: translation.actions,
          providerType: 'ai',
          providerName,
        })
        .onConflictDoUpdate({
          target: [pageTranslations.pageId, pageTranslations.language],
          set: {
            text: translation.text,
            place: translation.place,
            keyEvents: translation.keyEvents,
            importantObjects: translation.importantObjects,
            actions: translation.actions,
            providerType: 'ai',
            providerName,
            updatedAt: new Date(),
          },
        });
    }

    console.log(`[auto-translate-id] ✅ Translated ${translations.length} pages to Indonesian`);
  } catch (error) {
    console.error(`[auto-translate-id] ❌ Failed to translate pages in bulk:`, getErrorMessage(error));
    throw error;
  }
}

/**
 * Finds books that need Indonesian translation
 * - Books without Indonesian translation
 * - Books with non-AI Indonesian translation
 */
async function findBooksNeedingTranslation(): Promise<DBBook[]> {
  const booksWithoutTranslation = await dbWrite
    .select()
    .from(books)
    .where(
      and(
        eq(books.status, 'active'),
        sql`NOT EXISTS (
          SELECT 1 FROM book_translations
          WHERE book_translations.book_id = books.id
          AND book_translations.language = ${TARGET_LANGUAGE}
        )`
      )
    )
    .limit(MAX_BOOKS_PER_TRANSLATION_RUN);

  const booksWithNonAiTranslation = await dbWrite
    .select()
    .from(books)
    .where(
      and(
        eq(books.status, 'active'),
        sql`EXISTS (
          SELECT 1 FROM book_translations
          WHERE book_translations.book_id = books.id
          AND book_translations.language = ${TARGET_LANGUAGE}
          AND book_translations.provider_type != 'ai'
        )`
      )
    )
    .limit(MAX_BOOKS_PER_TRANSLATION_RUN);

  // Combine and deduplicate
  const allBooks = [...booksWithoutTranslation, ...booksWithNonAiTranslation];
  const uniqueBooks = new Map(allBooks.map(book => [book.id, book]));
  return Array.from(uniqueBooks.values());
}

/**
 * Finds pages that need Indonesian translation
 * - Pages without Indonesian translation
 * - Pages with non-AI Indonesian translation
 */
async function findPagesNeedingTranslation(): Promise<DBPage[]> {
  const pagesWithoutTranslation = await dbWrite
    .select()
    .from(pages)
    .where(
      sql`NOT EXISTS (
        SELECT 1 FROM page_translations
        WHERE page_translations.page_id = pages.id
        AND page_translations.language = ${TARGET_LANGUAGE}
      )`
    )
    .limit(MAX_PAGES_PER_TRANSLATION_RUN);

  const pagesWithNonAiTranslation = await dbWrite
    .select()
    .from(pages)
    .where(
      sql`EXISTS (
        SELECT 1 FROM page_translations
        WHERE page_translations.page_id = pages.id
        AND page_translations.language = ${TARGET_LANGUAGE}
        AND page_translations.provider_type != 'ai'
      )`
    )
    .limit(MAX_PAGES_PER_TRANSLATION_RUN);

  // Combine and deduplicate
  const allPages = [...pagesWithoutTranslation, ...pagesWithNonAiTranslation];
  const uniquePages = new Map(allPages.map(page => [page.id, page]));
  return Array.from(uniquePages.values());
}

/**
 * Main function to auto-translate books and pages to Indonesian
 */
export async function autoTranslateIndonesian(): Promise<void> {
  const startedAt = Date.now();

  try {
    console.log("[auto-translate-id] 🌍 Starting Indonesian auto-translation...");

    // Find books needing translation
    const booksToTranslate = await findBooksNeedingTranslation();
    console.log(`[auto-translate-id] 📚 Found ${booksToTranslate.length} books needing Indonesian translation`);

    // Translate books in bulk chunks
    let booksTranslated = 0;
    for (let i = 0; i < booksToTranslate.length; i += BOOKS_PER_BULK_TRANSLATION) {
      const chunk = booksToTranslate.slice(i, i + BOOKS_PER_BULK_TRANSLATION);
      try {
        await translateBooksToIndonesianBulk(chunk);
        booksTranslated += chunk.length;
      } catch {
        console.log(`[auto-translate-id] ⏩ Skipping book batch ${i / BOOKS_PER_BULK_TRANSLATION + 1} due to error`);
      }
    }

    // Find pages needing translation
    const pagesToTranslate = await findPagesNeedingTranslation();
    console.log(`[auto-translate-id] 📄 Found ${pagesToTranslate.length} pages needing Indonesian translation`);

    // Translate pages in bulk chunks
    let pagesTranslated = 0;
    for (let i = 0; i < pagesToTranslate.length; i += PAGES_PER_BULK_TRANSLATION) {
      const chunk = pagesToTranslate.slice(i, i + PAGES_PER_BULK_TRANSLATION);
      try {
        await translatePagesToIndonesianBulk(chunk);
        pagesTranslated += chunk.length;
      } catch {
        console.log(`[auto-translate-id] ⏩ Skipping page batch ${i / PAGES_PER_BULK_TRANSLATION + 1} due to error`);
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
 * Main execution function for auto-translation cron job
 */
async function main(): Promise<void> {
  const startedAt = Date.now();

  try {
    await autoTranslateIndonesian();
    const durationMs = Date.now() - startedAt;
    console.log(`[auto-translate-id] ✅ Completed in ${durationMs}ms`);
    process.exit(0);
  } catch (error) {
    console.error("[auto-translate-id] ❌ Auto-translation failed:", getErrorMessage(error));
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
  console.error("[auto-translate-id] Uncaught exception", getErrorMessage(error));
  process.exit(1);
});

void main();
