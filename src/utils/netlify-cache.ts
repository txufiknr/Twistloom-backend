/**
 * @overview Netlify CDN cache helpers (headers + on-demand tag purge)
 *
 * Netlify does **not** cache function responses by default. Standard
 * `Cache-Control` only reaches the visitor's browser — the CDN opt-in header is
 * `Netlify-CDN-Cache-Control` (most specific header wins). Responses can also be
 * tagged with `Netlify-Cache-Tag` and purged on demand through the Netlify API,
 * so longer TTLs are safe as long as mutations purge their tags.
 *
 * Platform safety:
 * - The headers emitted here are **inert** on Vercel, local Bun, and any other
 *   CDN (unknown response headers are ignored), so this module never changes
 *   behavior outside Netlify.
 * - `purgeNetlifyCacheTags` is a **no-op** unless the process is actually
 *   running on Netlify (`process.env.NETLIFY`), and it fails open on any error
 *   so a purge outage can never break a mutation.
 *
 * Constraints worth knowing before adding a call site:
 * - Only `GET` responses are cached; the whole query string is part of the
 *   cache key unless `Netlify-Vary` narrows it.
 * - `private` responses are never stored in Netlify's shared cache.
 * - Purge rate limit: a tag/site may be purged at most **twice per 5 seconds**
 *   (HTTP 429 beyond that) — callers must batch tags into a single call, which
 *   this module additionally de-duplicates per process.
 * - Purge credentials: none required. A deployed function reads `SITE_ID` and
 *   `NETLIFY_PURGE_API_TOKEN` from its runtime environment. The optional
 *   `NETLIFY_SITE_ID` / `NETLIFY_AUTH_TOKEN` overrides exist for CI and local
 *   scripts only.
 *
 * @see https://docs.netlify.com/build/caching/caching-overview/
 */

import type { Context } from "hono";
import type { AppEnv } from "../hono/env.js";

/** CDN-only cache directives — honored by Netlify's edge/durable cache. */
export const NETLIFY_CDN_CACHE_CONTROL_HEADER = "Netlify-CDN-Cache-Control";

/** Cache tags attached to a response for later on-demand purging. */
export const NETLIFY_CACHE_TAG_HEADER = "Netlify-Cache-Tag";

/** Shared catalogue tags purged whenever the explore/trending cache is invalidated. */
export const CATALOGUE_CACHE_TAGS = ["explore", "trending", "stats"] as const;

/** Minimum interval between two purge calls for the same tag, in milliseconds. */
const TAG_PURGE_DEDUPE_MS = 5_000;

/** Last purge timestamp per tag, process-local (best effort on serverless). */
const lastPurgedAt = new Map<string, number>();

/** Configuration for an opt-in shared-cache response. */
export interface CdnCacheOptions {
  /** Browser + CDN freshness lifetime, in seconds. */
  maxAge: number;
  /** Shared-cache grace period after expiry, in seconds. */
  staleWhileRevalidate?: number;
  /**
   * Persist the response in the shared cache co-located with the functions
   * region (`durable`). Serverless-only; ignored elsewhere.
   */
  durable?: boolean;
  /** Tags used to purge this response on demand (see {@link purgeNetlifyCacheTags}). */
  tags?: readonly string[];
}

/**
 * Emits `Netlify-CDN-Cache-Control` (and optional `Netlify-Cache-Tag`) so a
 * public response is stored at Netlify's edge/durable cache instead of invoking
 * the function on every request.
 *
 * Must only be called for genuinely public, shareable `GET` responses that set
 * no `Set-Cookie` — user-scoped responses stay `private` and uncached.
 *
 * @param c - Hono context of the response being finalized
 * @param options - TTL, `durable` flag, and cache tags
 *
 * @example
 * ```ts
 * setCdnCache(c, { maxAge: 30, staleWhileRevalidate: 120, durable: true, tags: ["explore"] });
 * ```
 */
export function setCdnCache(c: Context<AppEnv>, options: CdnCacheOptions): void {
  const directives = ["public", `max-age=${options.maxAge}`];
  if (options.durable) directives.push("durable");
  if (options.staleWhileRevalidate !== undefined) {
    directives.push(`stale-while-revalidate=${options.staleWhileRevalidate}`);
  }
  c.header(NETLIFY_CDN_CACHE_CONTROL_HEADER, directives.join(", "));
  if (options.tags && options.tags.length > 0) {
    setCacheTags(c, options.tags);
  }
}

