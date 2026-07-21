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
import { getRequestListener } from "@hono/node-server";
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

// IMPORTANT: Vercel (Node.js runtime) invokes the default export as a Node
// `(req, res)` serverless handler. `getRequestListener` converts the Node
// IncomingMessage into a proper Web `Request` before handing it to Hono, which
// is what makes `c.req.header()` (and therefore the CORS middleware) work.
// Using `hono/vercel`'s Edge adapter here instead throws
// "this.raw.headers.get is not a function" because the Node runtime does not
// supply a standards-compliant `Headers` instance.
export default getRequestListener(app.fetch);
