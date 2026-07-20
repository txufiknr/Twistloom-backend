/**
 * Twistloom API Server
 * Main entry point for the backend application (local dev only — Vercel uses src/app.ts).
 * Bootstrap with full error handling, powered by @hono/node-server.
 */

import { serve, type ServerType } from "@hono/node-server";
import { app } from "./app.js";
import { PORT } from "./config/env.js";
import { hasErrorCode } from "./utils/error.js";
import { validateGitHubWorkflowConfig } from "./utils/github-workflow.js";
import { registerGracefulShutdown } from "./utils/graceful-shutdown.js";

/* -------------------------------------------------- */
/* Global Process Guards                              */
/* -------------------------------------------------- */

process.on("uncaughtException", (err) => {
  console.error("💥 Uncaught Exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("💥 Unhandled Rejection:", reason);
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

// Validate GitHub workflow configuration for on-demand candidate generation
validateGitHubWorkflowConfig();

/* -------------------------------------------------- */
/* Start Server                                       */
/* -------------------------------------------------- */

const server: ServerType = serve(
  { fetch: app.fetch, port: PORT },
  (info) => {
    console.log(`Server running on port ${info.port} 🚀`);
  },
);

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
    server.close((err: unknown) => {
      if (err) return reject(err);
      console.log("HTTP server closed 👋");
      resolve();
    });
  });
});

export default server;
