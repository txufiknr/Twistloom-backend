import type { Book, BookSortOption } from "../types/book.js";

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

/**
 * Formats page text for prompt by trimming whitespace, replacing double
 * and single line breaks with a delimiter.
 *
 * @param {string} text - Page text to format
 * @returns {string} Formatted page text string
 */
export function formatPageTextForPrompt(text: string): string {
  return text.trim().replace(/\n\n/g, ' ¶ ').replace(/\n/g, ' ¶ ');
}

/**
 * Validates book sort option
 * 
 * @param sortBy - Sort option to validate
 * @returns True if valid sort option
 */
export function isValidBookSortOption(sortBy: string): sortBy is BookSortOption {
  return ['popular', 'newest', 'trending', 'top-picks', 'originals'].includes(sortBy);
}