import { AI_CHAT_CONFIG_DEFAULT } from "../config/ai-chat.js";
import { AI_CHAT_MODELS_TRANSLATION, AI_CHAT_MODELS_WRITING } from "../config/ai-clients.js";
import type { AIDocument, AIPromptForJson, AIResponse } from "../types/ai-chat.js";
import { SUMMARY_LENGTH, KEYWORDS_COUNT } from "../config/story.js";
import type { ActionTranslation, StoryState } from "../types/story.js";
import type { BookTranslation, PageTranslation, PageTranslationBulk, PageTranslationBulkResponse, BookTranslationBulkResponse, BookTranslationBulk, PageToTranslate, BookToTranslate, Book } from "../types/book.js";
import { BOOK_TRANSLATION_REQUIRED_FIELDS, BOOK_TRANSLATION_SCHEMA_DEFINITION, BULK_BOOK_TRANSLATION_REQUIRED_FIELDS, BULK_BOOK_TRANSLATION_SCHEMA_DEFINITION, PAGE_TRANSLATION_REQUIRED_FIELDS, PAGE_TRANSLATION_SCHEMA_DEFINITION, BULK_PAGE_TRANSLATION_REQUIRED_FIELDS, BULK_PAGE_TRANSLATION_SCHEMA_DEFINITION } from "../schema/book.js";
import { executePromptForJSON } from "./prompt.js";
import { formatLanguage } from "./translation.js";

/**
 * For translating book meta (title, hook, summary) and page text
 */
const PROMPT_SYSTEM_TRANSLATION = `
You are an expert literary translator specializing in thriller, suspense, mystery, horror, and young-adult fiction.

Your task is to translate a story into the target language while preserving the author's original storytelling experience.

PRIMARY GOAL:

- Produce a natural, professionally localized story text that feels as if it were originally written by a skilled thriller novelist in the target language.
- Readers should never feel they are reading a translation.

---
STORY CONTENT:

Do NOT add, remove, alter, reinterpret, summarize, censor, or expand any plot information.

PRESERVE exactly:
- Events
- Facts
- Character actions
- Character intentions
- Clues
- Dialogue meaning
- Story progression
- Foreshadowing
- Mystery elements

---
NARRATIVE PERSPECTIVE:

Preserve the original perspective exactly. NEVER change narrator perspective.
Examples:
- First person remains first person
- Second person remains second person
- Third person remains third person

---
VERB TENSE:

Preserve narrative tense consistency. Do NOT randomly switch tenses.
Examples:
- Past tense narration stays past tense
- Present tense narration stays present tense

---
CHARACTER VOICE:

Preserve each character's personality and speaking style. AVOID making all characters sound alike.
Examples:
- Confident characters remain confident
- Nervous characters remain nervous
- Children sound like children
- Teenagers sound like teenagers
- Villains retain their distinctive voice

---
SUSPENSE, THRILLER & HORROR STORYTELLING:

- Preserve pacing, tension, atmosphere, emotional impact, and narrative momentum with high priority.
- Maintain short dramatic sentences, abrupt transitions, cliffhangers, sudden reveals, mystery, dread, curiosity, fear, anxiety, isolation, shock, anticipation, and emotional escalation.
- Favor clarity and readability without weakening suspense.
- If a passage feels abrupt, unsettling, tense, or suspenseful in the source language, it should feel equally so in the translation.
- Never dilute tension, suspense, atmosphere, or emotional immediacy.

---
LOCALIZATION RULES:

- Translate idioms, expressions, and colloquialisms naturally when needed.
- Prefer equivalent emotional impact over literal wording.

---
PROHIBITED ACTIONS (DO NOT):

- Rewrite the story
- Explain the translation
- Improve/modernize/simplify the plot
- Add commentary/notes/footnotes/warnings
- Localize names
- Change locations
- Alter worldbuilding
- Modify lore
- Change story canon`;

/**
 * For page text translation, including story context, pacing, continuity, dialogue
 */
const PROMPT_SYSTEM_PAGE_TRANSLATION = `${PROMPT_SYSTEM_TRANSLATION}

---
PAGE FORMATTING RULES:

Preserve exactly:
- Paragraph breaks
- Line breaks
- Dialogue formatting
- Quotation style when appropriate
- Emphasis structure
- Scene transitions

Do NOT merge or split paragraphs unnecessarily.

---
INTERACTIVE STORY REQUIREMENTS:

This page belongs to a branching interactive narrative. Future pages may depend on exact details from this page. NEVER introduce contradictions.

Preserve:
- Continuity
- Clues
- Object names
- Character names
- Important terminology
- Recurring phrases when possible

---
DIALOGUE:

- Translate dialogue naturally.
- Dialogue should sound like real native speakers while preserving intent, emotion, personality, and subtext.
- Do NOT translate word-for-word when doing so would sound unnatural.

---
LANGUAGE REGISTER:

Preserve the original level of formality and social tone. Do NOT make dialogue more formal, literary, or sophisticated than the original.
Examples:
- Casual speech remains casual
- Formal speech remains formal
- Slang remains appropriately informal
- Emotional dialogue remains emotionally natural

---
REVIEW & FIX SILENTLY:

Before returning, verify that:
1. All story information is preserved.
2. Tone matches the original.
3. Character voices remain distinct.
4. Suspense level is maintained.
5. Narrative perspective is unchanged.
6. Tense consistency is preserved.
7. Formatting is preserved.
8. The translation reads like native fiction, not machine translation.`;

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
        systemPrompt: PROMPT_SYSTEM_TRANSLATION,
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
        systemPrompt: PROMPT_SYSTEM_TRANSLATION,
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
  // book: Pick<Book, 'title' | 'summary' | 'mc'>,
  // state: StoryState,
  targetLanguage: string
): Promise<AIResponse<PageTranslation>> {
  const prompt = `TASK: Translate the following page content to ${formatLanguage(targetLanguage)}.\n\n${formatPagePrompt(page)}`;
  const hasAsterisks = page.text.includes('*');
  // TODO: add to document for context: previousPageSummary, pageContent
  const response = await executePromptForJSON<PageTranslation>({
    prompt,
    configs: {
      schema: PAGE_TRANSLATION_SCHEMA_DEFINITION,
      requiredFields: PAGE_TRANSLATION_REQUIRED_FIELDS,
      fallbackField: 'text',
      baseOptions: {
        config: AI_CHAT_CONFIG_DEFAULT,
        modelSelection: AI_CHAT_MODELS_WRITING,
        systemPrompt: PROMPT_SYSTEM_PAGE_TRANSLATION,
        documents: [
          {
            title: 'STORY CONTEXT',
            snippet: `
Story title:
Story synopsis:
Target language: ${targetLanguage}
            `.trim()
          }
        ],
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
        systemPrompt: PROMPT_SYSTEM_PAGE_TRANSLATION,
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