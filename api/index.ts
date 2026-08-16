/**
 * Vercel serverless function entrypoint (Node.js runtime).
 *
 * The request-handling logic now lives in `src/app.ts` as its default export,
 * so this file is a thin re-export. This makes the deployment resilient
 * regardless of which file Vercel picks as the entrypoint:
 *
 *   - The **Hono framework preset** auto-detects `src/app.ts` (it imports
 *     `hono`) and deploys its default export.
 *   - The **`vercel.json` rewrite** routes `/(.*)` → `/api/index`, i.e. this
 *     file.
 *
 * Both entrypoints now serve the identical consolidated `vercelHandler`, which
 * always hands Hono a spec-compliant Web `Request` (converting a legacy Node
 * `IncomingMessage` when needed) and pipes the response back through whatever
 * output path Vercel expects — see `src/app.ts` for details.
 */
export { config, default } from "../src/app.js";