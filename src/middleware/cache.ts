/**
 * Cache-Control header middleware for Hono API responses.
 *
 * Sets appropriate caching directives per content type and auth status,
 * enabling CDN and browser caching for publicly cacheable responses.
 *
 * Strategy:
 *   - Unauthenticated GET/HEAD → short public cache + Netlify edge/durable
 *     opt-in via `Netlify-CDN-Cache-Control` (see src/utils/netlify-cache.ts)
 *   - Authenticated GET/HEAD → private, no-cache (user-specific data)
 *   - Error responses → no-store (never cache errors)
 *   - Mutations (POST/PUT/DELETE) → no-store
 *
 * Platform note: `s-maxage` only collapses traffic at an edge that honors it.
 * Netlify's shared CDN ignores `private` responses entirely and reads its own
 * `Netlify-CDN-Cache-Control` header, so authenticated bursts are dampened by
 * the app-layer `coalescePoll` / `getCoalesced` LRU rather than by the CDN.
 */

import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../hono/env.js";
import { applyPublicCdnCache } from "../utils/netlify-cache.js";

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

  const path = c.req.path;

  // Authenticated responses: allow short private caching with SWR on content reads
  // to avoid redundant serverless function invocations during back-and-forth reading
  const userId = c.get("userId");
  if (userId) {
    // Realtime status polling endpoints (book creation + candidate generation):
    // allow a SHORT private browser cache so identical polls from the same
    // client are collapsed without invoking the serverless function on every
    // 1–2s tick. This is the P1.2/P1.4 invocation reducer — the per-instance
    // LRU in poll-coalesce.ts already collapses same-instance bursts; this adds
    // client-side collapse. 1–2s staleness is imperceptible for generation
    // progress. `private` (not `public`) keeps the per-user payload from
    // leaking across users at any shared CDN. Truly realtime endpoints
    // (checkin/status, notifications, activity-logs, generations/active)
    // stay fully uncached below.
    const isStatusPoll =
      (path.endsWith("/status") && !path.includes("/checkin/status")) ||
      path.endsWith("/candidates/status");
    if (isStatusPoll) {
      // `private` is mandatory here (user-scoped payload). Netlify's shared CDN
      // never stores `private` responses, so a `s-maxage` directive would be
      // inert and misleading — the real poll-burst dampener is the app-layer
      // `coalescePoll` / `getCoalesced` LRU, which is runtime-agnostic.
      c.header("Cache-Control", "private, max-age=1, stale-while-revalidate=2");
      return;
    }

    // Truly realtime endpoints must stay uncached
    if (
      path.includes("/generations/active") ||
      path.includes("/notifications") ||
      path.includes("/checkin/status") ||
      path.includes("/activity-logs")
    ) {
      c.header("Cache-Control", `private, max-age=${CACHE.PRIVATE_USER}, must-revalidate`);
      return;
    }

    // Safe content reads (book metadata, pages, branches, testimonials)
    if (path.startsWith("/api/books/")) {
      c.header("Cache-Control", "private, max-age=5, stale-while-revalidate=30");
      return;
    }

    // Other authenticated GET endpoints (user profile, in-app prefs)
    c.header("Cache-Control", "private, max-age=5, stale-while-revalidate=15");
    return;
  }

  // Public catalogue responses → cache at CDN + browser
  // The path prefix tells us the content type
  if (path.startsWith("/api/books/explore") || path.startsWith("/api/books/trending")) {
    c.header("Cache-Control", `public, max-age=${CACHE.PUBLIC_CATALOGUE}, s-maxage=${CACHE.PUBLIC_CATALOGUE * 5}`);
  } else if (path.startsWith("/api/books/")) {
    c.header("Cache-Control", `public, max-age=${CACHE.PUBLIC_DETAIL}, s-maxage=${CACHE.PUBLIC_DETAIL * 6}`);
  } else {
    // Other public GET endpoints — conservative default
    c.header("Cache-Control", "public, max-age=10, s-maxage=60");
  }

  // Netlify shared-cache opt-in for the genuinely public reads above.
  // Emits `Netlify-CDN-Cache-Control` + `Netlify-Cache-Tag` (inert on Vercel
  // and every other CDN) and is a no-op for user-scoped or cookie-setting
  // responses. See src/utils/netlify-cache.ts.
  applyPublicCdnCache(c, path);
});
