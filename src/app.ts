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

const startedAt = Date.now();

// Health check endpoint
app.get("/health", (c) => {
  return c.json({ ok: true, uptime: (Date.now() - startedAt) / 1000 });
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
// Vercel handler — Node.js runtime (recommended by Vercel)
// ---------------------------------------------------------------------------
//
// Vercel now recommends the Node.js runtime over Edge — both run on Fluid
// Compute with Active CPU pricing, but Node.js has no 30s timeout cap and
// full Node.js API support. See https://vercel.com/docs/functions/runtimes/edge
//
// Fluid Compute passes a Web API Request directly (fast path). Legacy
// Node.js Serverless wrappers pass IncomingMessage (conversion path).
//
// WHY NOT hono/vercel handle()?
//   `handle(app)` is just (req) => app.fetch(req) — it passes the raw
//   request with no conversion. On legacy Node.js Serverless, that means
//   IncomingMessage reaches Hono as c.req.raw, and c.req.raw.headers.get()
//   throws because IncomingMessage.headers is a plain object, not a Headers
//   instance. This was the original deployment error.
//
// WHY NOT @hono/node-server getRequestListener?
//   It wraps IncomingMessage in a ReadableStream via Readable.toWeb(). On
//   Vercel's Node.js runtime the body is already pre-buffered, so the
//   stream's end/data events never fire — the body-read promise hangs
//   indefinitely until Vercel's 300s platform timeout.
//
// References
//   - https://vercel.com/docs/functions/runtimes/edge
//   - https://github.com/honojs/node-server/issues/306
//   - https://github.com/honojs/node-server/issues/84
// ---------------------------------------------------------------------------

import type { IncomingMessage, ServerResponse } from "node:http";

export default async function vercelHandler(
  req: Request | IncomingMessage,
  maybeRes?: ServerResponse,
): Promise<Response | void> {
  // Fast path — Fluid Compute passes a standard Web API Request
  if (req instanceof Request) {
    return app.fetch(req);
  }

  // ------------------------------------------------------------------
  // Legacy Node.js Serverless path — convert IncomingMessage → Request
  // ------------------------------------------------------------------
  try {
    // Reconstruct the absolute URL from proxy-forwarded headers
    const protocol =
      (req.headers["x-forwarded-proto"] as string) ||
      ((req.socket as { encrypted?: boolean } | undefined)?.encrypted ? "https" : "http");
    const host =
      (req.headers["x-forwarded-host"] as string) ||
      (req.headers["host"] as string) ||
      "localhost";
    const url = `${protocol}://${host}${req.url ?? "/"}`;

    // Read the full request body using for await...of on the raw stream.
    // This avoids the getRequestListener hang (see comment above).
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bodyBuffer =
      req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0
        ? Buffer.concat(chunks)
        : null;

    // Build headers from rawHeaders (preserves original casing, skips
    // HTTP/2 pseudo-headers like :method, :path, :scheme, :authority)
    const headers: Record<string, string> = {};
    const rawHeaders = req.rawHeaders;
    for (let i = 0; i < rawHeaders.length; i += 2) {
      const key = rawHeaders[i];
      if (key.charCodeAt(0) !== 58) headers[key] = rawHeaders[i + 1];
    }

    const response = await app.fetch(
      new Request(url, {
        method: req.method,
        headers,
        body: bodyBuffer,
      }),
    );

    // Write response to ServerResponse when on legacy Node.js
    if (maybeRes && typeof maybeRes.statusCode === "number") {
      maybeRes.statusCode = response.status;
      const hasSetCookie = response.headers.getSetCookie?.();
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() === "set-cookie" && hasSetCookie?.length) {
          // Multiple Set-Cookie values must be set individually (comma-
          // merging is illegal for Set-Cookie)
          for (const cookie of hasSetCookie) maybeRes.setHeader("Set-Cookie", cookie);
        } else {
          maybeRes.setHeader(key, value);
        }
      });

      // Stream the response body for SSE and large payloads
      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          maybeRes.write(value);
        }
      }
      maybeRes.end();
      return;
    }

    return response;
  } catch (error) {
    console.error("[vercel-handler] Unhandled error:", error);
    if (maybeRes && typeof maybeRes.statusCode === "number" && !maybeRes.headersSent) {
      maybeRes.statusCode = 500;
      maybeRes.setHeader("Content-Type", "application/json");
      maybeRes.end(JSON.stringify({ success: false, error: "Internal Server Error" }));
      return;
    }
    // If we got here, it's the Fluid Compute path and we must throw
    throw error;
  }
}
