import { AI_CHAT_CONFIG_DEFAULT } from "../config/ai-chat.js";
import { AI_CHAT_MODELS_TRANSLATION, AI_CHAT_MODELS_WRITING } from "../config/ai-clients.js";
import type { AIDocument, AIPromptForJson, AIResponse } from "../types/ai-chat.js";
import { SUMMARY_LENGTH, KEYWORDS_COUNT } from "../config/story.js";
import type { ActionTranslation } from "../types/story.js";
import type { BookTranslation, PageTranslation, PageTranslationBulk, PageTranslationBulkResponse, BookTranslationBulkResponse, BookTranslationBulk, PageToTranslate, BookToTranslate } from "../types/book.js";
import { BOOK_TRANSLATION_REQUIRED_FIELDS, BOOK_TRANSLATION_SCHEMA_DEFINITION, BULK_BOOK_TRANSLATION_REQUIRED_FIELDS, BULK_BOOK_TRANSLATION_SCHEMA_DEFINITION, PAGE_TRANSLATION_REQUIRED_FIELDS, PAGE_TRANSLATION_SCHEMA_DEFINITION, BULK_PAGE_TRANSLATION_REQUIRED_FIELDS, BULK_PAGE_TRANSLATION_SCHEMA_DEFINITION } from "../schema/book.js";
import { executePromptForJSON } from "./prompt.js";
import { formatLanguage } from "./translation.js";

// ============================================================================
// BOOK TRANSLATION
// ============================================================================

const bookTranslationOutputFormat: string = `{
  "title": "Translated book title",
  "hook": "Translated hook text",
  "summary": "Translated summary",
  "keywords": ["translated-keyword-1", "translated-keyword-2", "..."],
  "mc": {
    "bio": "Translated bio"
  }
}`;

const bulkBookTranslationOutputFormat: string = `{
  "translations": [
    {
      "bookId": "book-uuid-1",
      "title": "Translated book title",
      "hook": "Translated hook text",
      "summary": "Translated summary",
      "keywords": ["translated-keyword-1", "translated-keyword-2", "..."],
      "mc": {
        "bio": "Translated bio"
      }
    },
    {
      "bookId": "book-uuid-2",
      "title": "Translated book title",
      "hook": "Translated hook text",
      "summary": "Translated summary",
      "keywords": ["translated-keyword-1", "translated-keyword-2", "..."],
      "mc": {
        "bio": "Translated bio"
      }
    }
  ]
}`;

/**
 * Creates field instructions for book translation
 */
const bookTranslationFieldInstructions: string = `
- title: Translate the book title. Keep it catchy and mysterious.
- hook: Translate the hook. Maintain the intrigue and psychological tension.
- summary: Translate the summary. Keep it ${SUMMARY_LENGTH}, preserving the psychological thriller atmosphere.
- keywords: Translate keywords. Provide ${KEYWORDS_COUNT} relevant tags in the target language.
- mc.bio: Translate main character's bio.

TRANSLATION GUIDELINES:
- Maintain the psychological thriller tone and atmosphere
- Preserve the mystery and intrigue of the original text
- Use natural, idiomatic language in the target language
- Keep the same level of intensity and suspense
- Ensure cultural appropriateness for the target language`;

/**
 * Translates book metadata to target language using AI
 * 
 * @param book - Book data to translate
 * @param targetLanguage - Target language code (ISO 639-1, e.g., 'es', 'fr', 'de')
 * @returns Promise resolving to translated book metadata
 * 
 * @example
 * ```typescript
 * const translation = await translateBook(book, 'es');
 * console.log('Spanish title:', translation.title);
 * ```
 */
export async function translateBook(
  book: BookToTranslate,
  targetLanguage: string
): Promise<AIResponse<BookTranslation>> {
  const sourceLanguage = book.language || 'en';
  const prompt = `TASK: Translate the following book metadata from ${formatLanguage(sourceLanguage)} to ${formatLanguage(targetLanguage)}.\n\n${formatBookPrompt(book)}`;
  const response = await executePromptForJSON<BookTranslation>({
    prompt,
    configs: {
      schema: BOOK_TRANSLATION_SCHEMA_DEFINITION,
      requiredFields: BOOK_TRANSLATION_REQUIRED_FIELDS,
      fallbackField: 'title',
      baseOptions: {
        config: AI_CHAT_CONFIG_DEFAULT,
        modelSelection: AI_CHAT_MODELS_WRITING,
        context: 'book-translation',
        logPrompts: true,
      }
    } satisfies AIPromptForJson<BookTranslation>,
    jsonStructure: bookTranslationOutputFormat,
    fieldInstructions: bookTranslationFieldInstructions,
  });

  if (!response.result) {
    const errorCode = response.finishReason || 'UNKNOWN';
    const provider = response.provider || 'unknown';
    throw new Error(`Failed to translate book: ${errorCode} (${provider})`);
  }

  return response;
}

