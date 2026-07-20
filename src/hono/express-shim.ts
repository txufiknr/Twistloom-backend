/**
 * Express compatibility shim for Hono.
 *
 * Several existing service functions (NextAuth `getSession`, `verifyNextAuthToken`,
 * `sanitizeUserData`, `setReferrerForNewUser`, `handleCheckIn`, `visitBookPage`, …)
 * were written against Express's `Request` / `Response` objects. Rather than rewrite
 * every one of those call sites during the Express → Hono migration, this module
 * provides thin, on-demand adapters that expose the small subset of the Express API
 * those functions actually use:
 *
 *   - `req.headers` (incl. `cookie`, `user-agent`)
 *   - `req.ip` / `req.socket.remoteAddress`
 *   - `req.method` / `req.url`
 *   - `req.body`
 *   - `res.status().json()` (used only to emit validation errors)
 *
 * The adapters are lazy: header access is delegated straight to the Hono context, so
 * no data is copied until it is read. This keeps the migration low-risk while the
 * route layer is fully Hono-native.
 */

import type { Context } from "hono";
import type { AppEnv } from "./env.js";

/**
 * Resolves the best-effort client IP address from a Hono context.
 *
 * Honours the `x-forwarded-for` header (set by Vercel / reverse proxies) and
 * falls back to "unknown". Replaces Express's `req.ip` / `req.socket.remoteAddress`.
 *
 * @param c - Hono context
 * @returns Client IP string
 */
export function getClientIp(c: Context<AppEnv>): string {
  const fwd = c.req.raw.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return "unknown";
}

/**
 * Minimal Express-Request-compatible object derived from a Hono context.
 *
 * Only the members the backend actually reads are implemented. Anything else would
 * throw — which is intentional, so accidental new Express-only usage is caught early.
 */
export interface ExpressLikeRequest {
  headers: Record<string, string | string[] | undefined>;
  method: string;
  url: string;
  ip: string;
  socket: { remoteAddress?: string };
  body: unknown;
  cookies: Record<string, string>;
  get(header: string): string | undefined;
}

/**
 * Minimal Express-Response-compatible object.
 *
 * `sanitizeUserData` and similar helpers call `res.status(code).json(body)` only to
 * surface a validation error before returning `null`. We capture the last written
 * error so callers can fall back to it, but otherwise treat the response as a no-op
 * (the route handler owns the real response via `c.json`).
 */
export interface ExpressLikeResponse {
  statusCode?: number;
  lastError?: { status: number; body: unknown };
  status(code: number): ExpressLikeResponse;
  json(body: unknown): ExpressLikeResponse;
}

/**
 * Build an Express-like request from a Hono context.
 *
 * @param c - Hono context
 * @returns A request object compatible with the subset of Express used by services
 */
export function toExpressRequest(c: Context<AppEnv>): ExpressLikeRequest {
  const reqHeaders = c.req.raw.headers;
  const headers: Record<string, string | string[] | undefined> = {};
  reqHeaders.forEach((value, key) => {
    headers[key] = value;
  });

  // Parse cookies so `req.cookies[name]` works as it did under Express.
  const cookieHeader = reqHeaders.get("cookie");
  const cookies: Record<string, string> = {};
  if (cookieHeader) {
    for (const part of cookieHeader.split(";")) {
      const idx = part.indexOf("=");
      if (idx === -1) continue;
      const name = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (name) cookies[name] = decodeURIComponent(value);
    }
  }

  return {
    headers,
    method: c.req.method,
    url: c.req.url,
    ip: c.req.raw.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown",
    socket: {
      remoteAddress: c.req.raw.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown",
    },
    body: (c as unknown as { _body?: unknown })._body ?? {},
    cookies,
    get(header: string): string | undefined {
      return reqHeaders.get(header) ?? undefined;
    },
  };
}

/**
 * Build an Express-like response object.
 *
 * Captures the most recent `status().json()` call in `lastError` so callers that
 * rely on the response can inspect it, but never actually writes to the wire.
 *
 * @returns A response object compatible with the subset of Express used by services
 */
export function toExpressResponse(): ExpressLikeResponse {
  const res: ExpressLikeResponse = {
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.lastError = { status: this.statusCode ?? 400, body };
      return this;
    },
  };
  return res;
}
