/**
 * Serverless-compatible Express setup
 */

import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { rateLimitByUser } from "./middleware/rate-limit.js";
import { extractLocale } from "./middleware/locale.js";
import routes from "./routes/index.js";
import { APP_NAME, VERSION } from "./config/constants.js";

// Initialize Express app
const app: Express = express();

// Allow multiple origins: production frontend and local development
const allowedOrigins = new Set([
  process.env.FRONTEND_URL,
  'https://twistloom-web.vercel.app', // Production (Vercel deployment)
  'https://localhost:3002', // Development (HTTPS) via `pnpm dev:ssl`
  'http://localhost:3001', // Development via `pnpm dev`
].filter(Boolean));

// CRITICAL: Raw body middleware for Stripe webhook MUST come before express.json()
// Stripe requires raw body for webhook signature verification
app.use("/api/payments/stripe/webhook", express.raw({ type: "application/json" }));

// Configure middleware
app.use(express.json({ limit: "1mb" })); // Parse JSON payloads
app.use(cookieParser()); // Parse cookies for NextAuth authentication
app.use(cors({
  origin: (origin, callback) => {
    const isAllowed = !origin || origin.endsWith('.vercel.app') || allowedOrigins.has(origin);
    // console.log('[cors] 👉 Incoming origin:', origin);
    // console.log('[cors] 👉 Allowed origins:', allowedOrigins);
    // console.log('[cors] 👉 Allowed?', isAllowed ? '✅' : '❌', isAllowed);

    // Allow requests with no origin (like mobile apps, curl, server-to-server)
    if (isAllowed) return callback(null, true);

    console.log('[cors] ❌ Blocked by CORS:', origin);
    // callback(new Error('Not allowed by CORS'));
    return callback(null, false);
  },
  credentials: true, // Allow cookies for NextAuth authentication
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(extractLocale); // Extract Accept-Language header for translation
app.use(rateLimitByUser); // Global rate limiting (100 req/min per user)

// app.options('*', cors());

// Because your Express backend is hosted on Vercel (twistloom-backend.vercel.app), it sits behind a reverse proxy/load balancer. If Express thinks the connection isn't secure (HTTPS), Auth.js will automatically ignore the cookie for security reasons.
// You must tell Express to trust the upstream proxy headers so it registers the incoming connection as secure HTTPS:
app.set('trust proxy', 1); // Tells Express it is behind a secure proxy

// Handle favicon requests to prevent 404 errors
app.get("/favicon.png", (_, res) => {
  res.status(204).end(); // No Content response
});

app.get("/favicon.ico", (_, res) => {
  res.status(204).end(); // No Content response
});

// Public API routes
app.use("/api", routes);

// Root endpoint
app.get("/", (_, res) => {
  res.json({
    message: `${APP_NAME} Backend`,
    version: VERSION,
    endpoints: {
      "/health": "Health check endpoint",
      "/api": "API root endpoint",
    }
  });
});

// Backward-compatible redirects
app.get("/user", (_, res) => res.redirect("/api/user"));
app.get("/books", (_, res) => res.redirect("/api/books"));

// Health check endpoint
app.get("/health", (_, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// IMPORTANT: Vercel needs this default export
export default app;