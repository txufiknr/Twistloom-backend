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
  try {
    // ------------------------------------------------------------------
    // Normalise any incoming request into a spec-compliant Request so
    // Hono (including its middleware such as CORS) can always rely on
    // raw.headers.get() being present.  Vercel's Fluid Compute Request
    // can have headers as a plain object rather than the Web API Headers.
    // ------------------------------------------------------------------
    const isIncomingMessage =
      typeof (req as IncomingMessage).rawHeaders !== "undefined";

    let honoRequest: Request;

    if (isIncomingMessage) {
      // Legacy Node.js Serverless path — IncomingMessage → Request
      const incoming = req as IncomingMessage;
      const protocol =
        (incoming.headers["x-forwarded-proto"] as string) ||
        ((incoming.socket as { encrypted?: boolean } | undefined)?.encrypted ? "https" : "http");
      const host =
        (incoming.headers["x-forwarded-host"] as string) ||
        (incoming.headers["host"] as string) ||
        "localhost";
      const url = `${protocol}://${host}${incoming.url ?? "/"}`;

      const chunks: Buffer[] = [];
      for await (const chunk of incoming) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body =
        incoming.method !== "GET" && incoming.method !== "HEAD" && chunks.length > 0
          ? Buffer.concat(chunks)
          : null;

      const headers: Record<string, string> = {};
      const rawHeaders = incoming.rawHeaders;
      for (let i = 0; i < rawHeaders.length; i += 2) {
        const key = rawHeaders[i];
        if (key.charCodeAt(0) !== 58) headers[key] = rawHeaders[i + 1];
      }

      honoRequest = new Request(url, { method: incoming.method, headers, body });
    } else {
      // Fluid Compute path — rebuild from the existing Request to
      // guarantee spec-compliant Headers
      const webReq = req as unknown as Request;
      honoRequest = new Request(webReq.url, {
        method: webReq.method,
        headers: webReq.headers,
        body: webReq.body,
      });
    }

    const response = await app.fetch(honoRequest);

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
