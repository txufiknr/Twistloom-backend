import type { BookSortOption, LastUpdatedFilter, Book } from "../types/book.js";
import { bookSortOptions, lastUpdatedFilterOptions } from "../types/book.js";

/**
 * Formats book metadata for prompt
 *
 * Formats book information in a clear, structured way for AI prompts.
 * Includes all relevant metadata to help AI understand the book's context,
 * premise, and structure.
 *
 * @param {Book} book - Book object to format
 * @returns {string} Formatted book metadata string
 */
export function formatBookMetaForPrompt(book: Book): string {
  return `- Title: ${book.title}
- Hook: ${book.hook}
- Summary: ${book.summary}
- Language: ${book.language}
- Total Pages: ${book.totalPages}
- Status: ${book.status}
- Keywords: ${book.keywords.join(', ')}`;
}

/**
 * Formats page text for prompt by trimming whitespace, replacing double
 * and single line breaks with a delimiter.
 *
 * @param {string} text - Page text to format
 * @returns {string} Formatted page text string
 */
export function formatPageTextForPrompt(text: string): string {
  // return text.trim().replace(/\n\n/g, ' ¶ ').replace(/\n/g, ' ¶ ');
  return text.split('\n').filter(t => t.trim()).join('\n');
}

/**
 * Validates book sort option
 * 
 * @param sortBy - Sort option to validate
 * @returns True if valid sort option
 */
export function isValidBookSortOption(sortBy: string): sortBy is BookSortOption {
  return bookSortOptions.includes(sortBy as BookSortOption);
}

/**
 * Validates lastUpdated filter parameter
 * 
 * @param lastUpdated - Last updated filter value to validate
 * @returns True if valid lastUpdated value
 */
export function isValidLastUpdatedFilter(lastUpdated: string): lastUpdated is LastUpdatedFilter {
  return lastUpdatedFilterOptions.includes(lastUpdated as LastUpdatedFilter);
}