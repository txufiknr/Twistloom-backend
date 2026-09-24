# Dual Auth Architecture (Providers + Credentials)

## Overview

This document describes Twistloom’s **two orthogonal “dual” axes** and the **final implemented shape** as of 2026-09-23:

1. **Dual provider** (web face): Google OAuth + Email/Password via NextAuth v5 → one httpOnly session cookie.
2. **Dual credential** (multi-platform): that cookie (browser) **plus** short-lived bearer access JWTs + rotating opaque refresh secrets (native Flutter) → **one identity store, two credential adapters, one resource server** accepting both while rejecting mixed conflicting identities.

Cookie verification and `verify-credentials` remain the first-class browser path (non-breaking contract NB-1…NB-8 in the mobile roadmap). Mobile issuance/verification is additive and implemented behind `/api/auth/mobile/*` + a global bearer branch that no-ops when `Authorization` is absent.

### Dual provider vs dual credential

| Axis | What is dual | Face | Document |
|------|--------------|------|----------|
| **Dual provider** (web) | Google OAuth + email/password → one NextAuth cookie | First-party **web** | this file |
| **Dual credential** (multi-platform) | httpOnly cookie (web) **+** short-lived bearer/refresh (native Flutter) → one identity/resource server | Web **and** native | [NATIVE_MOBILE_BEARER_AUTH_ROADMAP](../roadmap/NATIVE_MOBILE_BEARER_AUTH_ROADMAP.md) · Flutter [MOBILE_AUTH_CONTRACT](../../../Twistloom-flutter/docs/roadmap/MOBILE_AUTH_CONTRACT.md) |

### Why this is industry standard?

**Alternative C — first-party OAuth 2.0 resource server + Auth.js session for browser — is the industry-standard multi-platform shape, not a transitional workaround.** Real-world precedents:

| Company | Browser face | Native / API face | Shared identity |
|---------|--------------|-------------------|-----------------|
| **Meta** | web cookies | Graph `access_token` | one account graph |
| **Google** | first-party cookies | OAuth bearer for first-party APIs | one Google account |
| **X (Twitter)** | web cookies | OAuth 1.0a / OAuth 2.0 API tokens | one account |
| **Stripe** | dashboard session | restricted/live **secret keys** (service bearers) | one account |
| **Most SaaS** | session cookie (Auth.js / Passport) | JWT access + rotating refresh (RFC 9700) | one users table |

What every mature multi-platform product converges on:

1. **One identity store** (users + sessions + credential material) — never two user tables.
2. **Two credential adapters** at the edge: cookie verifier (Auth.js JWE) and bearer verifier (JWT signature + `tv`/`sid` claims + optional service-bearer allow-list).
3. **One resource server** (this Hono API) that resolves both credential types onto the same `userId` before route guards (`requireAuth`).
4. **Reject mixed conflicting identities**: a request may present *either* credential, never two different users’ credentials at once (we never merge cookie + bearer into one request identity).
5. **Service bearers are a third, non-user class** (`CRON_SECRET`, webhooks) — exempt from the user-JWT branch so machine secrets never 401 as “invalid user token.”

**Why not force everyone onto OAuth/PKCE only?** Full OIDC authorization-code + PKCE for first-party web is a deferred non-goal: NextAuth already issues a secure httpOnly cookie with zero client-side token storage; adding a browser bearer would *increase* XSS token-steal surface without improving the threat model. Managed IdPs (Auth0/Cognito/Supabase) are an ops choice, not an architecture requirement — self-hosted Auth.js + local JWT verification keeps data residency and avoids vendor lock-in while implementing the same industry pattern.

**Opaque access tokens are a first-class Alternative C variant for v1** (Stripe-style server session lookup) if instant revoke outweighs local warm-path verify; Twistloom ships **JWT access + opaque rotating refresh** for M0 to match the signed Flutter contract (`sub`/`sid`/`tv`/`iss`/`aud`) and avoid a DB hit on every native API call. Both stay valid under C — freeze one **before** Flutter M0 ships.

**Two credential faces exist forever.** This is accepted product surface, not tech debt: web will keep cookies (CSRF, XSS, SameSite) and native will keep tokens (secure storage, refresh rotation). Shared control plane = `users.token_version` + `auth_sessions` + `refresh_families`.

## Implemented Dual-Credential Shape (2026-09-23)

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         Clients                                          │
│  Next.js (Auth.js cookie)              Flutter (Bearer access JWT)       │
│  Cookie: next-auth.session-token       Authorization: Bearer <jwt>       │
│  via same-origin rewrite               + refresh token (opaque)          │
└───────────────┬────────────────────────────────┬─────────────────────────┘
                │                                │
                ▼                                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Global auth middleware (src/app.ts)                                     │
