/**
 * Vercel serverless function entrypoint (Node.js runtime).
 *
 * Uses Hono's official Vercel adapter for stable Node.js deployment.
 * Local development continues using Bun via src/server.bun.ts.
 */
import { handle } from "hono/vercel";
import { app } from "../src/app.js";

export const config = { runtime: "nodejs" };
export default handle(app);
