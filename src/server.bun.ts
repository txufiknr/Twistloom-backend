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

if (!process.env.AUTH_SECRET) {
  console.error("🔐 AUTH_SECRET environment variable is required for NextAuth authentication");
  console.error("🔐 Generate one with: openssl rand -base64 32");
  process.exit(1);
}

validateGitHubWorkflowConfig();

const server = Bun.serve({
  fetch: app.fetch,
  port: PORT,
  error(error) {
    console.error("💥 Server error:", error);
    return new Response("Internal Server Error", { status: 500 });
  },
});

console.log(`Server running on http://localhost:${server.port} 🚀`);

registerGracefulShutdown(() => {
  console.log("API server shutting down 👋");
  server.stop();
});
