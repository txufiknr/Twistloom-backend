# CSRF Protection

- [Threat Model](#threat-model)
- [Architecture Overview](#architecture-overview)
- [How It Protects Your Forms](#how-it-protects-your-forms)
- [Request Flow Diagrams](#request-flow-diagrams)
- [Why Zero Frontend Changes](#why-zero-frontend-changes)
- [Implementation Details](#implementation-details)
- [Edge Cases](#edge-cases)
- [Testing](#testing)

---

## Threat Model

### What is CSRF?

Cross-Site Request Forgery (CSRF) tricks an authenticated user's browser into
executing unwanted actions on a web application where they're logged in. The
attacker crafts a malicious page that automatically submits a form or makes a
request to the target site; the browser includes any cookies scoped to that
site, and the server cannot distinguish the forged request from a legitimate
one.

### Is Twistloom vulnerable?

| Factor | Production | Dev |
|--------|------------|-----|
| Auth mechanism | httpOnly JWT cookie (`__Secure-authjs.session-token`) | Same |
| SameSite | `none` (required for secure cookie + cross-domain setup) | `lax` |
| Cookie auto-sent on cross-site POST? | **Yes** | No (Lax blocks it) |
| Backend domain | Different subdomain (hidden behind Next.js rewrite proxy) | Same |
| Form-based CSRF vector | **Exists** | None |

**Production is vulnerable to form-based CSRF** because `SameSite=None` causes
the browser to include the session cookie on cross-origin POST submissions.
While the request body is `application/x-www-form-urlencoded` (not JSON), the
defense is incidental — not all endpoints and not all future code paths may
reject form-encoded data.

The CSRF middleware closes this gap by validating the `Origin` header at the
Hono backend.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                          BROWSER (Victim)                            │
│                                                                      │
│  Logged in at https://twistloom-web.vercel.app                       │
│  Cookie: __Secure-authjs.session-token=abc...                        │
│                                                                      │
│  ┌─ evil.com opens <form action="https://twistloom-web.vercel.app/   │
│  │                 api/backend/user/profile" method="POST">          │
│  │  <input name="name" value="Hacker">                               │
│  │                                                                   │
│  │  User clicks submit (or auto-submit via JS)                       │
│  │                                                                   │
│  │  Browser sends:                                                   │
│  │    POST /api/backend/user/profile                                 │
│  │    Host: twistloom-web.vercel.app                                 │
│  │    Origin: https://evil.com         ◄─── Set by browser           │
│  │    Cookie: __Secure-authjs.session-token=abc...                   │
│  └───────────────────────────────────────────────────────────────────│
│                              │                                       │
└──────────────────────────────┼───────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│               NEXT.JS REWRITE PROXY (same process)                   │
│                                                                      │
│  /api/backend/user/profile ───→ https://twistloom-backend.vercel.app │
│                                       /api/user/profile              │
│                                                                      │
│  Forwards headers (including Origin and Cookie) from original        │
│  browser request to the Hono backend.                                │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     HONO.JS BACKEND (Middleware Chain)                │
│                                                                      │
│  1. cors()         → Allows the request origin (or rejects preflight)│
│  2. csrf()         → Checks Origin: "https://evil.com"               │
│                      Does NOT match allowed origins → ❌ 403 Forbidden│
│                                                                      │
│  ── Never reaches body parsing, auth, or route handler ──            │
└──────────────────────────────────────────────────────────────────────┘
```

### Legitimate request (allowed)

```
Browser (twistloom-web.vercel.app)
  │  POST /api/backend/user/profile
  │  Origin: https://twistloom-web.vercel.app
  │  Cookie: __Secure-authjs.session-token=abc...
  ▼
Next.js rewrite proxy (forwards headers)
  │  POST /api/user/profile
  │  Origin: https://twistloom-web.vercel.app
  │  Cookie: __Secure-authjs.session-token=abc...
  ▼
Hono backend
  1. cors()     → Origin *.vercel.app → allowed
  2. csrf()     → Origin: "https://twistloom-web.vercel.app"
                  ends with ".vercel.app" → ✅ allowed
  3. auth()     → Cookie verified → userId resolved
  4. handler()  → Executes mutation
```

### CSRF attack (blocked)

```
Browser (evil.com)
  │  <form action="https://twistloom-web.vercel.app/api/backend/user/profile">
  │  POST /api/backend/user/profile
  │  Origin: https://evil.com
  │  Cookie: __Secure-authjs.session-token=abc...
  ▼
Next.js rewrite proxy (forwards headers)
  │  POST /api/user/profile
  │  Origin: https://evil.com
  │  Cookie: __Secure-authjs.session-token=abc...
  ▼
Hono backend
  1. cors()     → Origin *.vercel.app → no; not in allowedOrigins → null
                  null origin → CORS rejects the preflight
                  (But form submissions don't send preflights!)
  2. csrf()     → Origin: "https://evil.com"
                  doesn't end with ".vercel.app"
                  not in allowedOrigins → ❌ 403 Forbidden

  ➜ Request rejected before any auth or business logic runs.
```

> **Note:** Form submissions bypass CORS preflight entirely (they're simple
> requests). That's why CORS alone is insufficient — CSRF middleware is the
> correct layer for this defense.

---

## How It Protects Your Forms

| Scenario | CSRF middleware | Result |
|----------|----------------|--------|
| `<form>` POST from `evil.com` → `/api/backend/user/profile` | `Origin: https://evil.com` → not allowed | **403 blocked** |
| Fetch/XHR from `evil.com` with `credentials: 'include'` | Preflight OPTIONS → CORS rejects (no `Access-Control-Allow-Origin: evil.com`) | **Blocked by CORS** (already safe before CSRF) |
| Same-origin fetch from your frontend (axios) | `Origin: https://twistloom-web.vercel.app` → `.vercel.app` allowed | **200 allowed** |
| Server-to-server via `fetchWithLogs` (Next.js → Hono) | No `Origin` header → `!origin → true` | **200 allowed** |
| Stripe webhook POST → `/api/stripe/webhook` | No `Origin` header → `!origin → true` | **200 allowed** |
| Mobile app / CLI / curl → `/api/*` | No `Origin` header → `!origin → true` | **200 allowed** |
| GET / OPTIONS / HEAD requests | CSRF middleware skips safe methods by default | **200 allowed** |
| malformed `Origin: null` (file://, data URIs) | `!origin` is false (string `"null"` is truthy), `"null"` not in allowed → | **403 blocked** |

---

## Why Zero Frontend Changes

The protection is completely transparent to the frontend because:

1. **Same rewrite proxy path**: All browser-originated API calls go through
   `/api/backend/*` → Next.js rewrite proxy → Hono backend. The rewrite proxy
   forwards the browser's `Origin` header unchanged. No frontend code change is
   needed to "add" anything to requests.

2. **No CSRF tokens required**: Unlike the Double Submit Cookie or
   synchronizer token patterns, Hono's CSRF middleware relies exclusively on
   the `Origin` header — which the browser sets automatically and which cannot
   be spoofed by client-side JavaScript for cross-origin requests.

3. **No `credentials` mode changes**: The frontend already uses
   `withCredentials: true` (axios) / `credentials: 'include'` (fetch). This
   doesn't need to change. The CSRF middleware operates independently of how
   credentials are transmitted.

4. **No configuration per endpoint**: The middleware is applied globally to
   `/api/*`. Every existing and future API endpoint is protected without any
   per-route annotations or opt-in.

5. **Existing CORS config is reused**: The same `allowedOrigins` set and
   `*.vercel.app` wildcard logic powers both CORS and CSRF, keeping the origin
   policy in a single source of truth.

---

## Implementation Details

### File: `src/app.ts`

```ts
import { csrf } from "hono/csrf";

// Middleware order is critical:
// 1. CORS (handles preflight at the outermost layer)
// 2. CSRF (rejects cross-origin mutations before any parsing/auth)
// 3. Auth init / verification
// 4. Body parsing
// 5. Locale extraction
// 6. Rate limiting

app.use("/api/*", csrf({
  origin: (origin) => {
    if (!origin) return true;                         // server-to-server, webhooks, mobile
    if (origin.endsWith(".vercel.app")) return true;  // all Vercel deployments (prod + preview)
    return allowedOrigins.has(origin);                 // explicit origins (localhost, custom domain)
  },
}));
```

### Middleware ordering rationale

```
Request → cors() → csrf() → auth() → parseJsonBody() → extractLocale() → rateLimit() → route
```

CSRF runs **before** body parsing and auth so that malicious requests are
rejected with minimal overhead — no JSON parsing, no session lookup, no
database queries for a request that will be rejected anyway.

### Allowed origin sources

The `allowedOrigins` set is defined at the top of `app.ts`:

```ts
const allowedOrigins = new Set([
  process.env.FRONTEND_URL,                    // customizable via env var
  "https://twistloom-web.vercel.app",          // production
  "https://localhost:3002",                     // dev with HTTPS (pnpm dev:ssl)
  "http://localhost:3001",                      // dev (pnpm dev)
].filter(Boolean) as string[]);
```

The `*.vercel.app` wildcard automatically covers all Vercel Preview
Deployments without needing to enumerate them.

---

## Edge Cases

### 1. Server-to-server calls (fetchWithLogs, auth callbacks)

Calls made from Next.js server code (e.g., the `session()` callback in
`src/auth.ts`, `generateMetadata`, server components) use `fetchWithLogs()`
which calls the backend directly using the full backend URL. These requests
have **no `Origin` header** because they originate from a server, not a
browser.

The CSRF middleware allows these by returning `true` when `!origin`.

### 2. Stripe webhooks

Stripe sends POST requests directly to the backend. No `Origin` header is
present. Allowed by the `!origin` fallback. Stripe's own signature
verification (`stripe-signature` header) provides authentication.

### 3. Missing `Origin` header (older browsers, privacy tools)

Some browsers or privacy extensions may strip the `Origin` header. Hono's CSRF
middleware falls back to the `Referer` header when `Origin` is absent. The
`Referer` of a legitimate request from your frontend would be
`https://twistloom-web.vercel.app/...`, which matches `*.vercel.app`. If both
`Origin` and `Referer` are missing, the request is allowed (same as `!origin
→ true`).

### 4. `Origin: null`

Some environments send `Origin: null` (e.g., `file://` protocol, data URIs,
sandboxed iframes). The string `"null"` is truthy in JavaScript, so the
`!origin` check does not catch it. Such requests are blocked unless explicitly
allowed — which is the correct behavior since a browser making API calls from
a `file://` page should not be able to mutate authenticated state.

### 5. GET-based state changes

The CSRF middleware only validates non-safe methods (POST, PUT, DELETE, PATCH,
etc.) by default. GET, HEAD, and OPTIONS requests pass through. If any
endpoint performs state-changing operations via GET (an anti-pattern), that
endpoint should be refactored to use POST.

### 6. Multi-region / custom domains

If a custom domain is used (e.g., `twistloom.com`), it must be added to
`allowedOrigins` or the `FRONTEND_URL` env var must be set. The `*.vercel.app`
wildcard will not match a custom domain.

---

## Testing

### Manual verification

Use curl to verify CSRF blocking works:

```bash
# Legitimate request (no Origin) — should succeed for public endpoints
curl -X POST https://twistloom-backend.vercel.app/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"..."}'

# CSRF attempt (evil origin) — should return 403
curl -X POST https://twistloom-backend.vercel.app/api/user/profile \
  -H "Origin: https://evil.com" \
  -H "Content-Type: application/json" \
  -H "Cookie: __Secure-authjs.session-token=..." \
  -d '{"name":"Hacker"}'

# Expected: 403 Forbidden with { "success": false, "error": "Forbidden" }
```

### Automated tests

If the backend has integration tests, add a test case that verifies a POST
request with a disallowed `Origin` header returns 403.
