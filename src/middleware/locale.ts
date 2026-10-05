/**
 * @overview Locale Middleware (Hono)
 *
 * Extracts and parses the Accept-Language header from HTTP requests.
 * Adds the parsed language code to the Hono context variables for use in
 * translation lookups.
 *
 * Features:
 * - Extracts Accept-Language header from request
 * - Parses language code (e.g., "en-US,en;q=0.9" → "en")
 * - Adds language to context as `headerLanguage` (via `c.get("headerLanguage")`)
 * - Returns null if no Accept-Language header is present
 *
 * Usage:
 * - Applied globally in app.ts
 * - Access via `c.get("headerLanguage")` in route handlers
 * - Used for translation lookup in book queries
 */

import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../hono/env.js";

/**
 * Middleware to extract and parse Accept-Language header.
 *
 * Parses the Accept-Language header and adds the primary language code
 * to the context variables for translation lookups.
 *
 * @example
 * // Request with header: Accept-Language: "en-US,en;q=0.9,es;q=0.8"
 * // Result: c.get("headerLanguage") === "en"
 */
export const extractLocale = createMiddleware<AppEnv>(async (c, next) => {
  const acceptLanguage = c.req.header("accept-language");
  const headerLanguage = acceptLanguage
    ? acceptLanguage.split(",")[0].split("-")[0].trim()
    : null;
  c.set("headerLanguage", headerLanguage);
  await next();

  // Vary guard: the response body can depend on `headerLanguage`, so any shared
  // cache (Vercel edge, Netlify CDN/durable cache) must key on Accept-Language.
  // Without it, caching one localized public response would serve that single
  // language to every visitor. Only cacheable safe methods are tagged; the
  // header is additive so route-level `Vary` values are preserved.
  if (!["GET", "HEAD"].includes(c.req.method) || c.res.status >= 400) {
    return;
  }
  const existing = c.res.headers.get("Vary");
  if (existing) {
    const directives = existing
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const alreadySet = directives.some(
      (value) => value === "*" || value.toLowerCase() === "accept-language"
    );
    if (!alreadySet) {
      c.header("Vary", [...directives, "Accept-Language"].join(", "));
    }
    return;
  }
  c.header("Vary", "Accept-Language");
});
