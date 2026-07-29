/**
 * Vercel serverless function entrypoint (Node.js runtime).
 *
 * Vercel's Node.js Fluid Compute passes a Web API Request directly (fast
 * path). Legacy Node.js Serverless wrappers pass IncomingMessage — this
 * handler converts it to a standard Request before calling Hono.
 *
 * WHY NOT hono/vercel handle()?
 *   handle(app) is just (req) => app.fetch(req). On legacy Node.js
 *   Serverless, that means IncomingMessage reaches Hono as c.req.raw,
 *   and c.req.raw.headers.get() throws because IncomingMessage.headers
 *   is a plain object with no .get() method.
 *
 * WHY NOT @hono/node-server getRequestListener?
 *   It wraps IncomingMessage in a ReadableStream via Readable.toWeb().
 *   On Vercel's Node.js runtime the body is already pre-buffered, so the
 *   stream's end/data events never fire — the body-read promise hangs
 *   indefinitely until Vercel's platform timeout.
 *
 * Local development uses Bun via src/server.bun.ts and bypasses this entirely.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { app } from "../src/app.js";

export const config = { runtime: "nodejs" };

export default async function vercelHandler(
  req: Request | IncomingMessage,
  maybeRes?: ServerResponse,
): Promise<Response | void> {
  // Fast path — Fluid Compute passes a standard Web API Request
  if (req instanceof Request) {
    return app.fetch(req);
  }

  // ------------------------------------------------------------------
  // Legacy Node.js Serverless path — convert IncomingMessage → Request
  // ------------------------------------------------------------------
  try {
    const protocol =
      (req.headers["x-forwarded-proto"] as string) ||
      ((req.socket as { encrypted?: boolean } | undefined)?.encrypted ? "https" : "http");
    const host =
      (req.headers["x-forwarded-host"] as string) ||
      (req.headers["host"] as string) ||
      "localhost";
    const url = `${protocol}://${host}${req.url ?? "/"}`;

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bodyBuffer =
      req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0
        ? Buffer.concat(chunks)
        : null;

    const headers: Record<string, string> = {};
    const rawHeaders = req.rawHeaders;
    for (let i = 0; i < rawHeaders.length; i += 2) {
      const key = rawHeaders[i];
      if (key.charCodeAt(0) !== 58) headers[key] = rawHeaders[i + 1];
    }

    const response = await app.fetch(
      new Request(url, {
        method: req.method,
        headers,
        body: bodyBuffer,
      }),
    );

    if (maybeRes && typeof maybeRes.statusCode === "number") {
      maybeRes.statusCode = response.status;
      const hasSetCookie = response.headers.getSetCookie?.();
      response.headers.forEach((value, key) => {
        if (key.toLowerCase() === "set-cookie" && hasSetCookie?.length) {
          for (const cookie of hasSetCookie) maybeRes.setHeader("Set-Cookie", cookie);
        } else {
          maybeRes.setHeader(key, value);
        }
      });

      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          maybeRes.write(value);
        }
      }
      maybeRes.end();
      return;
    }

    return response;
  } catch (error) {
    console.error("[vercel-handler] Unhandled error:", error);
    if (maybeRes && typeof maybeRes.statusCode === "number" && !maybeRes.headersSent) {
      maybeRes.statusCode = 500;
      maybeRes.setHeader("Content-Type", "application/json");
      maybeRes.end(JSON.stringify({ success: false, error: "Internal Server Error" }));
      return;
    }
    throw error;
  }
}
