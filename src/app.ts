/**
 * Serverless-compatible Express setup
 */

import express from "express";
import cors from "cors";
import { rateLimitByClientId } from "./middleware/rate-limit.js";
import routes from "./routes/index.js";
import { APP_NAME, VERSION } from "./config/constants.js";

// Initialize Express app
const app = express();

// Configure middleware
app.use(express.json({ limit: "1mb" })); // Parse JSON payloads
app.use(cors({ origin: true })); // Enable CORS for all origins
app.use(rateLimitByClientId); // Global rate limiting (100 req/min per client ID)

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
app.get("/feed", (_, res) => res.redirect("/api/feed"));
app.get("/preferences", (_, res) => res.redirect("/api/preferences"));
app.get("/favorites", (_, res) => res.redirect("/api/favorites"));
app.get("/history", (_, res) => res.redirect("/api/history"));

// Health check endpoint
app.get("/health", (_, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// IMPORTANT: Vercel needs this default export
export default app;