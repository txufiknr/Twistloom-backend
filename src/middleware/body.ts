/**
 * JSON body parsing middleware (Hono)
 *
 * Replaces Express's `express.json()` global parser. It reads the request body
 * once per request, parses JSON, and stores the result on the context as `body`
 * (available via `c.get("body")`). This keeps route handlers free of repetitive
 * `await c.req.json()` calls and matches the previous `req.body` ergonomics.
 *
 * - Only attempts to parse when the Content-Type is `application/json`.
 * - Enforces a generous body size limit (feedback submissions embed base64
 *   screenshots that exceed the old 1mb default, so 10mb is used globally).
 * - On parse failure, leaves `body` unset so handlers can return a 400 if needed.
 * - Non-JSON requests (multipart, form, raw) are left untouched; dedicated
 *   handlers parse those themselves (e.g. Stripe webhook uses `c.req.text()`).
 */

import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../hono/env.js";

const MAX_JSON_BODY_BYTES = 10 * 1024 * 1024; // 10mb

export const parseJsonBody = createMiddleware<AppEnv>(async (c, next) => {
  const contentType = c.req.header("content-type");
  if (!contentType || !contentType.includes("application/json")) {
    await next();
    return;
  }

  const raw = await c.req.text();
  if (raw.length === 0) {
    c.set("body", {});
    await next();
    return;
  }

  if (new TextEncoder().encode(raw).length > MAX_JSON_BODY_BYTES) {
    throw new HTTPException(413, { message: "Payload too large" });
  }

  try {
    c.set("body", JSON.parse(raw));
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  await next();
});
