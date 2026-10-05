/**
 * Netlify Serverless Function entrypoint (Node.js runtime, ESM).
 *
 * Netlify passes a spec-compliant Web API `Request` plus an execution
 * `Context`, and expects a Web API `Response` — which maps directly onto
 * Hono's native `fetch` contract. Unlike the legacy Vercel path, no
 * `IncomingMessage` → `Request` conversion is required.
 *
 * Routing is declared inline via `config.path` (URLPattern wildcard) so a
 * single mechanism owns every path: `/`, `/health`, `/health/db`, `/api/*`
 * and the backward-compat redirects. Static files inside `publish = "public"`
 * are served by Netlify's CDN first because `preferStatic` is `true`.
 *
 * @see https://docs.netlify.com/functions/overview/
 */

import type { Config, Context } from "@netlify/functions";
import { app } from "../../src/app.js";

/**
 * Handles a single Netlify function invocation.
 *
 * The execution `context` is forwarded as Hono's execution context so route
 * handlers and middleware can schedule post-response work through
 * `c.executionCtx.waitUntil(...)` (cache purge, analytics, logs) without
 * delaying the client response.
 *
 * @param request - Spec-compliant Web API request from the Netlify runtime
 * @param context - Netlify execution context (`waitUntil`, `json`, …)
 * @returns Hono's `Response` for the matched route
 */
export default async function handler(request: Request, context: Context): Promise<Response> {
  const executionCtx = {
    waitUntil: (promise: Promise<unknown>): void => {
      context.waitUntil(promise);
    },
    passThroughOnException: (): void => {
      // Netlify Functions v2 has no equivalent; Hono only calls this when a
      // platform adapter opts into pass-through behavior.
    },
    props: {},
  };

  return app.fetch(request, { trustedClientIp: context.ip }, executionCtx);
}

export const config: Config = {
  path: "/*",
  preferStatic: true,
};
