/**
 * Serverless-compatible Hono setup
 *
 * Replaces the previous Express application. Routing, middleware, and error
 * handling now use Hono's web-standard Context object (`c`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { csrf } from "hono/csrf";
import { compress } from "hono/compress";
import { HTTPException } from "hono/http-exception";
import { initAuthConfig } from "@hono/auth-js";
import { parseJsonBody } from "./middleware/body.js";
import { extractLocale } from "./middleware/locale.js";
import { cacheControl } from "./middleware/cache.js";
import { rateLimitByUser } from "./middleware/rate-limit.js";
import { verifyNextAuthToken } from "./middleware/nextauth.js";
import routes from "./routes/index.js";
import { APP_NAME, VERSION } from "./config/constants.js";
import { IS_PRODUCTION } from "./config/env.js";
import type { AppEnv } from "./hono/env.js";

// Initialize Hono app with shared environment bindings.
const app = new Hono<AppEnv>();

// Security headers — defence-in-depth against common web vulnerabilities.
// Applied before CORS so they're present on every response including preflight
// and error responses. These headers should also be set at the reverse proxy
// (Vercel Edge, Cloudflare) but are duplicated here as a safety net for
// direct serverless-function invocations.
app.use("*", async (c, next) => {
  c.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("X-XSS-Protection", "0");
  await next();
});

// Response compression (gzip/deflate) for API responses.
// Compresses JSON payloads (book data, page content) by 60-80%.
// Vercel Edge may already compress, but this ensures compression
// for direct function invocations and self-hosted scenarios.
//
// Fluid Active CPU optimization: skip gzip for tiny realtime poll/status
// payloads. Repeated per-response compression on high-frequency endpoints
// (every /touch, /status, /candidates/status tick) is pure CPU with no
// meaningful bandwidth benefit on small bodies.
//
// Gated by CPU_OPTIMIZATIONS_ENABLED: on Vercel Pro / pay-as-you-go
// (DISABLE_CPU_OPTIMIZATIONS=true) the original compress() runs everywhere.
import { CPU_OPTIMIZATIONS_ENABLED } from "./config/cpu-optimizations.js";

const shouldSkipCompress = (path: string): boolean =>
  path.endsWith("/status") ||
  path.endsWith("/candidates/status") ||
  path.includes("/candidates/status") ||
  path === "/health" ||
  path === "/health/db";
app.use("*", async (c, next) => {
  if (CPU_OPTIMIZATIONS_ENABLED && shouldSkipCompress(c.req.path)) {
    await next();
    return;
  }
  await compress()(c, next);
});

// Cache-Control headers for CDN + browser caching.
// Public catalogue endpoints get multi-minute cache, authenticated
// responses are private, and mutations/errors skip cache entirely.
app.use("*", cacheControl);

// Allow multiple origins: production frontend and local development
const allowedOrigins = new Set([
  process.env.FRONTEND_URL,
  "https://twistloom-web.vercel.app", // Production (Vercel deployment)
  "https://localhost:3002", // Development (HTTPS) via `pnpm dev:ssl`
  "http://localhost:3001", // Development via `pnpm dev`
  // Portal (server-side fetch often has no Origin; listed for browser tools / future admin embeds)
  process.env.PORTAL_URL,
  "https://portal.twistloom.com",
  "http://localhost:5174",
].filter(Boolean) as string[]);

// CORS — mirrors the previous Express cors() configuration.
// Allows requests with no origin (mobile apps, curl, server-to-server) and
// explicit origins from the allowedOrigins set. Preview deployments must be
// added via the FRONTEND_URL env var.
app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return null; // Allow no-origin requests
      return allowedOrigins.has(origin) ? origin : null;
    },
    credentials: true, // Allow cookies for NextAuth authentication
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "stripe-signature"],
    exposeHeaders: ["Retry-After", "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset"],
  }),
);

// CSRF protection — blocks cross-origin mutation requests from malicious sites.
// Runs before body parsing and auth so malicious requests are rejected early.
// The Origin header is forwarded through Next.js's rewrite proxy, so this
// validates the browser's actual origin. No-origin requests (server-to-server
// calls via fetchWithLogs, mobile apps, CLI tools, Stripe webhooks) pass.
app.use("/api/*", csrf({
  origin: (origin) => {
    if (!origin) return true; // Allow no-origin (server-to-server, mobile, CLI, webhooks)
    return allowedOrigins.has(origin); // Only allow explicit origins
  },
}));

// Auth.js v5 configuration for @hono/auth-js (cookie verification only).
// The backend does not run OAuth flows; it merely verifies the session cookie
// set by the Next.js frontend. trustHost is required behind Vercel's proxy.
app.use(
  "*",
  initAuthConfig(() => ({
    secret: process.env.AUTH_SECRET,
    trustHost: true,
    providers: [], // Backend only verifies; it doesn't handle OAuth flows
  })),
);

// Authenticate user session before body parsing.
// @hono/auth-js getAuthUser wraps c.req.raw in a new Request, which throws
// "Response body object should not be disturbed or locked" when the body
// stream has already been consumed (e.g., by parseJsonBody). Running auth
// first keeps the raw body pristine for getAuthUser.
app.use("/api/*", async (c, next) => {
  const user = await verifyNextAuthToken(c);
  if (user) {
    c.set("user", user);
    c.set("userId", user.id);
  }
  await next();
});

// Parse JSON request bodies once per request (replaces express.json()).
app.use("*", parseJsonBody);

// Extract Accept-Language header for translation lookups.
app.use("*", extractLocale);

// Global rate limiting (100 req/min per user). Skips public requests.
app.use("/api/*", rateLimitByUser);

// Handle favicon requests to prevent 404 errors
app.on("GET", "/favicon.png", (c) => c.body(null, 204));
app.on("GET", "/favicon.ico", (c) => c.body(null, 204));

// Public API routes
app.route("/api", routes);

// Root endpoint
app.get("/", (c) => {
  return c.json({
    message: `${APP_NAME} Backend`,
    version: VERSION,
    endpoints: {
      "/health": "Health check endpoint",
      "/api": "API root endpoint",
    },
  });
});

const startedAt = Date.now();

// Health check endpoint
// Lightweight zero-compute health check (Fluid CPU optimized: no DB query or SDK instantiation)
app.get("/health", (c) => {
  return c.json({
    ok: true,
    uptime: (Date.now() - startedAt) / 1000,
    timestamp: new Date().toISOString(),
  });
});

// Readiness probe — verifies database connectivity. Deliberately separate from
// the cheap /health liveness endpoint so orchestrators can require Postgres to
// be reachable before routing traffic, without inflating Neon active_time on
// every lightweight liveness ping. The DB client is imported lazily inside the
// handler to keep the /health path truly zero-compute.
app.get("/health/db", async (c) => {
  const start = Date.now();
  try {
    const { dbRead } = await import("./db/client.js");
    const { sql } = await import("drizzle-orm");
    await dbRead.execute(sql`select 1`);
    return c.json({
      ok: true,
      db: "up",
      latencyMs: Date.now() - start,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return c.json(
      {
        ok: false,
        db: "down",
        error: getErrorMessageSafe(err),
        timestamp: new Date().toISOString(),
      },
      503,
    );
  }
});

// Backward-compatible redirects
app.get("/user", (c) => c.redirect("/api/user"));
app.get("/books", (c) => c.redirect("/api/books"));

// Global error handler — formats HTTPException and unexpected errors uniformly.
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ success: false, error: err.message }, err.status);
  }
  console.error("[app] ❌ Unhandled error:", err);
  return c.json(
    { success: false, error: IS_PRODUCTION ? "Internal Server Error" : getErrorMessageSafe(err) },
    500,
  );
});

// Not-found handler
app.notFound((c) => {
  return c.json({ success: false, error: "Not Found" }, 404);
});

function getErrorMessageSafe(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

// ---------------------------------------------------------------------------
// Vercel entrypoint (consolidated from the former `api/index.ts`).
//
// Vercel's Hono framework preset auto-detects `src/app.ts` as the serverless
// entrypoint and deploys its default export. If that default export were
// `app.fetch`, a legacy Node `(req, res)` invocation would hand Hono a raw
// `IncomingMessage` — whose `headers` is a plain object with no `.get()`
// method, crashing CORS/compress middleware with
// `TypeError: this.raw.headers.get is not a function`.
//
// So the conversion logic that used to live in `api/index.ts` now lives here
// as the default export. `api/index.ts` re-exports it, which means whichever
// file Vercel deploys serves the identical handler: it always hands Hono a
// spec-compliant Web `Request` and pipes the response back through whatever
// output path Vercel expects. It supports both Vercel Node.js execution modes:
//   - Legacy Serverless — `(IncomingMessage, ServerResponse)`, writes through `res`.
//   - Fluid Compute    — Web API `Request`, returns a `Response`.
// ---------------------------------------------------------------------------

export const config = { runtime: "nodejs" };

export default async function vercelHandler(
  req: Request | IncomingMessage,
  maybeRes?: ServerResponse,
): Promise<Response | void> {
  try {
    // --------------------------------------------------------------------
    // STEP 1 — Detect the incoming request type
    // --------------------------------------------------------------------
    // `IncomingMessage.rawHeaders` is an `[key, val, key, val, …]` array that
    // the Web API `Request` does not have — the most reliable discriminator
    // between the two Vercel runtimes. We cast before the check because
    // TypeScript cannot narrow a union from a standalone boolean.
    const isIncomingMessage =
      typeof (req as IncomingMessage).rawHeaders !== "undefined";

    // This will hold the canonical Request we hand off to Hono.
    let honoRequest: Request;

    // --------------------------------------------------------------------
    // STEP 2a — Legacy Node.js Serverless path (IncomingMessage → Request)
    // --------------------------------------------------------------------
    if (isIncomingMessage) {
      const incoming = req as IncomingMessage;

      // Reconstruct the URL. Vercel terminates TLS at its edge proxy, so the
      // original protocol is carried in `x-forwarded-proto`; the original host
      // arrives via `x-forwarded-host`.
      const protocol =
        (incoming.headers["x-forwarded-proto"] as string) ||
        ((incoming.socket as { encrypted?: boolean } | undefined)?.encrypted
          ? "https"
          : "http");
      const host =
        (incoming.headers["x-forwarded-host"] as string) ||
        (incoming.headers["host"] as string) ||
        "localhost";
      const url = `${protocol}://${host}${incoming.url ?? "/"}`;

      // Buffer the body. Acceptable on Vercel because the platform enforces a
      // 4.5 MB payload limit. GET/HEAD requests have no body, so skip the async
      // drain entirely (Fluid Active CPU + latency optimization for poll routes).
      //
      // Typed as `Uint8Array | null`. The runtime value is a `Buffer` (a `Uint8Array`
      // subclass), which is a valid request body at runtime; the cast to `BodyInit`
      // happens at the `new Request(...)` call site to satisfy the DOM lib typing.
      let body: Uint8Array | null = null;
      if (incoming.method !== "GET" && incoming.method !== "HEAD") {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        if (chunks.length > 0) body = Buffer.concat(chunks);
      }

      // Extract headers from rawHeaders, skipping HTTP/2 pseudo-headers
      // (`:method`, `:path`, … — they start with char code 58).
      const headers: Record<string, string> = {};
      const rawHeaders = incoming.rawHeaders;
      for (let i = 0; i < rawHeaders.length; i += 2) {
        const key = rawHeaders[i];
        if (key.charCodeAt(0) !== 58) headers[key] = rawHeaders[i + 1];
      }

      // Building a new `Request` normalises the plain-object headers into a
      // spec-compliant `Headers` instance with a `.get()` method.
      // `body` is a `Buffer`/`Uint8Array`, which is valid `BodyInit` at runtime but
      // not directly assignable under @types/node's generic `Buffer`/`Uint8Array`
      // typing vs the DOM `BodyInit` union — hence the targeted cast.
      honoRequest = new Request(url, { method: incoming.method, headers, body: body as BodyInit | null });
    } else {
      // ------------------------------------------------------------------
      // STEP 2b — Fluid Compute path (Request → Request)
      // ------------------------------------------------------------------
      // Vercel might pass a Request whose `headers` is a plain object rather
      // than the Web API `Headers` class. Rebuilding through `new Request()`
      // guarantees spec-compliant `Headers` that Hono's CORS middleware and
      // others depend on.
      const webReq = req as unknown as Request;
      honoRequest = new Request(webReq.url, {
        method: webReq.method,
        headers: webReq.headers, // Headers | Record → Headers
        body: webReq.body, // ReadableStream | null passthrough
      });
    }

    // --------------------------------------------------------------------
    // STEP 3 — Dispatch through Hono
    // --------------------------------------------------------------------
    // `honoRequest` is always a fresh, spec-compliant `Request` with proper
    // `Headers.get()`, so every middleware can safely call `c.req.header()`.
    const response = await app.fetch(honoRequest);

    // --------------------------------------------------------------------
    // STEP 4 — Write the Hono Response back to Vercel
    // --------------------------------------------------------------------
    if (maybeRes && typeof maybeRes.statusCode === "number") {
      // --- Legacy Serverless path: write through ServerResponse ---------
      maybeRes.statusCode = response.status;

      // Copy all response headers onto the ServerResponse. Set-Cookie needs
      // special care: `Headers.forEach()` coalesces repeated keys into
      // comma-joined strings (wrong for Set-Cookie), so we collect them into
      // an array and let Node serialise separate `Set-Cookie` lines.
      const setCookieValues: string[] = [];
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() === "set-cookie") {
          setCookieValues.push(value);
        } else {
          maybeRes.setHeader(key, value);
        }
      });
      if (setCookieValues.length > 0) {
        maybeRes.setHeader("Set-Cookie", setCookieValues);
      }

      // Stream the response body bytes through the ServerResponse using the
      // Web `ReadableStream`'s reader.
      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          maybeRes.write(value);
        }
      }
      maybeRes.end();
      return; // ← must return void for Legacy Serverless
    }

    // --- Fluid Compute path: return the Response object directly ---------
    return response;

    // --------------------------------------------------------------------
    // STEP 5 — Error handling
    // --------------------------------------------------------------------
  } catch (error) {
    console.error("[vercel-handler] Unhandled error:", error);

    // If we still have a valid ServerResponse that hasn't started sending,
    // write a JSON 500 error instead of crashing the invocation.
    if (maybeRes && typeof maybeRes.statusCode === "number" && !maybeRes.headersSent) {
      maybeRes.statusCode = 500;
      maybeRes.setHeader("Content-Type", "application/json");
      maybeRes.end(JSON.stringify({ success: false, error: "Internal Server Error" }));
      return;
    }

    // No ServerResponse available (pure-Fluid-Compute path) or headers already
    // sent — let Vercel handle the error.
    throw error;
  }
}

export { app };