/**
 * Translates multiple books to target language in a single AI request using documents
 * 
 * @param books - Array of books with their IDs to translate
 * @param targetLanguage - Target language code (ISO 639-1, e.g., 'es', 'fr', 'de')
 * @returns Promise resolving to array of translated book metadata with bookIds
 * 
 * @example
 * ```typescript
 * const translations = await translateBooksBulk(books, 'es');
 * translations.forEach(t => console.log(`Book ${t.bookId}: ${t.title}`));
 * ```
 */
export async function translateBooksBulk(
  books: BookToTranslate[],
  targetLanguage: string
): Promise<BookTranslationBulkResponse> {
  const documents: AIDocument[] = books.map(formatBookDocument);
  const prompt = `TASK: Translate ${documents.length} books provided in the documents to ${formatLanguage(targetLanguage)}.`;
  const response = await executePromptForJSON<BookTranslationBulk>({
    prompt,
    configs: {
      schema: BULK_BOOK_TRANSLATION_SCHEMA_DEFINITION,
      requiredFields: BULK_BOOK_TRANSLATION_REQUIRED_FIELDS,
      fallbackField: 'translations',
      baseOptions: {
        config: AI_CHAT_CONFIG_DEFAULT,
        modelSelection: AI_CHAT_MODELS_TRANSLATION,
        context: 'bulk-book-translation',
        logPrompts: true,
        documents,
      }
    } satisfies AIPromptForJson<BookTranslationBulk>,
    jsonStructure: bulkBookTranslationOutputFormat,
    fieldInstructions: `- bookId: Don't change. Should match to its source book.${bookTranslationFieldInstructions}`,
  });

  if (!response.result) {
    const errorCode = response.finishReason || 'UNKNOWN';
    const provider = response.provider || 'unknown';
    throw new Error(`Failed to translate books in bulk: ${errorCode} (${provider})`);
  }

  const { provider, model, result } = response;
  return { provider, model, translations: result.translations };
}

// ============================================================================
// PAGE TRANSLATION
// ============================================================================

const pageTranslationOutputFormat: string = `{
  "text": "Translated page text",
  "place": "Translated place name",
  "keyEvents": ["Translated key event 1", "Translated key event 2", "..."],
  "importantObjects": ["translated-object-1", "translated-object-2", "..."],
  "actions": [
    {
      "originalText": "Original action text (keep unchanged)",
      "text": "Translated action text"
    }
  ]
}`;

const bulkPageTranslationOutputFormat: string = `{
  "translations": [
    {
      "pageId": "page-uuid-1",
      "text": "Translated page text",
      "place": "Translated place name",
      "keyEvents": ["Translated key event 1", "Translated key event 2", "..."],
      "importantObjects": ["translated-object-1", "translated-object-2", "..."],
      "actions": [
        {
          "originalText": "Original action text (keep unchanged)",
          "text": "Translated action text"
        }
      ]
    },
    {
      "pageId": "page-uuid-2",
      "text": "Translated page text",
      "place": "Translated place name",
      "keyEvents": ["Translated key event 1", "Translated key event 2", "..."],
      "importantObjects": ["translated-object-1", "translated-object-2", "..."],
      "actions": [
        {
          "originalText": "Original action text (keep unchanged)",
          "text": "Translated action text"
        }
      ]
    }
  ]
}`;

/**
 * Creates field instructions for page translation
 */
