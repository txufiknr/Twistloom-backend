/**
 * Vercel serverless function entrypoint (Node.js runtime).
 *
 * Vercel offers TWO execution modes for Node.js:
 *   1. **Node.js Fluid Compute** — passes a Web API `Request` directly.
 *      The handler MAY return a `Response` (modern) OR write through `res`.
 *   2. **Legacy Node.js Serverless** — passes `IncomingMessage` + `ServerResponse`.
 *      The handler MUST write through `res` and return `void`.
 *
 * This handler supports both transparently:
 *   - Detects the incoming type by checking for `rawHeaders` (IncomingMessage-only).
 *   - Normalises whichever type into a **fresh, spec-compliant `Request`**.
 *   - Forwards it to Hono, then pipes the Hono `Response` back through
 *     whichever output path Vercel expects.
 *
 * WHY NOT `hono/vercel`'s built-in `handle(app)`?
 *   It simply calls `app.fetch(req)`.  On legacy Node.js Serverless the `req`
 *   is an `IncomingMessage`, and Hono stores it as `c.req.raw`.  Any middleware
 *   that calls `c.req.header()` — like CORS — will crash because
 *   `IncomingMessage.headers` is a plain object with no `.get()` method.
 *
 * WHY NOT `@hono/node-server`'s `getRequestListener`?
 *   It wraps `IncomingMessage` in a `ReadableStream` via `Readable.toWeb()`.
 *   On Vercel's runtime the body is already fully buffered, so the stream's
 *   `end`/`data` events never fire — the body-read promise hangs indefinitely
 *   until Vercel's platform timeout kills the invocation.
 *
 * Local development uses Bun via `src/server.bun.ts` and bypasses this file
 * entirely (Bun's native `Request` + `server.serve`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { app } from "../src/app.js";

/**
 * Tells Vercel to use the Node.js runtime (not Edge / Deno / Bun).
 *
 * **Why not the Bun runtime?**  Vercel's Bun runtime was attempted during
 * the Bun migration (Phase 3 — see `docs/roadmap/done/BUN_MIGRATION_ROADMAP.md`
 * and the "Vercel deployment" section of `README.md`). It failed with ESM
 * module linking errors (`Requested module is not instantiated yet`) due to
 * the project's complex dependency graph. The `hono/vercel` adapter also
 * didn't work because its `handle()` doesn't convert `IncomingMessage` →
 * `Request` on the Node.js runtime.
 *
 * The final architecture is **hybrid**:
 *   - **Local dev** uses Bun (`src/server.bun.ts`) — fast dev server,
 *     native TypeScript, `bun --watch`.
 *   - **Production** uses Node.js via this custom adapter — the same
 *     battle-tested pattern from the pre-migration codebase.
 *
 * The `vercel.json` rewrite directs all paths to this handler.
 */
export const config = { runtime: "nodejs" };

/**
 * Unified request handler for both Vercel execution modes.
 *
 * @param req - Either a Web API `Request` (Fluid Compute) or
 *              a Node.js `IncomingMessage` (Legacy Serverless).
 * @param maybeRes - `ServerResponse` present in Legacy mode, absent in
 *                   pure-Fluid-Compute invocations.
 * @returns `Response` when no `maybeRes` is provided, otherwise `void`.
 */
