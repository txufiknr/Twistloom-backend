/**
 * Serverless-compatible Hono setup
 *
 * Replaces the previous Express application. Routing, middleware, and error
 * handling now use Hono's web-standard Context object (`c`).
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { initAuthConfig } from "@hono/auth-js";
import { parseJsonBody } from "./middleware/body.js";
import { extractLocale } from "./middleware/locale.js";
import { rateLimitByUser } from "./middleware/rate-limit.js";
import { verifyNextAuthToken } from "./middleware/nextauth.js";
import routes from "./routes/index.js";
import { APP_NAME, VERSION } from "./config/constants.js";
import { IS_PRODUCTION } from "./config/env.js";
import type { AppEnv } from "./hono/env.js";

// Initialize Hono app with shared environment bindings
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

// Allow multiple origins: production frontend and local development
const allowedOrigins = new Set([
  process.env.FRONTEND_URL,
  "https://twistloom-web.vercel.app", // Production (Vercel deployment)
  "https://localhost:3002", // Development (HTTPS) via `pnpm dev:ssl`
  "http://localhost:3001", // Development via `pnpm dev`
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

// Health check endpoint
app.get("/health", (c) => {
  return c.json({ ok: true, uptime: process.uptime() });
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

// Local dev entry imports the Hono instance directly (see src/server.ts).
export { app };

// ---------------------------------------------------------------------------
// Vercel serverless function handler
// ---------------------------------------------------------------------------
//
// WHY NOT getRequestListener?
// ===========================
// `getRequestListener` from `@hono/node-server` wraps the Node.js
// IncomingMessage in a ReadableStream via `Readable.toWeb()`. On Vercel's
// Node.js runtime the request body is already pre-buffered, so the stream's
// `end`/`data` events never fire — the body-read promise hangs indefinitely
// until Vercel's 300s platform timeout kills the function.
//
// WHY NOT hono/vercel?
// ====================
// `hono/vercel` is designed for Vercel's Edge Runtime. Importing it causes
// Vercel's build system to expect an Edge function, creating a runtime
// conflict that manifests as MIDDLEWARE_INVOCATION_TIMEOUT.
//
// THIS APPROACH
// =============
// A plain Node.js (IncomingMessage, ServerResponse) handler that:
//   1. Reads the body via for await...of (reliable on all runtimes)
//   2. Creates a standard Web API Request from the buffered body
//   3. Passes it to app.fetch
//   4. Writes the Response back to the ServerResponse
//
// References
//   - https://github.com/honojs/node-server/issues/306
//   - https://github.com/honojs/node-server/issues/84
// ---------------------------------------------------------------------------

import type { IncomingMessage, ServerResponse } from "node:http";

export default async function vercelHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    // Reconstruct the absolute URL from headers
    const protocol =
      (req.headers["x-forwarded-proto"] as string) ||
      ((req.socket as { encrypted?: boolean } | undefined)?.encrypted
        ? "https"
        : "http");
    const host =
      (req.headers["x-forwarded-host"] as string) ||
      (req.headers["host"] as string) ||
      "localhost";
    const url = `${protocol}://${host}${req.url ?? "/"}`;

    // Read the full request body using for await...of on the raw stream.
    // This is the key fix — getRequestListener's Readable.toWeb() hangs.
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bodyBuffer =
      req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0
        ? Buffer.concat(chunks)
        : null;

    // Build headers, skipping HTTP/2 pseudo-headers
    const headers: Record<string, string> = {};
    const rawHeaders = req.rawHeaders;
    for (let i = 0; i < rawHeaders.length; i += 2) {
      const key = rawHeaders[i];
      if (key.charCodeAt(0) !== 58) headers[key] = rawHeaders[i + 1];
    }

    // Create a standard Web API Request and pass to Hono
    const request = new Request(url, {
      method: req.method,
      headers,
      body: bodyBuffer,
    });
    const response = await app.fetch(request);

    // Write response status and headers
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === "set-cookie") {
        const cookies = response.headers.getSetCookie?.() ?? [value];
        for (const cookie of cookies) res.setHeader("Set-Cookie", cookie);
      } else {
        res.setHeader(key, value);
      }
    });

    // Stream the response body
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  } catch (error) {
    console.error("[vercel-handler] ❌ Unhandled error:", error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ success: false, error: "Internal Server Error" }));
    } else {
      res.end();
    }
  }
}
