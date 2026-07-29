/// <reference types="bun" />

/**
 * Twistloom API Server (Bun runtime)
 *
 * Bootstraps the Hono app using Bun's native HTTP server.
 * Replaces @hono/node-server for development under Bun.
 */

import { app } from "./app.js";
import { PORT } from "./config/env.js";
import { validateGitHubWorkflowConfig } from "./utils/github-workflow.js";
import { registerGracefulShutdown } from "./utils/graceful-shutdown.js";

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

if (!process.env.AUTH_SECRET) {
  console.error("🔐 AUTH_SECRET environment variable is required for NextAuth authentication");
  console.error("🔐 Generate one with: openssl rand -base64 32");
  process.exit(1);
}

validateGitHubWorkflowConfig();

let server: ReturnType<typeof Bun.serve>;

try {
  server = Bun.serve({
    fetch: app.fetch,
    port: PORT,
    error(error) {
      console.error("💥 Server error:", error);
      return new Response("Internal Server Error", { status: 500 });
    },
  });
} catch (err: unknown) {
  const nodeError = err as { code?: string; message?: string };
  if (nodeError.code === "EADDRINUSE") {
    console.error(`💥 Port ${PORT} is already in use.`);
    console.error("👉 Possible orphan process. Run: pnpm dev:kill");
    process.exit(1);
  }
  if (nodeError.code === "EACCES") {
    console.error(`🙅‍♂️ Port ${PORT} requires elevated privileges.`);
    process.exit(1);
  }
  console.error("💥 Server failed to start:", err);
  process.exit(1);
}

console.log(`Server running on http://localhost:${server.port} 🚀`);

registerGracefulShutdown(() => {
  console.log("API server shutting down 👋");
  void server.stop();
});