export default async function vercelHandler(
  req: Request | IncomingMessage,
  maybeRes?: ServerResponse,
): Promise<Response | void> {
  try {
    // ------------------------------------------------------------------
    // STEP 1 — Detect the incoming request type
    // ------------------------------------------------------------------
    // `IncomingMessage.rawHeaders` is an `[key, val, key, val, …]` array
    // that the Web API `Request` does not have.  This is the most reliable
    // discriminator between the two Vercel runtimes.
    //
    // We cast *before* the check because TypeScript cannot narrow a union
    // based on a standalone boolean.
    const isIncomingMessage =
      typeof (req as IncomingMessage).rawHeaders !== "undefined";

    // This will hold the canonical Request we hand off to Hono.
    let honoRequest: Request;

    // ------------------------------------------------------------------
    // STEP 2a — Legacy Node.js Serverless path
    //           (IncomingMessage → Request)
    // ------------------------------------------------------------------
    if (isIncomingMessage) {
      const incoming = req as IncomingMessage;

      // --- Reconstruct the URL ----------------------------------------
      // Vercel terminates TLS at its edge proxy, so the original protocol
      // is carried in `x-forwarded-proto`.  Fall back to inspecting the
      // underlying TLS socket, then to `http`.
      const protocol =
        (incoming.headers["x-forwarded-proto"] as string) ||
        ((incoming.socket as { encrypted?: boolean } | undefined)?.encrypted
          ? "https"
          : "http");

      // Vercel sends the original host via `x-forwarded-host`; the plain
      // `host` header is the edge proxy's internal address.
      const host =
        (incoming.headers["x-forwarded-host"] as string) ||
        (incoming.headers["host"] as string) ||
        "localhost";

      const url = `${protocol}://${host}${incoming.url ?? "/"}`;

      // --- Read the body into a buffer --------------------------------
      // `IncomingMessage` implements `Readable` (async iterable).
      // We buffer the entire body into memory.  This is acceptable for
      // Vercel serverless functions because the platform enforces a
      // 4.5 MB payload limit — far below any practical memory pressure.
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body =
        incoming.method !== "GET" && incoming.method !== "HEAD" && chunks.length > 0
          ? Buffer.concat(chunks)
          : null;

      // --- Extract headers from rawHeaders ----------------------------
      // `rawHeaders` is a flat `[key1, value1, key2, value2, …]` array.
      // HTTP/2 pseudo-headers (e.g. `:method`, `:path`) start with colon
      // (char code 58) and must be excluded — they are metadata, not
      // real headers.
      const headers: Record<string, string> = {};
      const rawHeaders = incoming.rawHeaders;
      for (let i = 0; i < rawHeaders.length; i += 2) {
        const key = rawHeaders[i];
        if (key.charCodeAt(0) !== 58) headers[key] = rawHeaders[i + 1];
      }

      // --- Build the canonical Request --------------------------------
      // `Buffer` extends `Uint8Array`, which `RequestInit.body` accepts.
      // Passing a `Record<string, string>` as `headers` produces a
      // spec-compliant `Headers` instance inside the new `Request`.
      honoRequest = new Request(url, { method: incoming.method, headers, body });

    // ------------------------------------------------------------------
    // STEP 2b — Fluid Compute path (Request → Request)
    // ------------------------------------------------------------------
    } else {
      // Vercel might pass a Request whose `headers` is a plain object
      // rather than the Web API `Headers` class (observed on some Node.js
      // 18 / undici versions).  We *rebuild* it through `new Request()`
      // to guarantee spec-compliant `Headers` with a `.get()` method that
      // Hono's CORS middleware and others depend on.
      const webReq = req as unknown as Request;

      honoRequest = new Request(webReq.url, {
        method: webReq.method,
        headers: webReq.headers,   // Headers | Record → Headers
        body: webReq.body,         // ReadableStream | null passthrough
      });
    }

    // ------------------------------------------------------------------
    // STEP 3 — Dispatch through Hono
    // ------------------------------------------------------------------
    // `honoRequest` is now always a fresh, spec-compliant `Request` with
    // proper `Headers.get()`.  Every Hono middleware (CORS, CSRF, auth…)
    // can safely call `c.req.header()` without crashing.
    const response = await app.fetch(honoRequest);

    // ------------------------------------------------------------------
    // STEP 4 — Write the Hono Response back to Vercel
    // ------------------------------------------------------------------
    if (maybeRes && typeof maybeRes.statusCode === "number") {
      // --- Legacy Serverless path: write through ServerResponse ------
      maybeRes.statusCode = response.status;

      // Copy all response headers onto the ServerResponse.
      // Set-Cookie deserves special care:
      //   - `Headers.getSetCookie()` (modern API, Node ≥ 20) returns
      //     each Set-Cookie as a separate array entry.
      //   - `Headers.forEach()` coalesces multiple values for the same
      //     key into comma-separated strings — which is WRONG for
      //     Set-Cookie (semicolons inside values break on the comma).
      //   - We use `setHeader` with an array, which Node.js serialises
      //     as separate `Set-Cookie` lines.
      const setCookieValues: string[] = [];
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() === "set-cookie") {
          setCookieValues.push(value);
        } else {
          maybeRes.setHeader(key, value);
        }
      });
      if (setCookieValues.length > 0) {
        maybeRes.setHeader("Set-Cookie", setCookieValues);
      }

      // Stream the response body bytes through the ServerResponse.
      // `response.body` is a `ReadableStream` (Web API).  We use its
      // `getReader()` to pull chunks and write them to the Node.js
      // response socket.
      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          maybeRes.write(value);
        }
      }
      maybeRes.end();
      return; // ← must return void for Legacy Serverless
    }

    // --- Fluid Compute path: return the Response object directly ------
    return response;

  // --------------------------------------------------------------------
  // STEP 5 — Error handling
  // --------------------------------------------------------------------
  } catch (error) {
    console.error("[vercel-handler] Unhandled error:", error);

    // If we still have a valid ServerResponse that hasn't started sending,
    // write a JSON 500 error instead of crashing the invocation.
    if (maybeRes && typeof maybeRes.statusCode === "number" && !maybeRes.headersSent) {
      maybeRes.statusCode = 500;
      maybeRes.setHeader("Content-Type", "application/json");
      maybeRes.end(JSON.stringify({ success: false, error: "Internal Server Error" }));
      return;
    }

    // No ServerResponse available (pure-Fluid-Compute path) or headers
    // already sent — let Vercel handle the error.
    throw error;
  }
}
