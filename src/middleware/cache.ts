/**
 * Cache-Control header middleware for Hono API responses.
 *
 * Sets appropriate caching directives per content type and auth status,
 * enabling Vercel Edge and CDN caching for publicly cacheable responses.
 *
 * Strategy:
 *   - Unauthenticated GET/HEAD → short public cache (CDN-friendly)
 *   - Authenticated GET/HEAD → private, no-cache (user-specific data)
 *   - Error responses → no-store (never cache errors)
 *   - Mutations (POST/PUT/DELETE) → no-store
 */

import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../hono/env.js";

/** Cache durations in seconds */
const CACHE = {
  PUBLIC_CATALOGUE: 60,       // /api/books/explore, /api/books/trending
  PUBLIC_DETAIL: 10,          // /api/books/:slug
  PRIVATE_USER: 0,            // /api/user/*, /api/dashboard
  NEVER: 0,                   // Mutations, errors
} as const;

export const cacheControl = createMiddleware<AppEnv>(async (c, next) => {
  await next();

  // If the route handler already set its own Cache-Control, respect it.
  // Routes like GET /users/:identifier and various book endpoints have
  // hand-tuned values (e.g. stale-while-revalidate, per-path durations)
  // that are more precise than the middleware's generic rules.
  if (c.res.headers.has("Cache-Control")) {
    return;
  }

  const method = c.req.method;
  const status = c.res.status;

  // Never cache error responses or mutations
  if (status >= 400 || !["GET", "HEAD"].includes(method)) {
    c.header("Cache-Control", "no-store");
    return;
  }

  // Authenticated responses = private, short-lived
  const userId = c.get("userId");
  if (userId) {
    c.header("Cache-Control", `private, max-age=${CACHE.PRIVATE_USER}, must-revalidate`);
    return;
  }

  // Public catalogue responses → cache at CDN + browser
  // The path prefix tells us the content type
  const path = c.req.path;

  if (path.startsWith("/api/books/explore") || path.startsWith("/api/books/trending")) {
    c.header("Cache-Control", `public, max-age=${CACHE.PUBLIC_CATALOGUE}, s-maxage=${CACHE.PUBLIC_CATALOGUE * 5}`);
  } else if (path.startsWith("/api/books/")) {
    c.header("Cache-Control", `public, max-age=${CACHE.PUBLIC_DETAIL}, s-maxage=${CACHE.PUBLIC_DETAIL * 6}`);
  } else {
    // Other public GET endpoints — conservative default
    c.header("Cache-Control", "public, max-age=10, s-maxage=60");
  }
});
