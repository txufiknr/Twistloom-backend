# Vercel Edge Runtime Migration: Blocker Analysis

## Overview

This document catalogues every Node.js-specific API and dependency that would need to change for this backend to run on the Vercel Edge Runtime instead of the current Node.js serverless functions. It was prompted by a review of the "Node-only APIs" section in `README.md` (lines 107–112) and a comprehensive `grep`-based audit of `src/`.

### Current deployment model

| Property | Value |
|----------|-------|
| **Runtime** | Node.js 22 (serverless) |
| **Entrypoint** | `src/app.ts` → `export default getRequestListener(app.fetch)` via `@hono/node-server` |
| **Vercel config** | `vercel.json`: `maxDuration: 60`, functions rewrites to `src/app.ts` |
| **Local dev** | `src/server.ts` → `serve({ fetch: app.fetch })` via `@hono/node-server` |

### Goal of Edge migration

The Vercel Edge Runtime (web-standard APIs only: `fetch`, `Request`, `Response`, `WebSocket`, `crypto.subtle`, `ReadableStream`, etc.) offers faster cold starts and no Node.js allocation overhead. In exchange, it **forbids**:

- `Buffer` (the class is `undefined`)
- `require('fs')`, `require('path')`, `require('crypto')`, `require('net')`, `require('http')`, etc.
- Native addons (`bcrypt`)
- `process.exit()`, `process.uptime()`, `process.memoryUsage()`, `process.cwd()`, `process.version`
- Packages that depend on any of the above

---

## Blocker Summary Table

| # | Blocker | Severity | Files Affected | Effort | Status |
|---|---------|----------|----------------|--------|--------|
| 1 | `@imagekit/nodejs` SDK | **CRITICAL** | `services/image.ts`, `services/book.ts`, `middleware/upload.ts` | High | ✅ Done |
| 2 | `bcrypt` native addon | **CRITICAL** | `utils/password.ts` | Low (drop-in) | ⬜ |
| 3 | `Buffer` (9+ usages) | **CRITICAL** | `middleware/upload.ts`, `routes/books.ts`, `utils/ai-image.ts` | Medium | ⬜ |
| 4 | Neon Pool WebSocket wiring | **HIGH** | `db/client.ts` | Low (+ testing) | ⬜ |
| 5 | `crypto.createHash` (Node `crypto`) | **HIGH** | `utils/cache.ts` | Medium (async ripple) | ⬜ |
| 6 | Entrypoint adapter | **HIGH** | `src/app.ts` | Low | ⬜ |
| 7 | Stripe fetch client config | **HIGH** | `utils/stripe.ts` | Low (1 line) | ⬜ |
| 8 | `fs` / `path` in constants | **LOW** | `config/constants.ts` | Low (remove fallback) | ⬜ |
| 9 | `fs` / `path` in ai-image.ts | **LOW** | `utils/ai-image.ts` | Low (skip branch) | ⬜ |
| 10 | `@actions/core` (`group()`) | **LOW** | `utils/error.ts`, `utils/ai-logger.ts`, `utils/ai-chat.ts` | Low (console.group) | ⬜ |
| 11 | `process.*` in admin route | **LOW** | `routes/admin.ts`, `app.ts` | Low (guard/remove) | ⬜ |
| 12 | SSE route durations | **NONE** (legacy) | `routes/books.ts` (3 SS routes) | — | ⬜ |

---

## Detailed Blocker Analysis

### 1. `@imagekit/nodejs` SDK — CRITICAL

**Why it fails on Edge:**
The Node.js ImageKit SDK (`@imagekit/nodejs` v7.6.2) uses `Buffer` internally for all file processing, and the `toFile()` helper it exports expects a `Buffer` argument. On Edge, `Buffer` is `undefined`, so any call to the SDK throws `ReferenceError`.

**Where it is used:**

| File | Line(s) | Usage |
|------|---------|-------|
| `services/image.ts` | 1 | `import ImageKit, { toFile } from "@imagekit/nodejs"` |
| `services/image.ts` | 43 | `new ImageKit({ privateKey })` — client singleton |
| `services/image.ts` | 242, 266, 287 | `toFile(buffer, fileName, options)` — converts Buffer to File |
| `services/image.ts` | 320 | `imagekit.files.upload(uploadParams)` — SDK upload |
| `services/image.ts` | 511, 544, 573, 671 | Various SDK calls: `files.delete`, `files.bulk.delete`, `folders.delete` |
| `services/book.ts` | 16 | `import type ImageKit from "@imagekit/nodejs"` — type import only |

