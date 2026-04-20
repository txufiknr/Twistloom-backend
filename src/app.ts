/**
 * Serverless-compatible Express setup
 */

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { rateLimitByUser } from "./middleware/rate-limit.js";
import routes from "./routes/index.js";
import { APP_NAME, VERSION } from "./config/constants.js";

// Initialize Express app
const app = express();

// Configure middleware
app.use(express.json({ limit: "1mb" })); // Parse JSON payloads
app.use(cookieParser()); // Parse cookies for NextAuth authentication
app.use(cors({
  origin: process.env.FRONTEND_URL || 'https://twistloom.vercel.app',
  credentials: true, // CRITICAL: Allow cookies for NextAuth authentication
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
})); // Enable CORS with credentials for cookie-based auth
app.use(rateLimitByUser); // Global rate limiting (100 req/min per user)

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