/**
 * Attaches cache tags to a response without changing its TTL directives.
 *
 * @param c - Hono context of the response being finalized
 * @param tags - Cache tags (comma-separated on the wire)
 */
export function setCacheTags(c: Context<AppEnv>, tags: readonly string[]): void {
  if (tags.length === 0) return;
  c.header(NETLIFY_CACHE_TAG_HEADER, [...new Set(tags)].join(", "));
}

/**
 * Applies the shared-cache opt-in headers for the genuinely public, shareable
 * reads in this codebase. Called once from the `cacheControl` middleware so all
 * Netlify-specific cache policy lives in this module and can be removed with a
 * single call site.
 *
 * Never applies to user-scoped or `Set-Cookie` responses; book **detail**
 * responses are deliberately excluded because they are keyed by slug with no
 * purge hook yet (their browser TTL is short enough to self-correct).
 *
 * @param c - Hono context of the response being finalized
 * @param path - Request pathname (`c.req.path`)
 */
export function applyPublicCdnCache(c: Context<AppEnv>, path: string): void {
  if (!["GET", "HEAD"].includes(c.req.method) || c.res.status >= 400) return;
  if (c.res.headers.has("Set-Cookie")) return;
  if (c.res.headers.has(NETLIFY_CDN_CACHE_CONTROL_HEADER)) return;

  if (path.startsWith("/api/books/explore")) {
    setCdnCache(c, { maxAge: 60, staleWhileRevalidate: 120, durable: true, tags: ["explore"] });
    return;
  }
  if (path.startsWith("/api/books/trending")) {
    setCdnCache(c, { maxAge: 60, staleWhileRevalidate: 120, durable: true, tags: ["trending"] });
    return;
  }
  if (path === "/api/books/stats") {
    setCdnCache(c, { maxAge: 30, staleWhileRevalidate: 120, durable: true, tags: ["stats"] });
    return;
  }
  if (path === "/") {
    setCdnCache(c, { maxAge: 10, staleWhileRevalidate: 60, durable: true, tags: ["root"] });
  }
}

/**
 * Purges the given Netlify cache tags on demand — fail-open, no-op off-Netlify.
 *
 * Call **after** the database transaction commits and **outside** the
 * transaction boundary (AGENTS.md §3.3): a purge failure must never roll back a
 * successful mutation, and the CDN TTL remains the correctness backstop.
 *
 * @param tags - Cache tags to purge; empty arrays and non-Netlify runtimes no-op
 * @returns Resolves when the purge request settles (or is skipped)
 *
 * @example
 * ```ts
 * await purgeNetlifyCacheTags(CATALOGUE_CACHE_TAGS);
 * ```
 */
export async function purgeNetlifyCacheTags(tags: readonly string[]): Promise<void> {
  if (tags.length === 0) return;
  if (!process.env.NETLIFY) return;

  const now = Date.now();
  const freshTags = [...new Set(tags)].filter((tag) => {
    const lastPurged = lastPurgedAt.get(tag);
    return lastPurged === undefined || now - lastPurged >= TAG_PURGE_DEDUPE_MS;
  });
  if (freshTags.length === 0) return;

  // Overrides are optional. Inside a deployed Netlify Function the library
  // infers both the site id (`SITE_ID`) and the purge credential
  // (`NETLIFY_PURGE_API_TOKEN`) from the runtime environment, so production
  // needs no configuration at all. Explicit values are only useful from CI or a
  // local script running outside the platform.
  const siteID = process.env.NETLIFY_SITE_ID ?? process.env.SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN ?? process.env.NETLIFY_PURGE_API_TOKEN;
  const overrides: { siteID?: string; token?: string } = {};
  if (siteID) overrides.siteID = siteID;
  if (token) overrides.token = token;

  for (const tag of freshTags) lastPurgedAt.set(tag, now);

  try {
    const { purgeCache } = await import("@netlify/functions");
    await purgeCache({ ...overrides, tags: freshTags });
  } catch (error) {
    lastPurgedAt.clear();
    console.warn(
      "[NetlifyCache] purge failed-open:",
      error instanceof Error ? error.message : String(error),
      "— if the token is missing, set NETLIFY_AUTH_TOKEN (Netlify UI, Functions scope)"
    );
  }
}