**Estimated effort:** 2–3 days

**Migration path:**

Replace all SDK calls with direct HTTP requests to ImageKit REST API using the global `fetch` (Edge-compatible). The ImageKit HTTP API is well-documented:

- **Upload:** `POST https://upload.imagekit.io/api/v1/files/upload` with `Authorization: Basic base64(privateKey:)`. Body as `multipart/form-data` or JSON with `base64` file content.
- **Delete:** `DELETE https://api.imagekit.io/v1/files/:fileId`
- **Bulk delete:** `POST https://api.imagekit.io/v1/files/bulk/deleteByFileIds`
- **Folder delete:** `DELETE https://api.imagekit.io/v1/folders/:folderPath`

The type import in `services/book.ts` (`ImageKit.Files.FileUploadResponse`) should be replaced with a local interface:

```typescript
interface ImageKitUploadResponse {
  fileId: string;
  name: string;
  url: string;
  thumbnailUrl: string;
  height: number;
  width: number;
  size: number;
  filePath: string;
  // … other fields returned by ImageKit
}
```

**Files to create/modify:**
- Rewrite `src/services/image.ts` — replace SDK client with `fetch`-based helpers
- Update `src/services/book.ts:16` — replace type import with local type

---

### 2. `bcrypt` Native Addon — CRITICAL

**Why it fails on Edge:**
`bcrypt` (v6.0.0) is a native C++ addon compiled for Node.js. It requires `node-gyp` and the Node.js `bindings` module. The Edge Runtime cannot load `.node` binary modules.

**Where it is used:**

| File | Line(s) | Usage |
|------|---------|-------|
| `utils/password.ts` | 24 | `import bcrypt from 'bcrypt'` |
| `utils/password.ts` | 41 | `bcrypt.hash(password, SALT_ROUNDS)` |
| `utils/password.ts` | 62 | `bcrypt.compare(password, hashedPassword)` |
| `routes/auth.ts` | 113 (comment) | Referenced in doc comment only |

**Estimated effort:** 30 minutes

**Migration path:**

Replace with `bcryptjs`, a pure-JavaScript reimplementation with the exact same API:

```diff
- import bcrypt from 'bcrypt';
+ import bcrypt from 'bcryptjs';
```

That's it — `hash()` and `compare()` signatures are identical. The trade-off is performance: `bcryptjs` is ~5× slower than native `bcrypt`, but for login/signup volume (a few hashes per request) this is negligible.

**Alternative:** Use Web Crypto API with PBKDF2 for password hashing — more complex API change but avoids the dependency entirely.

---

### 3. `Buffer` (9+ Usages) — CRITICAL

**Why it fails on Edge:**
`Buffer` is a Node.js global. On the Edge Runtime, `typeof Buffer === 'undefined'`. Every reference to `Buffer.from()`, `Buffer.isBuffer()`, `Buffer.concat()` will throw a `ReferenceError`.

**All occurrences:**

| File | Line | Code | Edge Alternative |
|------|------|------|-----------------|
| `middleware/upload.ts` | 47 | `Buffer.from(await file.arrayBuffer())` | Remove conversion; pass `file` or `ArrayBuffer` directly |
| `services/image.ts` | 117 | `Buffer.from(base64Data, 'base64')` | `Uint8Array` from base64, or pass raw base64 string to ImageKit REST API |
| `services/image.ts` | 142 | `Buffer.isBuffer(uploadObj.buffer)` | `uploadObj.buffer instanceof ArrayBuffer` (if already `ArrayBuffer`) |
| `services/image.ts` | 145 | `Buffer.from(uploadObj.buffer)` | `new Uint8Array(uploadObj.buffer)` |
| `services/image.ts` | 156 | `Buffer.from(arrayBuffer)` | `new Uint8Array(arrayBuffer)` |
| `services/image.ts` | 278 | `Buffer.isBuffer(imageSource)` | `imageSource instanceof ArrayBuffer` |
| `routes/books.ts` | 1188 | `Buffer.concat(chunks).toString('utf-8')` | `chunks.join('')` or `new TextDecoder().decode(concatUint8Arrays(chunks))` |
| `utils/ai-image.ts` | 181 | `Buffer.from(imageData.imageData, "base64")` | `Uint8Array` from base64 |

**Estimated effort:** 4–6 hours for systematic replacement across all files.