const buildPageTranslationFieldInstructions = (hasAsterisks: boolean, isBulk: boolean = false): string => {
  const asteriskInstruction = hasAsterisks ? 'Keep text styling using asterisks (if any).' : '';
  return `${isBulk ? `- pageId: Don't change. Should match to its source page.` : ''}
- text: Translate the page narrative. ${asteriskInstruction}
- place: Translate the place name. Keep it atmospheric and descriptive.
- keyEvents: Translate key events. Preserve the sequence and importance.
- importantObjects: Translate important objects. Keep them relevant to the story.
- actions: Include both the original text (unchanged) and the translated text.

TRANSLATION GUIDELINES:
- Maintain first-person central (MC = narrator) POV throughout
- Preserve psychological thriller atmosphere, tension, and horror elements
- Use natural, idiomatic language in the target language
- Keep the same emotional tone (fear, dread, suspense, etc.)
- Ensure action choices remain meaningful and intriguing`;
};

/**
 * Translates page content to target language using AI
 * 
 * @param page - Page data to translate
 * @param targetLanguage - Target language code (ISO 639-1, e.g., 'es', 'fr', 'de')
 * @returns Promise resolving to translated page content
 * 
 * @example
 * ```typescript
 * const translation = await translatePage(page, 'es');
 * console.log('Spanish text:', translation.text);
 * ```
 */
export async function translatePage(
  page: PageToTranslate,
  targetLanguage: string
): Promise<AIResponse<PageTranslation>> {
  const prompt = `TASK: Translate the following page content to ${formatLanguage(targetLanguage)}.\n\n${formatPagePrompt(page)}`;
  const hasAsterisks = page.text.includes('*');
  const response = await executePromptForJSON<PageTranslation>({
    prompt,
    configs: {
      schema: PAGE_TRANSLATION_SCHEMA_DEFINITION,
      requiredFields: PAGE_TRANSLATION_REQUIRED_FIELDS,
      fallbackField: 'text',
      baseOptions: {
        config: AI_CHAT_CONFIG_DEFAULT,
        modelSelection: AI_CHAT_MODELS_WRITING,
        context: 'page-translation',
        logPrompts: true,
      }
    } satisfies AIPromptForJson<PageTranslation>,
    jsonStructure: pageTranslationOutputFormat,
    fieldInstructions: buildPageTranslationFieldInstructions(hasAsterisks),
  });

  if (!response.result) {
    const errorCode = response.finishReason || 'UNKNOWN';
    const provider = response.provider || 'unknown';
    throw new Error(`Failed to translate page: ${errorCode} (${provider})`);
  }

  // Ensure actions have originalText matching the original actions
  const originalActions = page.actions || [];
  const translatedActions = response.result.actions || [];
  
  // Map translated actions back to original actions by matching text
  const finalActions: ActionTranslation[] = originalActions.map(originalAction => {
    const translatedAction = translatedActions.find(
      ta => ta.originalText === originalAction.text
    );
    return {
      originalText: originalAction.text,
      text: translatedAction?.text || originalAction.text,
    };
  });

  const result: PageTranslation = {
    ...response.result,
    actions: finalActions,
  };

  return { ...response, result };
}

/**
 * Translates multiple pages to target language in a single AI request using documents
 * 
 * @param pages - Array of pages with their IDs to translate
 * @param targetLanguage - Target language code (ISO 639-1, e.g., 'es', 'fr', 'de')
 * @returns Promise resolving to array of translated page content with pageIds
 * 
 * @example
 * ```typescript
 * const translations = await translatePagesBulk(pages, 'es');
 * translations.forEach(t => console.log(`Page ${t.pageId}: ${t.text.substring(0, 50)}...`));
 * ```
 */
export async function translatePagesBulk(
  pages: PageToTranslate[],
  targetLanguage: string
): Promise<PageTranslationBulkResponse> {
  // Format pages as documents
  const documents: AIDocument[] = pages.map(formatPageDocument);

  const prompt = `TASK: Translate ${documents.length} pages provided in the documents to ${formatLanguage(targetLanguage)}.`;
  const hasAsterisks = pages.some(page => page.text.includes('*'));
  const response = await executePromptForJSON<PageTranslationBulk>({
    prompt,
    configs: {
      schema: BULK_PAGE_TRANSLATION_SCHEMA_DEFINITION,
      requiredFields: BULK_PAGE_TRANSLATION_REQUIRED_FIELDS,
      fallbackField: 'translations',
      baseOptions: {
        config: AI_CHAT_CONFIG_DEFAULT,
        modelSelection: AI_CHAT_MODELS_TRANSLATION,
        context: 'bulk-page-translation',
        logPrompts: true,
        documents,
      }
    } satisfies AIPromptForJson<PageTranslationBulk>,
    jsonStructure: bulkPageTranslationOutputFormat,
    fieldInstructions: buildPageTranslationFieldInstructions(hasAsterisks, true),
  });

  if (!response.result) {
    const errorCode = response.finishReason || 'UNKNOWN';
    const provider = response.provider || 'unknown';
    throw new Error(`Failed to translate pages in bulk: ${errorCode} (${provider})`);
  }

  // Ensure actions have originalText matching the original actions for each page
  const finalTranslations = response.result.translations.map(translation => {
    const originalPage = pages.find(p => p.id === translation.pageId);
    if (!originalPage) return translation;

    const originalActions = originalPage.actions || [];
    const translatedActions = translation.actions || [];
    
    // Map translated actions back to original actions by matching text
    const finalActions: ActionTranslation[] = originalActions.map(originalAction => {
      const translatedAction = translatedActions.find(
        ta => ta.originalText === originalAction.text
      );
      return {
        originalText: originalAction.text,
        text: translatedAction?.text || originalAction.text,
      };
    });

    return {
      ...translation,
      actions: finalActions,
    };
  });

  const { provider, model } = response;
  return { provider, model, translations: finalTranslations };
}

function formatPageDocument(page: PageToTranslate, index: number): AIDocument {
  return {
    title: `Page ${index + 1}: ${page.place || 'Unknown Location'}`,
    snippet: `Page ID: ${page.id}\n${formatPagePrompt(page)}`
  };
}

function formatBookDocument(book: BookToTranslate, index: number): AIDocument {
  return {
    title: `Book ${index + 1}: ${book.title}`,
    snippet: `Book ID: ${book.id}\n${formatBookPrompt(book)}`
  };
}

function formatPagePrompt(page: PageToTranslate): string {
  return `Text:\n"""\n${page.text}\n"""
Place: ${page.place || 'unknown'}
Key Events: ${page.keyEvents?.join(', ') || 'none'}
Important Objects: ${page.importantObjects?.join(', ') || 'none'}
Actions: ${page.actions?.map(a => a.text)?.join('; ') || 'none'}`;
}

function formatBookPrompt(book: BookToTranslate): string {
  return `Title: ${book.title}
Hook: ${book.hook}
Summary: ${book.summary}
Keywords: ${book.keywords?.join(', ') || 'none'}
Language: ${book.language || 'en'}`;
}