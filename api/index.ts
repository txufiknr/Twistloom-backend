/**
 * Vercel serverless function entrypoint.
 *
 * The `api/` directory is Vercel's convention — files here are automatically
 * compiled and executed as Serverless Functions. This thin wrapper imports
 * the Hono app and delegates to its native `fetch`.
 */
import { app } from "../src/app.js";

export default app.fetch;