**Key insight:** If blocker #1 (`@imagekit/nodejs`) is resolved by switching to ImageKit REST API, most `Buffer` usage in the image pipeline becomes unnecessary because you'd send base64 strings or `ArrayBuffer` directly in the HTTP request body. The only remaining `Buffer` usages would be:
- `routes/books.ts:1188` — streaming chunks (trivial fix)
- `utils/ai-image.ts:181` — optional disk-save path (conditional)

---

### 4. Neon Pool WebSocket Wiring — HIGH

**Why it could fail on Edge:**
`@neondatabase/serverless` v1.x `Pool` extends `pg.Pool` and by default uses the `ws` npm package for WebSocket connections. The `ws` package is Node.js-specific (depends on `net`/`tls`/`stream`). On Edge, `ws` throws on import.

**Where it is used:**

| File | Line(s) | Usage |
|------|---------|-------|
| `db/client.ts` | 29 | `import { Pool } from "@neondatabase/serverless"` |
| `db/client.ts` | 50 | `new Pool({ connectionString: DATABASE_URL })` |
| `db/client.ts` | 51 | `new Pool({ connectionString: DATABASE_READ_URL })` |

**Estimated effort:** 30 minutes + testing

**Migration path:**

Before creating the pool, configure Neon to use the global `WebSocket` constructor (available on Edge):

```typescript
import { Pool, neonConfig } from "@neondatabase/serverless";

neonConfig.webSocketConstructor = globalThis.WebSocket;

const writePool = new Pool({ connectionString: DATABASE_URL });
```

This is documented by Neon for Vercel Edge Functions. Drizzle's `drizzle-orm/neon-serverless` driver works with this pool configuration.

**Testing required:**
- Verify transactions (`dbWrite.transaction()`)
- Verify prepared statements (used heavily in this codebase)
- Verify connection reconnection behavior under Edge's ephemeral execution model

---

### 5. `crypto.createHash` (Node `crypto`) — HIGH

**Why it fails on Edge:**
`import { createHash } from "crypto"` imports the Node.js `crypto` module, which is not available on Edge.

**Where it is used:**

| File | Line(s) | Usage |
|------|---------|-------|
| `utils/cache.ts` | 27 | `import { createHash } from "crypto"` |
| `utils/cache.ts` | 501 | `createHash('sha256').update(content, 'utf8').digest('hex')` |

**Estimated effort:** 1–2 hours

**Migration path:**

Replace with Web Crypto API (`crypto.subtle.digest`):

```typescript
async function hashContentSHA256(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
```

**Ripple effect:** `hashContentSHA256` is called from `createCacheKey` (line 505), which is called from multiple places. Both functions must become `async`, requiring all callers to be updated with `await`.

---

### 6. Entrypoint Adapter — HIGH

**Why it needs to change:**
The current entrypoint `export default getRequestListener(app.fetch)` uses `@hono/node-server`'s `getRequestListener`, which converts a Node `IncomingMessage` into a Web `Request` for Hono. On Edge, Vercel already supplies a standard `Request` — no conversion needed.

**Where it is used:**

| File | Line(s) | Usage |
|------|---------|-------|
| `src/app.ts` | 11 | `import { getRequestListener } from "@hono/node-server"` |
| `src/app.ts` | 145 | `export default getRequestListener(app.fetch)` |

**Estimated effort:** 15 minutes

**Migration path:**

```diff
- import { getRequestListener } from "@hono/node-server";
+ import { handle } from "hono/vercel";

- export default getRequestListener(app.fetch);
+ export const runtime = "edge";
+ export default handle(app);
```

Note: `@hono/node-server` should remain as a `devDependency` for local development (used by `src/server.ts`).

**Potential gotcha:** The `hono/vercel` adapter's `handle()` accepts the app instance, not `app.fetch`. If you've attached middleware or context generics to the app, they carry over automatically.

---

### 7. Stripe Fetch Client Config — HIGH

**Why it fails on Edge:**
By default, `new Stripe(secretKey)` creates an HTTP client that uses Node.js's `http`/`https` modules. On Edge, these modules don't exist.

**Where it is used:**

| File | Line(s) | Usage |
|------|---------|-------|
| `utils/stripe.ts` | 12 | `new Stripe(requireEnv('STRIPE_SECRET_KEY'))` |

**Estimated effort:** 5 minutes

**Migration path:**

