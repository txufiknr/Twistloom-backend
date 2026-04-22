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

export function formatPageTextForPrompt(text: string): string {
  return text.trim().replace(/\n/g, ' ¶ ');
}

/**
 * Validates book sort option
 * 
 * @param sortBy - Sort option to validate
 * @returns True if valid sort option
 */
export function isValidBookSortOption(sortBy: string): sortBy is BookSortOption {
  return ['popular', 'newest', 'trending', 'top-picks'].includes(sortBy);
}