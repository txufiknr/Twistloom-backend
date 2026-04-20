/**
 * Muslim Digest API Server
 * Main entry point for the backend application
 * Robust bootstrap with full error handling
 * Local dev only (not used in Vercel)
 */

import app from "./app.js";
import { PORT } from "./config/constants.js";
import { registerGracefulShutdown } from "./utils/graceful-shutdown.js";
import type http from "node:http";

/**
 * Type guard for Node.js error objects with code property
 */
function hasErrorCode(err: unknown): err is { code: string } {
  return err !== null && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string";
}

/* -------------------------------------------------- */
/* Global Process Guards                              */
/* -------------------------------------------------- */

process.on("uncaughtException", (err) => {
  console.error("💥 Uncaught Exception", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("💥 Unhandled Rejection", reason);
  process.exit(1);
});

process.on("exit", (code) => {
  console.log(`Process exiting with code ${code} 👏`);
});

/* -------------------------------------------------- */
/* Environment Validation                              */
/* -------------------------------------------------- */

if (!process.env.AUTH_SECRET) {
  console.error('🔐 AUTH_SECRET environment variable is required for NextAuth authentication');
  console.error('🔐 Generate one with: openssl rand -base64 32');
  process.exit(1);
}

/* -------------------------------------------------- */
/* Start Server                                       */
/* -------------------------------------------------- */

const server: http.Server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} 🚀`);
});

server.on("error", (err: unknown) => {
  if (hasErrorCode(err)) {
    if (err.code === "EADDRINUSE") {
      console.error(`💥 Port ${PORT} is already in use.`);
      console.error("👉 Possible orphan process. Run: pnpm dev:kill");
      process.exit(1);
    }

    if (err.code === "EACCES") {
      console.error(`🙅‍♂️ Port ${PORT} requires elevated privileges.`);
      process.exit(1);
    }
  }

  console.error("💥 Server failed to start:", err);
  process.exit(1);
});

/* -------------------------------------------------- */
/* Graceful Shutdown                                  */
/* -------------------------------------------------- */

registerGracefulShutdown(async () => {
  console.log("API server shutting down 👋");

  // Close HTTP server gracefully
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) return reject(err);
      console.log("HTTP server closed 👋");
      // Recommended cleanup tasks:
      // - Flush any pending logs/metrics
      // - Release file locks
      // - Cancel in-flight requests
      // - Save application state if needed

      // Note: Neon HTTP client doesn't require connection cleanup
      resolve();
    });
  });
});

export default server;