/**
 * Vercel serverless function entrypoint.
 *
 * The `api/` directory is Vercel's convention — files here are automatically
 * compiled and executed as Serverless Functions. This thin wrapper imports
 * the Hono app and delegates to its native `fetch`.
 */
export { default } from "../src/app.js";