```diff
- return stripe || (stripe = new Stripe(requireEnv('STRIPE_SECRET_KEY')));
+ return stripe || (stripe = new Stripe(requireEnv('STRIPE_SECRET_KEY'), {
+   httpClient: Stripe.createFetchHttpClient(),
+ }));
```

This uses Stripe's built-in `fetch`-based HTTP client, which works on Edge (available since Stripe SDK v14+).

---

### 8. `fs` / `path` in `constants.ts` — LOW

**Why it could fail on Edge:**
`readFileSync` from `fs` and `join` from `path` are called once at module import time to read `package.json` for the app version.

**Where it is used:**

| File | Line(s) | Usage |
|------|---------|-------|
| `config/constants.ts` | 1–2 | `import { readFileSync } from "fs"` / `import { join } from "path"` |
| `config/constants.ts` | 21 | `join(process.cwd(), "package.json")` |
| `config/constants.ts` | 22 | `readFileSync(pkgPath, "utf8")` |

**Estimated effort:** 10 minutes

**Migration path:**

Vercel injects `npm_package_version` as an environment variable during build. The function already checks `process.env['npm_package_version']` first (line 20). Remove the `fs`/`path` fallback entirely:

```diff
- import { readFileSync } from "fs";
- import { join } from "path";

const getAppVersion = (): string => {
-   try {
-     if (process.env['npm_package_version']) return process.env['npm_package_version'];
-     const pkgPath = join(process.cwd(), "package.json");
-     const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
-     return pkg.version || "1.0.0";
-   } catch {
-     return "1.0.0";
-   }
+   return process.env['npm_package_version'] || "1.0.0";
};
```

---

### 9. `fs` / `path` in `ai-image.ts` — LOW

**Why it could fail on Edge:**
`fs.writeFileSync` and `path.join` are used to save AI-generated images to disk — but this code path is **optional** (guarded by `if (outputDir)`).

**Where it is used:**

| File | Line(s) | Usage |
|------|---------|-------|
| `utils/ai-image.ts` | 26 | `import * as fs from "fs"` |
| `utils/ai-image.ts` | 27 | `import * as path from "path"` |
| `utils/ai-image.ts` | 192–196 | `path.join(outputDir, ...)`, `fs.writeFileSync(filepath, buffer)` |

**Estimated effort:** 15 minutes

**Migration path:**

1. Move the `import` statements inside the conditional branch.
2. Or wrap them in a try-catch: disk writes will silently be skipped on Edge.
3. Or use dynamic `import()` only when the branch executes.

Simplest approach:

```typescript
if (outputDir) {
  const { writeFileSync } = await import("fs");
  const { join, resolve } = await import("path");
  // … existing disk-save code
}
```

This way the imports never execute on Edge (where `outputDir` is never set).

---

### 10. `@actions/core` (`group()`) — LOW

**Why it could fail on Edge:**
`@actions/core` is a GitHub Actions toolkit. Its `group()` function internally writes to `process.stdout` via `fs.writeSync()`, which fails on Edge.

**Where it is used:**

| File | Line(s) | Usage |
|------|---------|-------|
| `utils/error.ts` | 17 | `import { group } from '@actions/core'` |
| `utils/ai-logger.ts` | 7 | `import { group } from '@actions/core'` |
| `utils/ai-chat.ts` | 14 | `import { group } from '@actions/core'` |

The usage is always:

```typescript
group("label", async () => { /* … */ });
```

**Estimated effort:** 30 minutes

**Migration path:**

The Web API equivalent is `console.group()` / `console.groupEnd()`, which are available on Edge:

```diff
- import { group } from "@actions/core";
- await group("label", async () => { … });
+ console.group("label");
+ try {
+   await …;
+ } finally {
+   console.groupEnd();
+ }
```

Or, to keep the return-value propagation, a small wrapper:

```typescript
async function group<T>(label: string, fn: () => Promise<T>): Promise<T> {
  console.group(label);
  try {
    return await fn();
  } finally {
    console.groupEnd();
  }
}
```

---

### 11. `process.*` in Admin Route — LOW

**Why it fails on Edge:**
`process.uptime()`, `process.memoryUsage()`, and `process.version` are Node.js-specific. On Edge, they throw.

**Where it is used:**

| File | Line(s) | Usage |
|------|---------|-------|
| `routes/admin.ts` | 180 | `uptime: process.uptime()` |
| `routes/admin.ts` | 181 | `memoryUsage: process.memoryUsage()` |
| `routes/admin.ts` | 182 | `nodeVersion: process.version` |
| `app.ts` | 107 | `uptime: process.uptime()` (health endpoint) |

