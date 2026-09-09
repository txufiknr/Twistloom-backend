/**
 * @overview Book Export Service
 *
 * Provides database page assembly and filename sanitization for manuscript exports.
 * Executes indexed single queries on (bookId, branchId) to retrieve story pages in O(1) query time.
 */

import { dbRead } from "../db/client.js";
import { pages } from "../db/schema.js";
import { and, asc, eq } from "drizzle-orm";

export interface ExportPage {
  id: string;
  page: number;
  text: string;
  mood: string | null;
  createdAt: Date;
}

/**
 * Retrieves all pages for a specific book and branch in strictly ascending page order.
 * Leverages the compound B-tree index `pages_book_branch_idx` on (book_id, branch_id).
 */
export async function assembleBookPages(
  bookId: string,
  branchId: string = 'main',
): Promise<ExportPage[]> {
  const rows = await dbRead.query.pages.findMany({
    where: and(
      eq(pages.bookId, bookId),
      eq(pages.branchId, branchId),
    ),
    columns: {
      id: true,
      page: true,
      text: true,
      mood: true,
      createdAt: true,
    },
    orderBy: [asc(pages.page)],
  });

  return rows as ExportPage[];
}

/**
 * Sanitizes a string for safe use as a cross-platform filename (Windows, macOS, Linux).
 * 
 * Enhancements:
 * - Normalizes Unicode characters (NFC) to prevent cross-platform rendering issues.
 * - Removes illegal characters and control bytes.
 * - Prevents Windows reserved filenames (e.g., CON, PRN, AUX, NUL).
 * - Strips leading/trailing spaces and periods (Windows restriction).
 * - Truncates safely without breaking Unicode surrogate pairs (emojis).
 * - Preserves the file extension if the string needs to be truncated.
 *
 * @param name - The original filename (can include extension).
 * @param options - Optional configuration for length and fallback.
 * @param options.maxLength - Maximum allowed filename length (default: 150).
 * @param options.fallback - Fallback name if the sanitized result is empty (default: 'document').
 * @returns A strictly sanitized, safe filename string.
 */
export function sanitizeDownloadFilename(
  name: string,
  options: { maxLength?: number; fallback?: string } = {}
): string {
  const { maxLength = 150, fallback = 'document' } = options;

  if (!name || typeof name !== 'string') return fallback;

  // 1. Normalize Unicode (combines split characters like 'e' + '´' into 'é')
  let sanitized = name.normalize('NFC');

  // 2. Remove illegal OS characters and control characters (\p{Cc} safely targets control chars)
  sanitized = sanitized.replace(/[<>:"/\\|?*\p{Cc}]/gu, '');

  // 3. Collapse multiple spaces into one
  sanitized = sanitized.replace(/\s+/g, ' ');

  // 4. Remove leading/trailing spaces AND periods (Windows restriction)
  sanitized = sanitized.replace(/^[\s.]+/, '').replace(/[\s.]+$/, '');

  // 5. Handle Windows reserved names (applies even if there is an extension, e.g., CON.txt)
  const reservedWindowsNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
  if (reservedWindowsNames.test(sanitized)) {
    sanitized = `_${sanitized}`;
  }

  // 6. Safely truncate while preserving extensions and Unicode characters (emojis)
  const charArray = [...sanitized]; // Spread syntax safely counts Unicode surrogate pairs
  if (charArray.length > maxLength) {
    const lastDotIndex = sanitized.lastIndexOf('.');
    const hasExtension = lastDotIndex > 0 && lastDotIndex < sanitized.length - 1;

    if (hasExtension) {
      const extension = sanitized.slice(lastDotIndex);
      const baseNameChars = [...sanitized.slice(0, lastDotIndex)];
      
      // Calculate remaining space for the base name, leaving room for the extension
      const allowedBaseLength = Math.max(0, maxLength - extension.length);
      sanitized = baseNameChars.slice(0, allowedBaseLength).join('') + extension;
    } else {
      sanitized = charArray.slice(0, maxLength).join('');
    }
  }

  // 7. Final fallback check in case all characters were stripped
  return sanitized || fallback;
}
