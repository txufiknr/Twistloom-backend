import type { Book } from "../types/book.js";

/**
 * Formats book metadata for prompt
 *
 * @param {Book} book - Book object to format
 * @returns {string} Formatted book metadata string
 */
export function formatBookMetaForPrompt(book: Book): string {
  return `- Title: ${book.title}
  - Summary: ${book.summary}
  - Keywords: ${book.keywords.join(', ')}
  - Target pages: ${book.totalPages} total
  - Language: ${book.language}`;
}