**Estimated effort:** 15 minutes

**Migration path:**

Guard with availability check:

```typescript
uptime: typeof process.uptime === "function" ? process.uptime() : null,
memoryUsage: typeof process.memoryUsage === "function" ? process.memoryUsage() : null,
nodeVersion: process.version ?? null,
```

For the health endpoint (`app.ts:107`), replace with a simple timestamp-based uptime:

```typescript
const startedAt = Date.now();
// later in health route:
uptime: (Date.now() - startedAt) / 1000,
```

---

### 12. SSE Route Durations — NOT A BLOCKER

The `README.md` currently lists long-running SSE routes as a reason to stay on Node. The project confirmed that:

| SSE Route | Status | Notes |
|-----------|--------|-------|
| `POST /api/books/:id/pages` (book creation) | **Legacy** | Not used |
| `GET /api/books/:identifier/:pageId/candidates` | **Legacy** | Not used |
| `GET /api/books/prompt` | **Active** | Lightweight, well under Edge 30s limit |

These routes use `streamSSE` from `hono/streaming`, which is fully Edge-compatible (it uses `WritableStream`/`ReadableStream` under the hood).

---

## Non-Blockers (Already Edge-Compatible)

These are used in the codebase but **do not require changes**:

| Dependency / API | Why it works on Edge |
|------------------|----------------------|
| `TextEncoder` / `TextDecoder` | Web APIs, available globally |
| `fetch` | Web API, available globally |
| `ReadableStream`, `WritableStream`, `TransformStream` | Web APIs, used by `hono/streaming` |
| `AbortSignal`, `AbortController` | Web APIs, available globally |
| `console.group` / `console.groupEnd` | Web APIs |
| `setTimeout`, `clearTimeout` | Web APIs, available globally |
| `crypto.subtle` | Web API, available globally |
| `process.env` | Supported on Edge (Vercel injects env vars) |
| `openai`, `@google/genai`, `@mistralai/mistralai`, `cohere-ai`, `groq-sdk` | All use `fetch` internally |
| `resend` | Uses `fetch` internally |
| `drizzle-orm` (core) | Works with any compatible driver |
| `lru-cache` | Pure JS, no Node deps |
| `@hono/auth-js` | Based on Auth.js which supports Edge |

---

## Migration Strategy (If Chosen)

### Phase 1 — Critical blockers (estimated: 3–5 days)

1. ✅ **Replace `@imagekit/nodejs` with REST API** — `services/image.ts` rewritten; `services/book.ts` type import updated
2. **Replace `bcrypt` with `bcryptjs`** — one-line change
3. **Systematic `Buffer` → `Uint8Array`/`ArrayBuffer` replacement** — `services/image.ts` done; remaining in `middleware/upload.ts`, `routes/books.ts`, `utils/ai-image.ts`

### Phase 2 — High blockers (estimated: 1–2 days)

4. **Configure Neon WebSocket for Edge** — `db/client.ts`
5. **Refactor `createHash` → Web Crypto** — `utils/cache.ts` (async ripple)
6. **Switch entrypoint to `hono/vercel`** — `app.ts`
7. **Configure Stripe fetch client** — `utils/stripe.ts`

### Phase 3 — Low blockers (estimated: half day)

8–11. Remove `fs`/`path` fallback, guard admin `process.*`, replace `@actions/core`, etc.

### Phase 4 — Verification (estimated: 1–2 days)

- Deploy to Vercel Edge preview environment
- Test all critical paths: auth (login/signup), image upload, Stripe webhook, book creation, SSE prompt streaming, DB transactions
- Compare cold-start latency vs Node baseline
- Monitor Edge function duration usage (30s cap)

**Total estimated effort: 6–10 days**

---

## Recommendation

The migration is **technically feasible** but requires significant rewrites in the image pipeline (the largest single piece of work). If `@imagekit/nodejs` is replaced with direct REST calls, every other blocker is a contained change.

**Consider migrating if:**
- Cold-start latency improvements justify the 1–2 week engineering investment
- The team is comfortable owning direct ImageKit REST API integration
- Image upload volume is modest (no need for the SDK's built-in retry/perf optimizations)

**Consider staying on Node.js if:**
- The image pipeline is critical and the SDK's stability is valued over cold-start speed
- Engineering time is better spent on product features
- The current Node.js performance is acceptable (Hono + Node 22 cold starts are already ~200–500ms)
