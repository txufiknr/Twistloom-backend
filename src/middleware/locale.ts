/**
 * @overview Locale Middleware
 * 
 * Extracts and parses the Accept-Language header from HTTP requests.
 * Adds the parsed language code to the request object for use in translation lookups.
 * 
 * Features:
 * - Extracts Accept-Language header from request
 * - Parses language code (e.g., "en-US,en;q=0.9" → "en")
 * - Adds language to request object as `headerLanguage`
 * - Returns null if no Accept-Language header is present
 * 
 * Usage:
 * - Applied globally in app.ts
 * - Access via `req.headerLanguage` in route handlers
 * - Used for translation lookup in book queries
 */

import type { Request, Response, NextFunction } from 'express';

/**
 * Middleware to extract and parse Accept-Language header
 * 
 * Parses the Accept-Language header and adds the primary language code
 * to the request object for translation lookups.
 * 
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 * 
 * @example
 * // Request with header: Accept-Language: "en-US,en;q=0.9,es;q=0.8"
 * // Result: req.headerLanguage = "en"
 */
export function extractLocale(req: Request, res: Response, next: NextFunction): void {
  const acceptLanguage = req.headers['accept-language'] as string | undefined;
  req.headerLanguage = acceptLanguage ? acceptLanguage.split(',')[0].split('-')[0].trim() : null;
  next();
}
