/**
 * Vercel serverless function entrypoint (Node.js runtime).
 *
 * Vercel's Node.js runtime passes (IncomingMessage, ServerResponse) to the
 * default export. This handler converts IncomingMessage to a standard Web API
 * Request before delegating to Hono's native app.fetch.
 *
 * Local development uses Bun via src/server.bun.ts and bypasses this entirely.
 */

import { app } from "../src/app.js";

export const config = { runtime: "nodejs" };

export default async function handler(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  try {
    // Reconstruct URL from proxy headers
    const proto = req.headers["x-forwarded-proto"] as string | undefined;
    const host = (req.headers["x-forwarded-host"] as string | undefined)
      ?? req.headers.host
      ?? "localhost";
    const url = `${proto ?? "https"}://${host}${req.url ?? "/"}`;

    // Read body for non-GET/HEAD requests
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body =
      req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0
        ? Buffer.concat(chunks)
        : null;

    // Build headers, skipping HTTP/2 pseudo-headers
    const headers: Record<string, string> = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      if (k.charCodeAt(0) !== 58) headers[k] = req.rawHeaders[i + 1];
    }

    const response = await app.fetch(
      new Request(url, {
        method: req.method,
        headers,
        body,
      }),
    );

    // Write response back to ServerResponse
    res.statusCode = response.status;
    const setCookie = response.headers.getSetCookie?.();
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === "set-cookie" && setCookie?.length) {
        for (const cookie of setCookie) res.setHeader("Set-Cookie", cookie);
      } else {
        res.setHeader(key, value);
      }
    });

    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  } catch (error) {
    console.error("[vercel-handler] Unhandled error:", error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ success: false, error: "Internal Server Error" }));
    }
  }
}