│  1) bearerAuthMiddleware (src/middleware/bearer.ts)                       │
│     - No Authorization header → no-op (cookie path)                      │
│     - /api/cron/* + Bearer → skip (service-bearer registry)              │
│     - Non-Bearer scheme (Basic/bare Bearer) on non-service path →         │
│       **401 Invalid authorization scheme** (intentional; no cookie        │
│       fallback — present non-Bearer header claims bearer intent)          │
│     - Bearer <mobile JWT> → 15s identity LRU hit? else jose verify →     │
│       tv + ban + fresh sid → set (cache key = SHA-256(raw token);        │
│       CPU_OPTIMIZATIONS_ENABLED; logout → invalidateBearerCache)         │
│  2) verifyNextAuthToken (cookie) only if userId not already set          │
└───────────────┬──────────────────────────────────────────────────────────┘
                │  c.set("userId" / "user") — same AuthUser shape
                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Resource server (requireAuth / optionalAuth routes)                     │
│  One identity: users.user_id · token_version · auth_sessions · families  │
└──────────────────────────────────────────────────────────────────────────┘
```

### Endpoints (additive)

| Method | Path | Auth | Role |
|--------|------|------|------|
| POST | `/api/auth/verify-credentials` | public + IP limit | **Frozen** web NextAuth contract (NB-1) |
| POST | `/api/auth/mobile/token` | public + **Redis** IP limit | Password → access JWT + refresh family (ban → 403; session+family in **one transaction**) |
| POST | `/api/auth/mobile/refresh` | public + **Redis** IP limit | Rotate refresh (RFC 9700) + new access; banned → fail closed + family revoke |
| POST | `/api/auth/logout` | open (sets session) | Cookie body frozen; soft-revoke families + **delete session row** (cascade) + invalidate bearer identity cache |
| POST | `/api/auth/logout-all-devices` | Bearer/cookie | One tx: deletes all sessions (cascade removes families) + bumps `tv`; no separate family soft-revoke |
| POST | `/api/auth/logout-session` / logout-all | Bearer/cookie | Session-scoped family revoke; logout-all soft-revokes others via cascade |
| PUT | `/api/auth/password` | Bearer/cookie | Bumps `tv` + revokes families (credential change) |
| POST | `/api/auth/reset-password` | token | Same `tv` bump + family revoke |

### Claims & secrets

- Access JWT: `sub`, `sid`, `tv`, `iss=twistloom-backend`, `aud=reader` (provisional until parent Q6 / Step 12), `exp` (default 15 min), `iat`, header `kid=m0-hs256`, alg allow-list `HS256`.
- Signing key: **`MOBILE_ACCESS_SECRET`** (≥32 chars, **separate from `AUTH_SECRET`**). Dual-secret verify via `MOBILE_ACCESS_SECRET_PREVIOUS` during rotation.
- Refresh: 256-bit opaque hex; store **SHA-256 only** in `refresh_families` (current hash unique-indexed; prior hashes append-only in GIN-indexed `usedHashes`). Rotate atomically; reuse of any hash in `usedHashes` → **revoke entire family** (EQ3=B default; EQ3=A idempotent window is a fast-follow).

### Non-breaking guarantees (summary)

- Cookie path unchanged when `Authorization` absent.
- **Intentional hard-401 (no cookie fallback) for non-Bearer schemes:** a present `Authorization` header on a non-service path that is *not* a well-formed `Bearer <token>` (e.g. `Basic`, bare `Bearer`) claims bearer intent → `401 Invalid authorization scheme` (+ `WWW-Authenticate: Bearer`), never silent cookie fallback. In-repo callers checked 2026-09-23: only `/api/cron/*` reads inbound `Authorization` (service-bearer exempt); no known external `Basic`/`Token` clients. Tested by `tests/bearer-auth-matrix.test.ts`.
- `verify-credentials` response shape frozen.
- Logout cookie body byte-identical: `{ "message": "Logged out successfully" }`.
- `/api/cron/*` `Authorization: Bearer <CRON_SECRET>` never enters user-JWT verify.
- CORS already allows `Authorization` and no-Origin clients (`app.ts`).

**Source of truth for the full contract:** [NATIVE_MOBILE_BEARER_AUTH_ROADMAP](../roadmap/NATIVE_MOBILE_BEARER_AUTH_ROADMAP.md) §3 NB-1…NB-8.

## Architecture (web dual-provider detail)

```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend (NextAuth v5)                   │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Google OAuth              Email/Password                    │
│  signIn('google')    →    signIn('credentials', {            │
│                             email, password                  │
│                           })                                 │
│        ↓                        ↓                             │
│  NextAuth OAuth      NextAuth Credentials Provider           │
│  Provider            (calls backend API)                     │
│        ↓                        ↓                             │
│  ┌──────────────────────────────────────────┐               │
│  │  Both create NextAuth session cookie      │               │
│  │  (same cookie format, same JWT)          │               │
│  └──────────────────────────────────────────┘               │
│                                                              │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│              Backend (Credential Verification)              │
├─────────────────────────────────────────────────────────────┤
│  POST /api/auth/verify-credentials                          │
│  - Validates email/username and password                    │
│  - Returns user data if valid                               │
│  - NextAuth creates session cookie from response            │
│                                                              │
│  Security:                                                   │
│  - IP-based rate limiting (5 attempts/minute)               │
│  - Bcrypt password hashing                                  │
│  - Brute force protection                                   │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│              Backend (Session Verification)                 │
├─────────────────────────────────────────────────────────────┤
│  verifyNextAuthToken() - Verifies JWT from cookie            │
│  requireAuth - Middleware for protected routes              │
│  optionalAuth - Middleware for public routes                 │
└─────────────────────────────────────────────────────────────┘
```

## Login Flow Diagrams

### Google OAuth Login Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. User clicks "Sign in with Google"                           │
│     ↓                                                            │
│  2. Frontend calls signIn('google')                             │
│     ↓                                                            │
│  3. NextAuth redirects to Google OAuth                           │
│     ↓                                                            │
│  4. User authorizes on Google                                    │
│     ↓                                                            │
│  5. Google redirects back with OAuth token                      │
│     ↓                                                            │
│  6. NextAuth creates session cookie (httpOnly, secure)           │
│     ↓                                                            │
│  7. Frontend redirects to app (session cookie set)               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                         Backend                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  8. User makes first authenticated request                       │
│     ↓                                                            │
│  9. verifyNextAuthToken() called                                │
│     ↓                                                            │
│  10. getSession() verifies NextAuth JWT cookie                   │
│     ↓                                                            │
│  11. Extract email, name, image from session                     │
│     ↓                                                            │
│  12. Check if user exists in database by email                  │
│     ↓                                                            │
│  ┌─────────────────────────────────────────────────────┐       │
│  │  IF USER EXISTS:                                     │       │
│  │    → createOrUpdateOAuthUser() updates profile       │       │
│  │    → Cache invalidated                               │       │
│  └─────────────────────────────────────────────────────┘       │
│     ↓                                                            │
│  ┌─────────────────────────────────────────────────────┐       │
│  │  IF USER DOESN'T EXIST (First-time login):          │       │
│  │    → createOrUpdateOAuthUser() creates new user     │       │
│  │    → Creates user_auth record                        │       │
│  │    → Sets isNewUser=true                             │       │
│  │    → Cache invalidated                               │       │
│  └─────────────────────────────────────────────────────┘       │
│     ↓                                                            │
│  13. Return AuthUser { id, email, name }                        │
│     ↓                                                            │
│  14. Request proceeds with authenticated user                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘

Key Points:
- Auto-creates user on first-time Google login
- Updates profile data from Google on each login
```

### Email/Password Login Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. User enters email and password                               │
│     ↓                                                            │
│  2. Frontend calls signIn('credentials', {                       │
│       emailOrUsername, password                                  │
│     })                                                           │
│     ↓                                                            │
│  3. NextAuth Credentials Provider triggered                      │
│     ↓                                                            │
│  4. Provider calls POST /api/auth/verify-credentials            │
│     ↓                                                            │
│  5. Backend validates credentials (see below)                    │
│     ↓                                                            │
│  6. Backend returns user data if valid                          │
│     ↓                                                            │
│  7. NextAuth creates session cookie (httpOnly, secure)           │
│     ↓                                                            │
│  8. Frontend redirects to app (session cookie set)               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                         Backend                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────────────────────┐       │
│  │  POST /api/auth/verify-credentials                  │       │
│  │                                                       │       │
│  │  1. Rate limiting check (IP-based, 5/min)           │       │
│  │     ↓                                                │       │
│  │  2. Find user by email or username                   │       │
│  │     ↓                                                │       │
│  │  3. Check account lockout status                     │       │
│  │     ↓                                                │       │
│  │  4. Verify password with bcrypt                       │       │
│  │     ↓                                                │       │
│  │  5. Reset failed login attempts on success           │       │
│  │     ↓                                                │       │
│  │  6. Return user data (userId, email, name, etc.)    │       │
│  └─────────────────────────────────────────────────────┘       │
│     ↓                                                            │
│  9. User makes first authenticated request                       │
│     ↓                                                            │
│  10. verifyNextAuthToken() called                               │
│     ↓                                                            │
│  11. getSession() verifies NextAuth JWT cookie                  │
│     ↓                                                            │
│  12. Extract email, name, image from session                     │
│     ↓                                                            │
│  13. Check if user exists in database by email                   │
│     ↓                                                            │
│  ┌─────────────────────────────────────────────────────┐       │
│  │  IF USER EXISTS:                                     │       │
│  │    → createOrUpdateOAuthUser() updates profile       │       │
│  │    → Cache invalidated                               │       │
│  └─────────────────────────────────────────────────────┘       │
│     ↓                                                            │
│  14. Return AuthUser { id, email, name }                        │
│     ↓                                                            │
│  15. Request proceeds with authenticated user                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘

Key Points:
- User must exist in database (created via signup endpoint)
- Password verification with bcrypt
- Account lockout protection (5 failed attempts)
- Rate limiting to prevent brute force attacks
```

## How NextAuth Connects to Backend Endpoints

### Login Flow (signIn)

**Email/Password Login:**

1. **Frontend calls NextAuth:**
   ```typescript
   await signIn('credentials', {
     emailOrUsername: 'user@example.com',
     password: 'user123',
   });
   ```

2. **NextAuth Credentials Provider is triggered:**
   - NextAuth intercepts the `signIn('credentials')` call
   - The Credentials provider's `authorize()` function is executed
   - This function is configured in the frontend's NextAuth config

3. **Credentials Provider calls backend:**
   ```typescript
   // In frontend NextAuth config
   Credentials({
     async authorize(credentials) {
       const res = await fetch(`${BACKEND_URL}/api/auth/verify-credentials`, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({
           emailOrUsername: credentials.emailOrUsername,
           password: credentials.password,
         }),
       });

       if (!res.ok) return null;

       const user = await res.json();
       return user; // { userId, email, name, image }
     },
   })
   ```

4. **Backend verifies credentials:**
   - Backend receives POST request to `/api/auth/verify-credentials`
   - Validates email/username and password using bcrypt
   - Returns user data if valid, or error if invalid
   - Rate limited to prevent brute force attacks

5. **NextAuth creates session cookie:**
   - If backend returns valid user data, NextAuth creates a JWT session cookie
   - Cookie is stored in browser (httpOnly, secure, SameSite)
   - Subsequent requests automatically include this cookie

6. **Backend verifies session on subsequent requests:**
   - Backend middleware `verifyNextAuthToken()` validates JWT from cookie
   - Sets `c.get("userId")` for authenticated requests
   - Routes use `requireAuth` or `optionalAuth` middleware

**Google OAuth Login:**

1. Frontend calls `signIn('google')`
2. NextAuth handles OAuth flow (redirect to Google, callback, etc.)
3. No backend credential verification needed
4. NextAuth creates same session cookie format
5. Backend verifies session same way as email/password

### Logout Flow (signOut)

**Primary method (NextAuth):**

1. **Frontend calls NextAuth:**
   ```typescript
   await signOut({ callbackUrl: '/' });
   ```

2. **NextAuth clears session:**
   - NextAuth removes the session cookie from browser
   - Redirects to callback URL (e.g., home page)
   - No backend call needed for basic logout

3. **Backend receives no session cookie:**
   - On next request, browser doesn't send session cookie
   - Backend middleware detects no valid session
   - `c.get("userId")` is not set (unauthenticated)

**Backend cleanup (`POST /api/auth/logout`) — implemented, not a placeholder:**

The backend endpoint is no longer optional bookkeeping. On every call (cookie or bearer face):

1. Drops the current session-verify LRU entry (`invalidateCurrentSessionVerifyCache`).
2. If an `Authorization: Bearer` token was presented, **immediately invalidates** the 15s bearer identity cache for that token (`extractBearerToken` → `invalidateBearerCache`) so a warm entry cannot outlive logout.
3. If `sessionId` + `userId` are bound: soft-revokes `refresh_families` for the session, then **hard-deletes the `auth_sessions` row** (`logoutFromSpecificDevice`); `ON DELETE CASCADE` removes any remaining families.
4. Returns the byte-identical body `{ "message": "Logged out successfully" }` on success **and** on catch (NB-3/NB-4 — never becomes an error oracle).

Frontend cookie clearing remains NextAuth `signOut()`; this endpoint is the server-side revocation half (required for the mobile face, safe for web).

### Summary

- **Login:** NextAuth `signIn()` → Credentials provider → Backend `/verify-credentials` → Session cookie
- **Logout:** NextAuth `signOut()` clears the cookie; `POST /api/auth/logout` revokes server-side families + session row + bearer cache
- **Session verification:** Backend middleware validates JWT cookie (or bearer JWT) on every request
- **Both auth methods (Google + Email/Password)** create the same session cookie format

## Key Benefits

1. **Single Session Format**: Both auth methods create the same NextAuth session cookie
2. **Backend Simplicity**: Backend only needs to verify JWT cookies (already implemented)
3. **Security**: NextAuth handles CSRF, session management, and security best practices
4. **Flexibility**: Users can choose their preferred login method
5. **Credit System**: Book creation requires authentication and consumes credits (prevents abuse)

## Backend Implementation

### 1. Database Schema Changes

**File: `src/db/schema.ts`**

Added `passwordHash` field and unique constraints to users table:
```typescript
export const users = pgTable("users", {
  userId: userId().primaryKey(),
  name: text("name"),
  username: text("username").unique("users_username_unique"), // NEW: Unique constraint for login
  email: text("email").unique("users_email_unique"), // NEW: Unique constraint for login
  passwordHash: text("password_hash"), // NEW: Hashed password for email/password auth
  penName: text("pen_name"),
  gender,
  image,
  imageId,
  lastActive,
  createdAt,
  updatedAt,
}, (t) => [
  index("users_gender_idx").on(t.gender),
  index("users_created_at_idx").on(t.createdAt),
  // Note: email and username have unique constraints which automatically create indexes
]);
```

**Migration Required:**
```bash
pnpm db:generate
pnpm db:migrate
```

### 2. Password Hashing Utilities

**File: `src/utils/password.ts`**

Provides bcrypt-based password hashing and verification:
```typescript
import bcrypt from 'bcrypt';

const SALT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return await bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hashedPassword: string): Promise<boolean> {
  return await bcrypt.compare(password, hashedPassword);
}
```

### 3. Credential Verification Endpoint

**File: `src/routes/auth.ts`** (real Hono handler, mirrors `POST /verify-credentials`)

Endpoint for NextAuth Credentials provider:
```typescript
router.post('/verify-credentials', async (c) => {
  try {
    const ip = getClientIp(c);
    if (!checkRateLimitByIP(ip)) return cRateLimitError(c);

    const { emailOrUsername, password } = c.get("body");

    if (!emailOrUsername || !password) {
      return cValidationError(c, 'Email/username and password are required');
    }

    const userData = await getUserForAuth(emailOrUsername);
    if (!userData) {
      return cUnauthorizedError(c, 'Invalid credentials');
    }

    // Check account lockout
    const lockoutStatus = await checkAccountLockout(userData.userId);
    if (lockoutStatus.isLocked) {
      if (lockoutStatus.remainingTime === undefined) {
        await resetFailedLoginAttempts(userData.userId);
        return cRateLimitError(c, 'Account lock state inconsistent. Please try again.');
      }
      const minutesRemaining = Math.ceil(lockoutStatus.remainingTime / 60000);
      return c.json({
        error: `Account locked. Try again in ${minutesRemaining} minutes.`,
        lockedUntil: new Date(Date.now() + lockoutStatus.remainingTime).toISOString(),
      }, 429);
    }

    if (!userData.passwordHash) {
      return cUnauthorizedError(c, 'This account uses OAuth login. Please sign in with Google.');
    }

    const isValid = await verifyPassword(password, userData.passwordHash);
    if (!isValid) {
      await recordFailedLogin(userData.userId);
      return cUnauthorizedError(c, 'Invalid credentials');
    }

    await resetFailedLoginAttempts(userData.userId);

    // Session row for device tracking — embedded in the JWT by the frontend's
    // jwt() callback so later requests can be selectively revoked.
    const sessionId = await createSession(userData.userId);

    // Successful login invalidates any outstanding password-reset tokens.
    await revokePasswordResetTokens(userData.userId).catch(() => {});

    const access = await resolveAdminAccess(userData.userId);

    // NB-1 success payload shape is frozen — do not add/remove keys here.
    return c.json({
      userId: userData.userId,
      email: userData.email,
      name: userData.name,
      username: userData.username,
      imageUrl: userData.imageUrl,
      isNewUser: userData.isNewUser,
      isAdmin: access.isAdmin,
      sessionId,
    });
  } catch (error) {
    console.error('[POST /api/auth/verify-credentials] ❌ Credential verification error:', error);
    return cApiError(c, 'Failed to verify credentials', error, 500);
  }
});
```

### 4. Rate Limiting

**File: `src/middleware/rate-limit.ts`**

Two rate limiting strategies:

1. **User-based (authenticated endpoints)**: Uses Upstash Redis, keyed by `c.get("userId")` (via `rateLimitByUser`)
2. **IP-based (unauthenticated endpoints)**: Uses process LRU cache, keyed by IP address (`getClientIp(c)`)

```typescript
// For unauthenticated endpoints (login, signup, forgot-password)
// LRU: max 10,000 entries, TTL = AUTH_RATE_LIMIT_WINDOW_MS (default 60s)
// Returns true to allow the attempt; false when rate limited (callers emit 429)
export function checkRateLimitByIP(ip: string): boolean {
  const now = Date.now();
  const record = ipRateLimitCache.get(ip);

  if (!record || now > record.resetTime) {
    ipRateLimitCache.set(ip, { count: 1, resetTime: now + IP_RATE_WINDOW });
    return true;
  }

  if (record.count >= IP_RATE_LIMIT) {
    return false; // Rate limited
  }

  record.count++;
  ipRateLimitCache.set(ip, record);
  return true;
}
```

**Environment Variables (Optional):**
- `AUTH_RATE_LIMIT_MAX_ATTEMPTS`: Maximum attempts per window (default: 5)
- `AUTH_RATE_LIMIT_WINDOW_MS`: Time window in milliseconds (default: 60000 = 1 minute)

### 5. Route Registration

**File: `src/routes/index.ts`** (Hono mounting, not Express `router.use`)

```typescript
import authRouter from "./auth.js";

router.route("/auth", authRouter);
```

## Frontend Implementation Required

### 1. Configure NextAuth Credentials Provider

**File: `src/auth.ts` (frontend)**

Add Credentials provider to NextAuth configuration:

```typescript
import Credentials from 'next-auth/providers/credentials';
import type { NextAuthConfig } from 'next-auth';

export const authConfig: NextAuthConfig = {
  providers: [
    // Existing Google OAuth provider
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),

    // NEW: Email/Password Credentials provider
    Credentials({
      name: 'credentials',
      credentials: {
        emailOrUsername: { label: 'Email or Username', type: 'text' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        // Call backend to verify credentials
        const res = await fetch(`${process.env.BACKEND_URL}/api/auth/verify-credentials`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            emailOrUsername: credentials.emailOrUsername,
            password: credentials.password,
          }),
        });

        if (!res.ok) return null;

        const user = await res.json();
        
        // Return user object for NextAuth session
        return {
          id: user.userId,
          email: user.email,
          name: user.name,
          image: user.image,
        };
      },
    }),
  ],
  // ... rest of NextAuth config
};
```

### 2. Update Login Components

**Remove `AuthApi` service** - No longer needed with NextAuth.

**Use NextAuth signIn for both methods:**

```typescript
import { signIn } from 'next-auth/react';

// Google OAuth login
const handleGoogleLogin = async () => {
  await signIn('google');
};

// Email/Password login
const handleEmailLogin = async (emailOrUsername: string, password: string) => {
  const result = await signIn('credentials', {
    emailOrUsername,
    password,
    redirect: false,
  });

  if (result?.error) {
    console.error('Login failed:', result.error);
    // Show error to user
  } else {
    // Login successful, redirect or update UI
  }
};
```

### 3. Update Auth API Service

**Update:** `src/lib/services/auth-api.ts`

This service is still needed for signup, forgot-password, and logout operations.

**Changes needed:**
- Replace `login()` method to use NextAuth `signIn()` instead of backend API
- Keep `signup()` method (calls backend `POST /auth/signup`)
- Keep `requestPasswordReset()` method (calls backend `POST /auth/forgot-password`)
- Update `logout()` method to use NextAuth `signOut()` instead of backend API

**Example updated auth-api.ts:**
```typescript
import { signIn, signOut } from 'next-auth/react';

class AuthApi {
  // Use NextAuth for login (both Google and email/password)
  async login(credentials: { emailOrUsername: string; password: string }) {
    await signIn('credentials', {
      emailOrUsername: credentials.emailOrUsername,
      password: credentials.password,
    });
  }

  // Keep backend API for signup
  async signup(data: SignupData) {
    await fetch(`${BACKEND_URL}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  }

  // Keep backend API for password reset
  async requestPasswordReset(email: string) {
    await fetch(`${BACKEND_URL}/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
  }

  // Use NextAuth for logout
  async logout() {
    await signOut({ callbackUrl: '/' });
  }
}
```

### 4. Environment Variables

**Frontend `.env.local`:**
```bash
AUTH_SECRET=your-secret-here
AUTH_URL=http://localhost:3001
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
BACKEND_URL=http://localhost:3000
```

**Backend `.env.local`:**
```bash
AUTH_SECRET=your-secret-here (same as frontend — cookie JWE only)
FRONTEND_URL=http://localhost:3001
AUTH_URL=http://localhost:3001

# Mobile bearer (separate from AUTH_SECRET — min 32 chars)
MOBILE_ACCESS_SECRET=generate_openssl_rand_base64_32
# MOBILE_ACCESS_SECRET_PREVIOUS=   # dual-secret rotation window
MOBILE_ACCESS_TTL_MINUTES=15
MOBILE_REFRESH_TTL_DAYS=30
MOBILE_ACCESS_AUD=reader          # provisional until parent Q6 / Step 12

# Auth Rate Limiting (Optional)
AUTH_RATE_LIMIT_MAX_ATTEMPTS=5
AUTH_RATE_LIMIT_WINDOW_MS=60000
```

## User Registration Flow

### Backend Signup Endpoint

**File: `src/routes/auth.ts`** (real Hono handler, mirrors `POST /signup`)

```typescript
router.post('/signup', async (c) => {
  try {
    const ip = getClientIp(c);
    if (!checkRateLimitByIP(ip)) {
      return c.json({ error: 'Too many requests. Please try again later.' }, 429);
    }

    const { password, receiveEmails: _receiveEmails, agreedToTerms, ageConfirmed, referrer } = c.get("body");
    if (!password) return cValidationError(c, 'Password is required');
    if (!agreedToTerms) return cValidationError(c, 'You must agree to the terms');
    if (!ageConfirmed) return cValidationError(c, 'You must confirm you are at least 13 years old');

    const passwordValidation = validatePasswordStrength(password);
    if (!passwordValidation.valid) {
      return c.json({
        error: 'Password does not meet security requirements',
        details: passwordValidation.errors,
      }, 422);
    }

    const userData = await sanitizeUserData(c.get("body"), { res: c, createNew: true });
    if (!userData) return;

    if (isTemporaryEmail(userData.email)) {
      return cValidationError(c, 'Temporary or disposable email addresses are not allowed.', undefined, 422);
    }

    const passwordHash = await hashPassword(password);
    const newUser = await dbWrite.transaction(async (tx) => {
      const [user] = await tx.insert(users).values({
        userId: generateId(),
        ...userData,
        passwordHash,
        termsAcceptedAt: new Date(),
        termsVersion: CURRENT_TERMS_VERSION,
        ageConfirmedAt: new Date(),
      }).returning();
      await tx.insert(userAuth).values({ userId: user.userId });
      return user;
    });

    const verificationToken = await createEmailVerificationToken(newUser.userId);
    const verificationUrl = `${process.env.FRONTEND_URL}/verify-email?token=${verificationToken}`;
    const verificationEmailSent = await sendVerificationEmail(
      newUser.email,
      verificationUrl,
      verificationToken,
      { userId: newUser.userId },
    );

    let referralApplied = false;
    if (referrer && typeof referrer === 'string') {
      referralApplied = await setReferrerForNewUser(c, newUser.userId, referrer, { handleResponse: false });
    }

    return c.json({
      userId: newUser.userId,
      message: verificationEmailSent
        ? 'Account created. Please check your email to verify your account.'
        : 'Account created. Verification email failed to send.',
      verificationEmailSent,
      referrer,
      referralApplied,
    }, 201);
  } catch (error) {
    console.error('[signup] ❌ Sign up error:', error);
    return c.json({
      message: 'If account was created, please check your email to verify.',
      verificationEmailSent: false,
    }, 200);
  }
});
```

### Frontend Signup

Use NextAuth to sign in after successful signup:

```typescript
const handleSignup = async (signupData: SignupData) => {
  // Call backend signup endpoint
  const res = await fetch(`${process.env.BACKEND_URL}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(signupData),
  });

  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.error);
  }

  // Auto-sign in after successful signup
  await signIn('credentials', {
    emailOrUsername: signupData.email,
    password: signupData.password,
  });
};
```

### Password Reset Flow

**Backend Forgot-Password Endpoint**

**File: `src/routes/auth.ts`** (real Hono handler, mirrors `POST /forgot-password`)

```typescript
router.post('/forgot-password', async (c) => {
  try {
    const ip = getClientIp(c);
    if (!checkRateLimitByIP(ip)) {
      return c.json({ error: 'Too many requests. Please try again later.' }, 429);
    }

    const { email } = c.get("body");

    if (!email) {
      return cValidationError(c, 'Email is required');
    }

    let emailSent = false;
    const token = await createPasswordResetToken(email);

    if (token) {
      const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
      emailSent = await sendPasswordResetEmail(email, resetUrl); // locale resolved by email lookup
    }

    // Always return success — prevents email enumeration
    return c.json({
      message: 'Password reset email sent if account exists',
      emailSent,
    });
  } catch (error) {
    console.error('[forgot] ❌ Forgot password error:', error);
    // Still return success to prevent email enumeration
    return c.json({
      message: 'Password reset email sent if account exists',
      emailSent: false,
    });
  }
});
```

**Note:** Email delivery is implemented via `sendPasswordResetEmail` (single-use token, 1h expiry). The success body is returned whether or not the account exists (anti-enumeration).

**Backend Reset-Password Endpoint**

**File: `src/routes/auth.ts`** (real Hono handler, mirrors `POST /reset-password`)

```typescript
router.post('/reset-password', async (c) => {
  try {
    const ip = getClientIp(c);
    if (!checkRateLimitByIP(ip)) {
      return c.json({ error: 'Too many requests. Please try again later.' }, 429);
    }

    const { token, password } = c.get("body");

    if (!token || !password) {
      return cValidationError(c, 'Token and password are required');
    }

    const passwordValidation = validatePasswordStrength(password);
    if (!passwordValidation.valid) {
      return c.json({
        error: 'Password does not meet security requirements',
        details: passwordValidation.errors,
      }, 422);
    }

    const userId = await verifyPasswordResetToken(token);
    if (!userId) {
      return cValidationError(c, 'Invalid or expired reset token');
    }

    const success = await resetPassword(token, password);
    if (!success) {
      return cValidationError(c, 'Failed to reset password');
    }

    // Security notification (always on) — non-blocking
    const [userRow] = await dbRead
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1);
    if (userRow?.email) {
      const detailHtml = formatSecurityDetailHtml({
        at: new Date(),
        ip,
        userAgent: c.req.header('user-agent'),
      });
      sendEmailSafe('POST /auth/reset-password', () =>
        sendPasswordChangedEmail(userRow.email, userRow.name || 'there', detailHtml, { userId }),
      );
    }

    return c.json({ message: 'Password reset successfully' });
  } catch (error) {
    console.error('[reset] ❌ Reset password error:', error);
    return cApiError(c, 'Failed to reset password', error, 500);
  }
});
```

### Logout Endpoint

**File: `src/routes/auth.ts` (`POST /logout`, ~907-934)**

```typescript
router.post('/logout', async (c) => {
  try {
    await invalidateCurrentSessionVerifyCache(c);
    const user = c.get("user");
    const sessionId = user?.sessionId;
    const userId = c.get("userId");

    // Kill the warm 15s bearer identity cache for a presented token.
    const bearer = extractBearerToken(c.req.header("authorization"));
    if (bearer) await invalidateBearerCache(bearer);

    if (sessionId && userId) {
      await revokeFamiliesForSession(sessionId).catch(() => {});
      await logoutFromSpecificDevice(userId, sessionId).catch(() => {});
    } else if (sessionId) {
      await revokeFamiliesForSession(sessionId).catch(() => {});
    }

    return c.json({ message: 'Logged out successfully' });
  } catch (error) {
    // Cookie face must still return the byte-identical body even if revocation fails.
    return c.json({ message: 'Logged out successfully' });
  }
});
```

**Behavior summary:**

- Session-scoped family soft-revoke → session row hard-delete → `ON DELETE CASCADE` cleans remaining families.
- Bearer identity LRU invalidated for the presented token (15s cache in `src/middleware/bearer.ts`).
- Response body byte-identical on every path: `{ "message": "Logged out successfully" }`.
- Idempotent: missing/invalid credentials still return 200 (never an oracle for token validity).
- Frontend still calls `await signOut({ callbackUrl: '/' })` to clear the browser cookie.

Related routes:

- **`POST /logout-all`** — soft-revokes other sessions' families via cascade after `logoutFromAllOtherDevices`; no hard `DELETE` on `refresh_families`.
- **`POST /logout-all-devices`** — **one transaction**: deletes all sessions (cascade removes their families) and bumps `users.tokenVersion` (invalidates all outstanding JWTs). No separate family soft-revoke — a post-delete `revokedAt` update would match zero rows.
- **`POST /logout-session`** — deletes one session by id + cascades its families.

## Security Considerations

### Password Security
- **Bcrypt with 12 salt rounds** - Industry-standard password hashing
- **Never store plaintext passwords** - Always hash before storage
- **Password requirements** - Enforce minimum length and complexity on frontend

### Mobile / Bearer Security (implemented)
- **Ban at issue + refresh** — `/mobile/token` returns `403 Account banned` before any write; `evaluateRotation` fails closed (`reason: "banned"`, family revoked)
- **Atomic mobile login** — session + family inserts share one `dbWrite.transaction`
- **15s bearer identity LRU** — key = SHA-256(raw token), value = `{userId, email, claims}` after full verify; gated by `CPU_OPTIMIZATIONS_ENABLED`; invalidated on logout
- **Logout hard-deletes the session row** (cascade families) after soft-revoke; response body always `{ "message": "Logged out successfully" }`
- **logout-all soft-revokes** families (`revokedAt`) — session deletes cascade; no hard `DELETE` on `refresh_families`

### Rate Limiting
- **IP-based for auth endpoints** - Prevents brute force attacks
- **5 attempts per minute** - Reasonable limit for legitimate users
- **LRU cache** - Automatic memory management (max 10,000 IPs)

### OAuth Security
- **Google OAuth** - Handled by NextAuth (secure, battle-tested)
- **CSRF protection** - Built into NextAuth
- **Secure cookies** - httpOnly, secure, SameSite configured

### Session Security
- **JWT verification** - Every request verifies JWT cookie
- **Bearer identity LRU** - 15s TTL, key = SHA-256(raw token), gated by `CPU_OPTIMIZATIONS_ENABLED`; populated only after full verify (JWT + user load + fresh `sid`); invalidated on logout (`invalidateBearerCache`)
- **Automatic expiration** - Sessions expire after configured TTL
- **Revocation support** - `tokenVersion` bump, session-row delete (fresh `sid` check), family cascade revoke

## Testing

### Test Credential Verification Endpoint

```bash
# Create a test user with password (via database or signup endpoint)
# Then test login:

curl -X POST https://your-backend.vercel.app/api/auth/verify-credentials \
  -H "Content-Type: application/json" \
  -d '{"emailOrUsername": "test@example.com", "password": "testpass123"}'

# Expected success response:
{
  "userId": "user-uuid",
  "email": "test@example.com",
  "name": "Test User",
  "image": null
}

# Expected error response (invalid credentials):
{
  "error": "Invalid credentials"
}
```

### Test Rate Limiting

```bash
# Send 6 requests quickly (should fail on 6th)
for i in {1..6}; do
  curl -X POST https://your-backend.vercel.app/api/auth/verify-credentials \
    -H "Content-Type: application/json" \
    -d '{"emailOrUsername": "test@example.com", "password": "wrongpass"}'
  echo "---"
done

# Expected: First 5 return 401, 6th returns 429 (Too Many Attempts)
```

### Test NextAuth Integration

1. **Google OAuth**: Click "Sign in with Google" → Should redirect to Google → Back to app with session
2. **Email/Password**: Enter credentials → Should call verify-credentials → Create session
3. **Session persistence**: Refresh page → Should remain logged in
4. **Logout**: Should clear session cookie

## Troubleshooting

### Issue: "This account uses OAuth login"
**Cause:** User created via Google OAuth (no passwordHash in database)
**Solution:** User must sign in with Google, or add password to their account

### Issue: Rate limiting too aggressive
**Solution:** Adjust rate limits via environment variables:
- `AUTH_RATE_LIMIT_MAX_ATTEMPTS`: Maximum attempts per window (default: 5)
- `AUTH_RATE_LIMIT_WINDOW_MS`: Time window in milliseconds (default: 60000)

### Issue: NextAuth session not persisting
**Cause:** AUTH_SECRET mismatch between frontend and backend
**Solution:** Ensure both use the same AUTH_SECRET environment variable

### Issue: CORS errors
**Cause:** Frontend URL not in CORS allowed origins
**Solution:** Add frontend URL to `FRONTEND_URL` environment variable

## Migration Checklist

### Backend
- [x] Add passwordHash field to users schema
- [x] Add unique constraints to email and username
- [x] Create password hashing utilities
- [x] Create credential verification endpoint
- [x] Add IP-based rate limiting with LRU cache
- [x] Make rate limits configurable via environment variables
- [x] Register auth routes
- [x] Implement signup endpoint
- [x] Implement forgot-password endpoint
- [x] Implement logout endpoint (session delete + family cascade + bearer cache invalidation, 2026-09-23)
- [x] Dual credential: mobile token issue/refresh + bearer middleware + family revoke (2026-09-23)
- [x] Security audit corrections: ban at issue/refresh, atomic mobile login, 15s bearer identity LRU, logout-all cascade/soft-revoke (2026-09-23)
- [x] `refresh_families` migration **applied** (`drizzle/0099`, owner-confirmed 2026-09-23)
- [x] Step 10 local matrix green: non-Bearer 401, hybrid conflict 401, `logoutFromAllDevices` one transaction, family-keyed refresh rate limit (2026-09-23)
- [x] Cookie-regression baseline tests + CI workflow
- [ ] Full Step 10 integration suite (DB-backed)
- [ ] Step 11 wire fixtures / Flutter live capture
- [ ] Parent Q5 Apple Sign-in (Step 9)
- [ ] Parent Q6 pen audiences (Step 12)

### Frontend
- [ ] Add Credentials provider to NextAuth config
- [ ] Update AuthApi service (login/logout to use NextAuth, keep signup/forgot-password backend calls)
- [ ] Update login components to use NextAuth signIn
- [ ] Update environment variables
- [ ] Test both login methods (Google + Email/Password)
- [ ] Test session persistence

## References

- [NextAuth.js Documentation](https://next-auth.js.org/)
- [NextAuth Credentials Provider](https://next-auth.js.org/providers/credentials)
- [RFC 9700 — OAuth 2.0 Security Best Current Practice (refresh rotation / reuse detection)](https://www.rfc-editor.org/rfc/rfc9700)
- [NATIVE_MOBILE_BEARER_AUTH_ROADMAP](../roadmap/NATIVE_MOBILE_BEARER_AUTH_ROADMAP.md) — implementation plan + NB-1…NB-8 non-breaking contract
- Flutter [MOBILE_AUTH_CONTRACT](../../../Twistloom-flutter/docs/roadmap/MOBILE_AUTH_CONTRACT.md)
