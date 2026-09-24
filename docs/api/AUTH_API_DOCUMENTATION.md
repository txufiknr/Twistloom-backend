# Authentication API Documentation

## Overview

The Authentication API provides endpoints for user registration, credential verification, Google OAuth, password management, email verification, session management, and native mobile bearer token issue/refresh. This API works in conjunction with NextAuth v5 to provide a complete authentication solution supporting Google OAuth, Email/Password, and native mobile bearer authentication.

**Base URL:** `/api/auth`

**Authentication:** Most endpoints are public (no authentication required) for signup/login flows. Protected endpoints use NextAuth JWT cookies **or** short-lived mobile bearer access tokens via the `requireAuth` middleware.

**Architecture:**
- NextAuth v5 handles session creation and cookie management
- Backend validates credentials and manages user data
- Email/Password and Google OAuth authentication methods supported
- Native mobile clients use `POST /mobile/token` + `POST /mobile/refresh` for bearer access tokens (HS256 JWT) with rotating opaque refresh secrets

**Authentication faces (multi-platform):** protected endpoints accept **NextAuth JWT cookies** (web) and **Bearer access tokens** (native Flutter). One identity store, two credential adapters — dual credential. Cookie verification remains first-class; bearer issue/refresh routes (`POST /mobile/token`, `POST /mobile/refresh`) are implemented and documented below. Verified bearer identities may be cached in a **15s process LRU** keyed by SHA-256(raw token) (gated by `CPU_OPTIMIZATIONS_ENABLED`); logout invalidates the presented token immediately. See [DUAL_AUTH_ARCHITECTURE.md](../architecture/DUAL_AUTH_ARCHITECTURE.md) for architecture details.

---

## Table of Contents

1. [Credential Verification](#credential-verification)
   - [Verify Credentials](#post-apiauthverify-credentials)
2. [User Registration](#user-registration)
   - [Sign Up](#post-apiauthsignup)
3. [Password Management](#password-management)
   - [Forgot Password](#post-apiauthforgot-password)
   - [Reset Password](#post-apiauthreset-password)
4. [Email Verification](#email-verification)
   - [Verify Email](#post-apiauthverify-email)
   - [Resend Verification](#post-apiauthresend-verification)
5. [Google Authentication](#google-authentication)
   - [Google One Tap](#post-apiauthgoogle-one-tap)
   - [Google OAuth](#post-apiauthgoogle-oauth)
6. [Mobile Bearer Tokens](#mobile-bearer-tokens)
   - [Issue Tokens](#post-apiauthmobiletoken)
   - [Refresh Tokens](#post-apiauthmobilerefresh)
7. [Session Management](#session-management)
   - [Get Active Sessions](#get-apiauthsessions)
   - [Delete Session](#delete-apiauthsessionsid)
   - [Logout from Other Devices](#post-apiauthlogout-all)
   - [Logout from All Devices](#post-apiauthlogout-all-devices)
   - [Logout from Specific Session](#post-apiauthlogout-session)
   - [Logout](#post-apiauthlogout)
8. [Account Linking](#account-linking)
   - [Link Google](#post-apiauthlinkgoogle)
   - [Unlink Google](#post-apiauthunlinkgoogle)
   - [Link Credentials](#post-apiauthlinkcredentials)
   - [Unlink Credentials](#post-apiauthunlinkcredentials)
9. [Account Management](#account-management)
   - [Change Email](#put-apiauthemail)
   - [Change Password](#put-apiauthpassword)
   - [Change Username](#put-apiauthusername)

---

## Credential Verification

### POST /api/auth/verify-credentials

Verifies email/username and password credentials for the NextAuth Credentials provider. This endpoint is called by NextAuth during the authentication flow.

**Authentication:** Not required (public endpoint)

**Rate Limiting:** IP-based rate limiting to prevent brute force attacks

**Request Body:**
```json
{
  "emailOrUsername": "string", // Email or username
  "password": "string"         // Plaintext password
}
```

**Response (200 OK):**
```json
{
  "userId": "user-uuid",
  "email": "user@example.com",
  "name": "John Doe",
  "username": "johndoe",
  "imageUrl": "https://ik.imagekit.io/abc123/profile.jpg",
  "isNewUser": false,
  "isAdmin": false,
  "sessionId": "session-uuid"
}
```

**Error Responses:**
- `400 Bad Request`: Email/username and password are required
  ```json
  { "success": false, "error": "Email/username and password are required" }
  ```
- `401 Unauthorized`: Invalid credentials or account uses OAuth
  ```json
  { "success": false, "error": "Invalid credentials" }
  ```
- `429 Too Many Requests`: Account locked or rate limit exceeded
  ```json
  {
    "error": "Account locked. Try again in 5 minutes.",
    "lockedUntil": "2023-01-01T12:05:00.000Z"
  }
  ```
- `500 Internal Server Error`: Server error

**Security Features:**
- IP-based rate limiting to prevent brute force attacks
- Account lockout mechanism with exponential backoff (5→15→60 minutes)
- Bcrypt password verification (12 salt rounds)
- Returns minimal user data (no sensitive information)
- Checks for account lockout before password verification
- Creates an `auth_sessions` row so subsequent requests are attributable to this device

**Account Lockout Thresholds:**
- 5 failed attempts: 5-minute lockout
- 10 failed attempts: 15-minute lockout
- 15 failed attempts: 1-hour lockout

---

## User Registration

### POST /api/auth/signup

Registers a new user account with email/password authentication. Creates both user profile and authentication records, sends email verification.

**Authentication:** Not required (public endpoint)

**Rate Limiting:** IP-based rate limiting to prevent abuse

**Request Body:**
```json
{
  "email": "string",           // User email (required)
  "username": "string",        // Username (required)
  "gender": "string",          // Gender: male/female/other (optional — not required by signup)
  "password": "string",        // Plaintext password (required)
  "receiveEmails": boolean,    // Email subscription preference (optional)
  "agreedToTerms": boolean,    // Terms agreement (required)
  "ageConfirmed": boolean,     // Age ≥ 13 confirmation (required)
  "referrer": "string"         // Referrer userId or referral code (optional)
}
```

**Password Requirements:**
- Minimum 8 characters, maximum 128 characters
- At least one uppercase letter
- At least one lowercase letter
- At least one number
- At least one special character
- Cannot be an exact match of common passwords (password, 123456, qwerty, etc.)

**Response (201 Created):**
```json
{
  "userId": "user-uuid",
  "message": "Account created. Please check your email to verify your account.",
  "verificationEmailSent": true,
  "referrer": "referrer-uuid",
  "referralApplied": true
}
```

**Error Responses:**
- `400 Bad Request`: Invalid input, weak password, terms not agreed, or age not confirmed
  ```json
  {
    "success": false,
    "error": "You must confirm you are at least 13 years old"
  }
  ```
- `409 Conflict`: Email or username already exists
- `422 Unprocessable Entity`: Weak password, invalid username, or disposable email
  ```json
  {
    "error": "Password does not meet security requirements",
    "details": ["Password must be at least 8 characters long", "Password must contain at least one uppercase letter"]
  }
  ```
- `429 Too Many Requests`: Rate limit exceeded
  ```json
  { "error": "Too many requests. Please try again later." }
  ```

**Security Features:**
- IP-based rate limiting
- Password strength validation
- Bcrypt password hashing (12 salt rounds)
- Email and username uniqueness enforced
- Temporary/disposable email addresses blocked
- Separate `user_auth` table for authentication data (GDPR compliance)

**Database Operations:**
1. Creates user record in `users` table
2. Creates corresponding record in `user_auth` table
3. Generates email verification token (24 hour expiry)
4. Sends verification email via Resend
5. Applies referral if valid referrer provided

**Environment Variables Required:**
- `FRONTEND_URL`: Frontend URL for email links
- `RESEND_API_KEY`: Resend API key for email sending
- `RESEND_FROM_EMAIL`: Sender email address

---

## Password Management

### POST /api/auth/forgot-password

Initiates password reset flow by generating a secure token and sending a password reset email.

**Authentication:** Not required (public endpoint)

**Rate Limiting:** IP-based rate limiting to prevent email spam

**Request Body:**
```json
{
  "email": "string"  // User email address
}
```

**Response (200 OK):**
```json
{
  "message": "Password reset email sent if account exists",
  "emailSent": true
}
```

The `emailSent` field indicates whether Resend successfully accepted the email delivery request. Always `false` for non-existing emails (prevents enumeration).

**Error Responses:**
- `400 Bad Request`: Email is required
- `429 Too Many Requests`: Rate limit exceeded

**Security Features:**
- IP-based rate limiting
- Email enumeration prevention (always returns success)
- Secure token generation (random UUID)
- Token expires after 1 hour
- One-time use token

**Email Template:**
The email contains a reset link in the format:
```
{FRONTEND_URL}/reset-password?token={reset_token}
```

**Database Operations:**
1. Finds user by email in `users` table
2. Generates password reset token in `user_auth` table
3. Sends reset email via Resend

**Environment Variables Required:**
- `FRONTEND_URL`: Frontend URL for email links
- `RESEND_API_KEY`: Resend API key
- `RESEND_FROM_EMAIL`: Sender email address

---

### POST /api/auth/reset-password

Resets user password using a valid reset token. Validates token, password strength, and updates password.

**Authentication:** Not required (public endpoint)

**Rate Limiting:** IP-based rate limiting to prevent abuse

**Request Body:**
```json
{
  "token": "string",    // Password reset token from email
  "password": "string"  // New password
}
```

**Password Requirements:** Same as signup endpoint

**Response (200 OK):**
```json
{
  "message": "Password reset successfully"
}
```

**Error Responses:**
- `400 Bad Request`: Token and password required, invalid/expired token, or weak password
  ```json
  {
    "success": false,
    "error": "Invalid or expired reset token"
  }
  ```
- `422 Unprocessable Entity`: Weak password
  ```json
  {
    "error": "Password does not meet security requirements",
    "details": ["Password must be at least 8 characters long"]
  }
  ```
- `429 Too Many Requests`: Rate limit exceeded
- `500 Internal Server Error`: Server error

**Security Features:**
- IP-based rate limiting
- Token validation (checks expiry and existence)
- Password strength validation
- Token is single-use (revoked after use)
- Resets failed login attempts on success
- Clears lockout status on success
- Bumps `users.tokenVersion` and revokes all mobile refresh families in one transaction (invalidates outstanding bearer access + refresh tokens)

**Database Operations (single transaction):**
1. Verifies token in `user_auth` table
2. Validates token expiry
3. Hashes new password with bcrypt
4. Updates `users.password_hash` and increments `users.tokenVersion`
5. Deletes all rows in `refresh_families` for the user (mobile token revocation)
6. Clears reset token and lockout in `user_auth` table
7. Sends security notification email (non-blocking, outside transaction)

---

## Email Verification

### POST /api/auth/verify-email

Verifies user email using a verification token sent during signup.

**Authentication:** Not required (public endpoint)

**Rate Limiting:** IP-based rate limiting

**Request Body:**
```json
{
  "token": "string"  // Email verification token
}
```

**Response (200 OK):**
```json
{
  "message": "Email verified successfully"
}
```

**Error Responses:**
- `400 Bad Request`: Token is required or invalid/expired
- `429 Too Many Requests`: Rate limit exceeded
- `500 Internal Server Error`: Server error

**Security Features:**
- Token expires after 24 hours
- Token is single-use (revoked after verification)
- Token validation prevents replay attacks

**Database Operations:**
1. Verifies token in `user_auth` table
2. Validates token expiry
3. Sets `email_verified` timestamp
4. Clears `email_verification_token` and `email_verification_expires`

---

### POST /api/auth/resend-verification

Resends email verification token for users who didn't receive or lost their verification email.

**Authentication:** Not required (public endpoint)

**Rate Limiting:** IP-based rate limiting to prevent abuse

**Request Body:**
```json
{
  "email": "string"  // User email address
}
```

**Response (200 OK):**
```json
{
  "message": "Verification email sent if account exists",
  "emailSent": true
}
```

`emailSent` indicates whether the email was actually sent via Resend. Always `false` for non-existing or already-verified emails (prevents enumeration). Same response body returned for all code paths including unexpected errors.

**Error Responses:**
- `400 Bad Request`: Email is required
- `429 Too Many Requests`: Rate limit exceeded

**Security Features:**
- IP-based rate limiting
- Email enumeration prevention (always returns the same response regardless of email existence or verification status, including on unexpected errors)
- Checks if email is already verified before sending
- Generates new token (invalidates old token)

**Database Operations:**
1. Finds user by email in `users` table
2. Checks if email is already verified in `user_auth` table
3. Generates new verification token in `user_auth` table
4. Sends verification email via Resend

**Environment Variables Required:**
- `FRONTEND_URL`: Frontend URL for email links
- `RESEND_API_KEY`: Resend API key
- `RESEND_FROM_EMAIL`: Sender email address

---

## Google Authentication

### POST /api/auth/google-one-tap

Verifies a Google ID token from the GIS One Tap popup and creates/updates the user. This endpoint is used by the NextAuth `googleonetap` Credentials provider in `authorize()`.

**Authentication:** Not required (public endpoint)

**Rate Limiting:** IP-based rate limiting to prevent abuse

**Request Body:**
```json
{
  "idToken": "string"  // Google ID token from GIS One Tap
}
```

**Response (200 OK):**
```json
{
  "userId": "user-uuid",
  "email": "user@example.com",
  "name": "John Doe",
  "username": "johndoe",
  "imageUrl": "https://lh3.googleusercontent.com/abc123/photo.jpg",
  "isNewUser": false,
  "isAdmin": false,
  "sessionId": "session-uuid"
}
```

**Error Responses:**
- `400 Bad Request`: ID token is required
  ```json
  { "success": false, "error": "ID token is required" }
  ```
- `401 Unauthorized`: Token verification failed or invalid payload
- `429 Too Many Requests`: Rate limit exceeded
- `500 Internal Server Error`: Server error

**Security Features:**
- Verifies Google ID token signature and audience
- Extracts user info from verified token payload
- IP-based rate limiting to prevent abuse
- Uses Google OAuth2Client for token verification
- Creates an `auth_sessions` row for device tracking

**Database Operations:**
1. Verifies Google ID token signature and audience
2. Extracts user info (email, name, picture) from token
3. Creates or updates user account via `createOrUpdateOAuthUser()`
4. Creates device session for tracking
5. Resolves admin status for JWT embedding
6. Fetches complete user data for NextAuth session

**Environment Variables Required:**
- `GOOGLE_CLIENT_ID`: Google OAuth client ID

**NextAuth Integration:**
```typescript
// NextAuth Credentials provider usage
Credentials({
  id: 'googleonetap',
  name: 'Google One Tap',
  credentials: {
    credential: { label: 'Credential', type: 'text' },
  },
  async authorize(credentials) {
    const res = await fetch(`${process.env.BACKEND_URL}/api/auth/google-one-tap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: credentials.credential }),
    });

    if (!res.ok) return null;

    const user = await res.json();
    return user;
  }
})
```

---

### POST /api/auth/google-oauth

Verifies a Google ID token from the standard Google OAuth flow and creates/updates the user. Called server-side from the NextAuth `jwt()` callback on first Google OAuth sign-in (`account.id_token` is the Google ID token that Auth.js receives as part of the OAuth token exchange).

This endpoint ensures Google OAuth users are created in the backend database at sign-in time (not lazily). Functionally identical to `/google-one-tap` but kept separate for logging and analytics clarity.

**Authentication:** Not required (public endpoint)

**Rate Limiting:** IP-based rate limiting to prevent abuse

**Request Body:**
```json
{
  "idToken": "string"  // account.id_token from Auth.js Google OAuth response
}
```

**Response (200 OK):**
```json
{
  "userId": "user-uuid",
  "email": "user@example.com",
  "name": "John Doe",
  "username": "johndoe",
  "imageUrl": "https://lh3.googleusercontent.com/abc123/photo.jpg",
  "isNewUser": false,
  "isAdmin": false,
  "sessionId": "session-uuid"
}
```

**Error Responses:**
- `400 Bad Request`: ID token is required
- `401 Unauthorized`: Token verification failed or invalid payload
- `429 Too Many Requests`: Rate limit exceeded
- `500 Internal Server Error`: Server error

**Note:** This is a server-to-server call (Next.js `jwt()` callback → backend). The Google ID token acts as the authentication credential; no additional auth header is required. Rate limiting is applied per the source IP.

**NextAuth Integration:**
```typescript
// Backend jwt() callback usage
if (account.provider === 'google' && account.id_token) {
  const res = await fetch(`${API_BASE_URL}/auth/google-oauth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: account.id_token }),
  });
  const backendUser = await res.json();
  token.userId = backendUser.userId;
  token.username = backendUser.username;
  token.isNewUser = backendUser.isNewUser;
}
```

---

## Mobile Bearer Tokens

Native Flutter clients authenticate with short-lived HS256 access JWTs and rotating opaque refresh secrets against the same identity store as the cookie path (dual credential). Access tokens are verified by `bearerAuthMiddleware` on `/api/*` before cookie verification; protected routes that use `requireAuth` accept either face.

**Access JWT claims:** `sub` (userId), `sid` (sessionId), `tv` (tokenVersion), `iss=twistloom-backend`, `aud` (`MOBILE_ACCESS_AUD`, default `reader`), `exp`, `iat`. Header: `alg=HS256`, `kid=m0-hs256`.

**Refresh secrets:** 256-bit opaque hex, stored as SHA-256 hash in `refresh_families`. Rotation is mandatory on every refresh; reuse of an already-used secret revokes the entire family (EQ3=B default).

**Environment variables:** `MOBILE_ACCESS_SECRET` (≥32 chars, separate from `AUTH_SECRET`), optional `MOBILE_ACCESS_SECRET_PREVIOUS` (dual-secret rotation window), `MOBILE_ACCESS_TTL_MINUTES` (default 15), `MOBILE_REFRESH_TTL_DAYS` (default 30), `MOBILE_ACCESS_AUD` (default `reader`).

---

### POST /api/auth/mobile/token

Exchanges email/username + password for a mobile access JWT and a rotating refresh secret. Creates a device session (`auth_sessions`) and a new refresh family.

**Authentication:** Not required (public endpoint)

**Rate Limiting:** Upstash Redis — 10 requests / 60s per IP (`auth-mobile-token:${ip}`). Fails open if Redis is unavailable.

**Request Body:**
```json
{
  "emailOrUsername": "string", // Email or username
  "password": "string"         // Plaintext password
}
```

**Response (200 OK):**
```json
{
  "accessToken": "eyJhbGciOi...",
  "expiresIn": 900,
  "refreshToken": "a1b2c3...",
  "tokenType": "Bearer",
  "familyId": "family-uuid",
  "user": {
    "userId": "user-uuid",
    "email": "user@example.com",
    "name": "John Doe",
    "username": "johndoe",
    "imageUrl": "https://ik.imagekit.io/abc123/profile.jpg",
    "isNewUser": false,
    "isAdmin": false,
    "sessionId": "session-uuid"
  }
}
```

`expiresIn` is in seconds (from `MOBILE_ACCESS_TTL_MINUTES`). Store `refreshToken` securely; it is never returned again.

**Error Responses:**
- `400 Bad Request`: Email/username and password are required
  ```json
  { "success": false, "error": "Email/username and password are required" }
  ```
- `401 Unauthorized`: Invalid credentials or account uses OAuth
  ```json
  { "success": false, "error": "Invalid credentials" }
  ```
- `403 Forbidden`: Account is banned (checked before any session/family write)
  ```json
  { "success": false, "error": "Account banned" }
  ```
- `429 Too Many Requests`: Account locked or IP rate limit exceeded
  ```json
  {
    "error": "Account locked. Try again in 5 minutes.",
    "lockedUntil": "2023-01-01T12:05:00.000Z"
  }
  ```
- `500 Internal Server Error`: Server error

**Security Features:**
- Redis-backed IP rate limiting (serverless-safe, AGENTS.md §3.9.C)
- Same account lockout thresholds as `verify-credentials` (5→15→60 minutes)
- Bcrypt password verification (12 salt rounds)
- **Ban check before any write** — banned users get `403 Account banned` (no session/family row is created)
- **Atomic session + family creation** — `createSession` + `createRefreshFamily` share one `dbWrite.transaction`
- Revokes outstanding password-reset tokens on successful login
- Audit event: `auth_mobile_token_issued`

**Database Operations:**
1. Looks up user + verifies password; rejects banned users (`bannedAt`) with 403
2. In one transaction: creates `auth_sessions` row, re-reads live `tokenVersion`, issues access JWT, creates `refresh_families` row
3. Resolves admin status for `user.isAdmin`

---

### POST /api/auth/mobile/refresh

Rotates an opaque refresh secret (RFC 9700) and returns a new access JWT. Reuse of an already-used secret revokes the entire family.

**Authentication:** Not required (public endpoint — the refresh secret is the credential)

**Rate Limiting:** Upstash Redis — 30 requests / 60s per IP (`auth-mobile-refresh:${ip}`). Fails open if Redis is unavailable.

**Request Body:**
```json
{
  "refreshToken": "string"  // Opaque refresh secret from /mobile/token or prior refresh
}
```

**Response (200 OK):**
```json
{
  "accessToken": "eyJhbGciOi...",
  "expiresIn": 900,
  "refreshToken": "c3d4e5...",
  "tokenType": "Bearer"
}
```

The `refreshToken` is rotated — the previous secret is invalid immediately. Client must replace the stored secret.

**Error Responses:**
- `400 Bad Request`: refreshToken is required
  ```json
  { "success": false, "error": "refreshToken is required" }
  ```
- `401 Unauthorized`: Refresh token invalid (missing / revoked / reused / expired family / user banned)
  ```json
  { "success": false, "error": "Refresh token invalid (reuse_detected)" }
  ```
  Banned users fail closed inside `evaluateRotation` with `reason: "banned"` — the family is revoked and rotation is refused (never returns a fresh pair for a banned account).
- `429 Too Many Requests`: IP rate limit or family-keyed secondary rate limit exceeded
- **Redis-backed rate limiting** (serverless-safe, AGENTS.md §3.9.C): keyed by **IP** and by **refresh family id** (presented-hash bucket when the token maps to no family)
- `500 Internal Server Error`: Server error

**Reuse Detection (EQ3=B):** Presenting an already-used refresh secret marks the entire family revoked. All access tokens bound to that family's `tokenVersion` + session become unusable; the user must re-authenticate via `/mobile/token`.

**Security Features:**
- Redis-backed rate limiting (IP + family-id)
- Mandatory rotation on every refresh
- Family-level revocation on reuse (anti-theft)
- **Ban fail-closed:** `evaluateRotation` rejects + revokes when `bannedAt` is set
- Binds new access JWT to the family's `userId`, `sessionId`, `tokenVersion`
- Audit event: `auth_mobile_token_refreshed`

**Database Operations:**
1. Hashes presented secret, looks up `refresh_families` by current `refreshHash` **or** membership in `usedHashes`; loads live `tokenVersion` + `bannedAt`
2. Banned → revoke family + 401; presented hash only in `usedHashes` (already rotated) → reuse → revokes family → returns 401
3. Rotates secret (appends presented hash to `usedHashes`, writes new current hash + expiry)
4. Issues new access JWT from family's stored claims

---

## Session Management

### GET /api/auth/sessions

Gets all active sessions for the authenticated user. Returns session information including device details, last activity, and creation time.

**Authentication:** Required (`requireAuth` — NextAuth JWT cookie **or** `Authorization: Bearer <access-token>`)

**Rate Limiting:** None (authenticated endpoint)

**Request Headers (cookie face):**
```
Cookie: next-auth.session-token=...
```

**Request Headers (bearer face):**
```
Authorization: Bearer eyJhbGciOi...
```

**Response (200 OK):**
```json
{
  "sessions": [
    {
      "id": "session-uuid",
      "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0",
      "ipAddress": "192.168.1.1",
      "deviceName": "Chrome on Windows (Desktop)",
      "isCurrent": true,
      "lastActiveAt": "2023-01-01T12:00:00.000Z",
      "createdAt": "2023-01-01T10:00:00.000Z"
    }
  ],
  "count": 1
}
```

The `isCurrent` field indicates whether the session is the one associated with the current request's JWT. Exactly one session in the response has `isCurrent: true`.

**Error Responses:**
- `401 Unauthorized`: Invalid or missing authentication token
- `500 Internal Server Error`: Server error

**Security Features:**
- Requires authentication via `requireAuth` middleware
- Returns only sessions belonging to the authenticated user
- Uses LRU cache for session verification (reduces database queries)

**Database Operations:**
1. Queries `auth_sessions` table for user's sessions
2. Orders by `lastActiveAt` descending (most recent first)
3. Returns session metadata (device name, IP, user agent)

---

### DELETE /api/auth/sessions/:id

Revokes a specific session by ID, logging out that device. Prevents deleting the current session.

**Authentication:** Required (`requireAuth` — NextAuth JWT cookie **or** `Authorization: Bearer <access-token>`)

**Rate Limiting:** None (authenticated endpoint)

**Request Headers (cookie face):**
```
Cookie: next-auth.session-token=...
```

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | UUID | Session ID to revoke |

**Response (204 No Content):** No body returned on success.

**Error Responses:**
- `400 Bad Request`: Session ID is required (should not occur with proper routing)
- `401 Unauthorized`: Invalid or missing authentication token
- `403 Forbidden`: Cannot delete the current session
  ```json
  { "success": false, "error": "Cannot delete current session" }
  ```
- `404 Not Found`: Session not found or doesn't belong to user
  ```json
  { "success": false, "error": "Session not found" }
  ```
- `500 Internal Server Error`: Server error

**Security Features:**
- Requires authentication via `requireAuth` middleware
- Only allows deleting sessions belonging to the authenticated user
- Prevents deletion of the caller's own current session (403 Forbidden)
- Invalidates LRU cache entry for deleted session

**Database Operations:**
1. Verifies the session exists and belongs to the authenticated user
2. Checks that the session is not the current one
3. Deletes session from `auth_sessions` table
4. Invalidates cache entry for deleted session
5. Deletes any `refresh_families` rows bound to that session (mobile face)

---

### POST /api/auth/logout-all

Logs out from all **other** devices, excluding the current session. The current device stays signed in. Deletes the other session rows; their `refresh_families` are removed via `ON DELETE CASCADE`, with a defensive soft-revoke pass for any orphans (no hard `DELETE` on `refresh_families`).

**Authentication:** Required (`requireAuth` — NextAuth JWT cookie **or** `Authorization: Bearer <access-token>`)

**Rate Limiting:** None (authenticated endpoint)

**Request Headers (cookie face):**
```
Cookie: next-auth.session-token=...
```

**Request Body:** None (uses current session ID from JWT token / bearer `sid` claim)

**Response (200 OK):**
```json
{
  "message": "Logged out from 2 other device(s)",
  "deletedCount": 2
}
```

**Error Responses:**
- `400 Bad Request`: No session ID found in JWT token
  ```json
  { "error": "No session ID found" }
  ```
- `401 Unauthorized`: Invalid or missing authentication token
- `500 Internal Server Error`: Server error

**Security Features:**
- Requires authentication via `requireAuth` middleware
- Excludes current session from deletion (user stays logged in)
- Only affects sessions belonging to the authenticated user
- Invalidates LRU cache entries for deleted sessions
- Session delete cascades their `refresh_families`; defensive soft-revoke (`revokedAt`) for orphans (non-blocking on failure)

**Database Operations:**
1. Extracts current session ID from JWT token / bearer claim
2. Deletes all sessions for user except current session (cascade removes their families)
3. Soft-revokes any remaining families where `sessionId != current` (defensive; non-critical)
4. Invalidates cache entries for deleted sessions
5. Audit event: `security_logout_all_devices`

---

### POST /api/auth/logout-all-devices

Logs out from **all** devices including the current one. In **one transaction** (`logoutFromAllDevices`): deletes every session for the user and increments `tokenVersion` on the user record, invalidating all existing JWTs and forcing re-login everywhere. Session deletes hard-delete every bound `refresh_families` row via `ON DELETE CASCADE` (no separate family soft-revoke — a post-delete `revokedAt` update would match zero rows; no hard `DELETE` on `refresh_families` either).

**Authentication:** Required (`requireAuth` — NextAuth JWT cookie **or** `Authorization: Bearer <access-token>`)

**Rate Limiting:** None (authenticated endpoint)

**Request Headers (cookie face):**
```
Cookie: next-auth.session-token=...
```

**Request Body:** None

**Response (200 OK):**
```json
{
  "message": "Logged out from 3 device(s) — all sessions revoked",
  "deletedCount": 3
}
```

**Error Responses:**
- `401 Unauthorized`: Invalid or missing authentication token
- `500 Internal Server Error`: Server error

**Security Features:**
- Requires authentication via `requireAuth` middleware
- Deletes ALL sessions belonging to the authenticated user
- Session deletes cascade-remove ALL bound `refresh_families` rows (`ON DELETE CASCADE`); no separate family soft-revoke on this path
- Increments `tokenVersion` to invalidate all existing JWTs
- Invalidates LRU cache entries for all deleted sessions
- Audit event: `security_logout_all_devices`

**Database Operations:**
1. Fetches all session IDs for the user (for cache invalidation)
2. Deletes all sessions from `auth_sessions` table (cascade hard-deletes all bound families)
3. Increments `users.tokenVersion` to revoke all existing JWTs
4. Invalidates cache entries for all deleted sessions
5. Audit event: `security_logout_all_devices`

---

### POST /api/auth/logout-session

Logs out from a specific session by session ID. Allows selective logout of individual devices. Also revokes refresh families bound to that session (mobile face).

**Authentication:** Required (`requireAuth` — NextAuth JWT cookie **or** `Authorization: Bearer <access-token>`)

**Rate Limiting:** None (authenticated endpoint)

**Request Headers (cookie face):**
```
Cookie: next-auth.session-token=...
Content-Type: application/json
```

**Request Body:**
```json
{
  "sessionId": "session-uuid"  // The session ID to delete
}
```

**Response (200 OK):**
```json
{
  "message": "Logged out from device",
  "deletedCount": 1
}
```

**Error Responses:**
- `400 Bad Request`: sessionId is required
  ```json
  { "error": "sessionId is required" }
  ```
- `401 Unauthorized`: Invalid or missing authentication token
- `404 Not Found`: Session not found or doesn't belong to user
  ```json
  { "error": "Session not found" }
  ```
- `500 Internal Server Error`: Server error

**Security Features:**
- Requires authentication via `requireAuth` middleware
- Only allows deleting sessions belonging to the authenticated user
- Prevents deletion of other users' sessions
- Invalidates LRU cache entry for deleted session
- Revokes `refresh_families` rows bound to the deleted session (non-blocking on failure)

**Database Operations:**
1. Deletes session from `auth_sessions` table where id and userId match
2. Deletes `refresh_families` rows for that `sessionId` via `ON DELETE CASCADE` (plus a defensive soft-revoke pass; non-blocking on failure)
3. Invalidates cache entry for deleted session

---

### POST /api/auth/logout

Logs out the current session. When a session is bound to the request (cookie or bearer), **deletes the `auth_sessions` row** (cascade removes its `refresh_families`), soft-revokes families first as a belt-and-suspenders pass, and **immediately invalidates the 15s bearer identity cache** for any presented `Authorization: Bearer` token.

**Authentication:** Not required (public endpoint — session face is optional; if present, its session row + refresh families are revoked)

**Request Body:** None

**Response (200 OK):** Byte-identical cookie-path body on **every** path, including catch/error (NB-4 non-breaking guarantee):
```json
{
  "message": "Logged out successfully"
}
```

**Error Responses:**
- None observable — revocation failures are swallowed and the fixed 200 body is still returned (logout must not be an oracle for token validity)

**Behavior:**
1. Clears the session-verify LRU cache entry for the current request
2. If `Authorization: Bearer` was presented, calls `invalidateBearerCache(extractBearerToken(...))` so a warm 15s identity entry cannot outlive logout
3. If `sessionId` + `userId` are present (cookie or bearer face): soft-revokes all `refresh_families` bound to that session, then hard-deletes the session row (`logoutFromSpecificDevice`); `ON DELETE CASCADE` removes any remaining families
4. Returns the fixed `{ "message": "Logged out successfully" }` body (success **and** catch path)

**Note:** NextAuth still handles frontend cookie clearing via `signOut()`. This endpoint is the backend revocation (session row + families + bearer cache) for both faces.

**Frontend Usage (Primary Method):**
```javascript
import { signOut } from 'next-auth/react';
await signOut({ callbackUrl: '/' });
```

**Backend / Mobile Usage:**
```bash
# Cookie face
curl -X POST http://localhost:3000/api/auth/logout

# Bearer face
curl -X POST http://localhost:3000/api/auth/logout \
  -H "Authorization: Bearer eyJhbGciOi..."
```

---

## Account Linking

### POST /api/auth/link/google

Links a Google account to the currently authenticated user. Verifies the Google ID token, ensures the Google account isn't already linked to a different user, and inserts a provider record.

**Authentication:** Required (`requireAuth` — NextAuth JWT cookie **or** `Authorization: Bearer <access-token>`)

**Rate Limiting:** None (authenticated endpoint)

**Request Body:**
```json
{
  "idToken": "string"  // Google ID token from GIS
}
```

**Response (200 OK):**
```json
{
  "message": "Google account linked",
  "linkedMethods": ["credentials", "google"]
}
```

**Error Responses:**
- `400 Bad Request`: Missing ID token
- `401 Unauthorized`: Token verification failed
- `409 Conflict`: Google account already linked to another user
  ```json
  { "error": "This Google account is already linked to another user" }
  ```
- `500 Internal Server Error`: Server error

**Logic:**
1. Verifies Google ID token via `googleClient.verifyIdToken()`
2. Extracts `sub` from verified token payload
3. Checks `sub` not already linked to a different user
4. Inserts `(user_id, 'google', sub)` into `user_providers`

---

### POST /api/auth/unlink/google

Unlinks Google from the current user. Requires at least one other auth method (credentials) to remain linked.

**Authentication:** Required (`requireAuth` — NextAuth JWT cookie **or** `Authorization: Bearer <access-token>`)

**Rate Limiting:** None (authenticated endpoint)

**Request Body:** None

**Response (200 OK):**
```json
{
  "message": "Google account unlinked",
  "linkedMethods": ["credentials"]
}
```

**Error Responses:**
- `400 Bad Request`: Cannot remove last sign-in method
  ```json
  { "error": "Cannot remove last sign-in method" }
  ```
- `500 Internal Server Error`: Server error

**Logic:**
1. Checks user has >1 provider in `user_providers`
2. Deletes `user_providers` row where provider = 'google'
3. Returns remaining methods

---

### POST /api/auth/link/credentials

Sets a password for the currently authenticated user, linking the credentials (email/password) auth method. Uses the user's existing email.

**Authentication:** Required (`requireAuth` — NextAuth JWT cookie **or** `Authorization: Bearer <access-token>`)

**Rate Limiting:** None (authenticated endpoint)

**Request Body:**
```json
{
  "password": "NewP@ss123!"
}
```

**Password Requirements:** Same as signup endpoint (8+ chars, mixed case, number, special char)

**Response (200 OK):**
```json
{
  "message": "Password set, credentials method linked",
  "linkedMethods": ["google", "credentials"]
}
```

**Error Responses:**
- `400 Bad Request`: Missing password
- `409 Conflict`: Credentials already linked (password_hash already set)
  ```json
  { "error": "Credentials method already linked" }
  ```
- `422 Unprocessable Entity`: Weak password
  ```json
  {
    "error": "Password does not meet security requirements",
    "details": ["Password must be at least 8 characters long"]
  }
  ```
- `500 Internal Server Error`: Server error

**Logic:**
1. Validates password strength (same rules as signup)
2. Hashes password with bcrypt
3. Updates `users.password_hash` (does NOT change email)
4. Inserts `(user_id, 'credentials', null)` into `user_providers`

---

### POST /api/auth/unlink/credentials

Removes the password from the current user, unlinking the credentials auth method. Requires current password for verification and at least one other auth method (Google) to remain linked.

**Authentication:** Required (`requireAuth` — NextAuth JWT cookie **or** `Authorization: Bearer <access-token>`)

**Rate Limiting:** None (authenticated endpoint)

**Request Body:**
```json
{
  "currentPassword": "current-password"
}
```

**Response (200 OK):**
```json
{
  "message": "Credentials method unlinked",
  "linkedMethods": ["google"]
}
```

**Error Responses:**
- `400 Bad Request`: Cannot remove last sign-in method or missing password
- `401 Unauthorized`: Current password is incorrect or no password set
- `500 Internal Server Error`: Server error

**Logic:**
1. Verifies current password against stored bcrypt hash
2. Checks user has >1 provider in `user_providers`
3. Sets `users.password_hash = NULL`
4. Deletes `user_providers` row where provider = 'credentials'

---

## Account Management

### PUT /api/auth/email

Changes the authenticated user's email address. Requires current password verification. Resets email verification status — the new address is considered unverified until the user verifies it.

> **Note:** Email change is **blocked** if a Google account is linked to prevent OAuth matching breakage. User must unlink Google first.

**Authentication:** Required (`requireAuth` — NextAuth JWT cookie **or** `Authorization: Bearer <access-token>`)

**Rate Limiting:** IP-based rate limiting

**Request Body:**
```json
{
  "newEmail": "user@example.com",
  "currentPassword": "current-password"
}
```

**Response (200 OK):**
```json
{
  "message": "Email updated successfully"
}
```

**Error Responses:**
- `400 Bad Request`: Missing fields or invalid email format
- `401 Unauthorized`: Current password is incorrect, user not found, or OAuth-only account
- `403 Forbidden`: Cannot change email while Google account is linked
  ```json
  { "error": "Cannot change email while Google account is linked. Unlink Google first." }
  ```
- `409 Conflict`: New email already in use by another account
- `429 Too Many Requests`: Rate limit exceeded
- `500 Internal Server Error`: Server error

**Security Features:**
- Requires current password verification (prevents unauthorized email changes)
- Blocks email change when Google is linked (prevents OAuth matching breakage)
- Resets `email_verified` to null (new email must be verified)
- Basic email format validation
- Uniqueness check prevents account takeover via email squatting

**Database Operations:**
1. Fetches user's `passwordHash` from `users` table
2. Verifies `currentPassword` against stored bcrypt hash
3. Checks if Google account is linked (403 if true)
4. Checks `newEmail` uniqueness in `users` table (409 if taken)
5. Updates `users.email` and `user_auth.email_verified` (set to null)

---

### PUT /api/auth/password

Changes the authenticated user's password. Requires current password verification. Bumps `users.tokenVersion` and revokes all mobile refresh families in one transaction so outstanding bearer access + refresh tokens die with the password.

**Authentication:** Required (`requireAuth` — NextAuth JWT cookie **or** `Authorization: Bearer <access-token>`)

**Rate Limiting:** IP-based rate limiting

**Request Body:**
```json
{
  "currentPassword": "current-password",
  "newPassword": "NewP@ss123!"
}
```

**Password Requirements** (same as signup):
- Minimum 8 characters, maximum 128 characters
- At least one uppercase letter
- At least one lowercase letter
- At least one number
- At least one special character
- Cannot be a common password

**Response (200 OK):**
```json
{
  "message": "Password updated successfully"
}
```

**Error Responses:**
- `400 Bad Request`: Missing fields
  ```json
  { "success": false, "error": "Current password and new password are required" }
  ```
- `401 Unauthorized`: Current password is incorrect, user not found, or OAuth-only account
- `422 Unprocessable Entity`: New password does not meet security requirements
  ```json
  {
    "error": "Password does not meet security requirements",
    "details": ["Password must be at least 8 characters long"]
  }
  ```
- `429 Too Many Requests`: Rate limit exceeded
- `500 Internal Server Error`: Server error

**Behavior (single transaction):**
1. Verifies `currentPassword` against the stored bcrypt hash
2. Validates `newPassword` strength
3. Hashes `newPassword` with bcrypt (12 salt rounds)
4. Updates `users.password_hash` and increments `users.tokenVersion`
5. Revokes all `refresh_families` rows for the user (mobile face)
6. Resets `user_auth.failed_login_attempts` and `user_auth.lock_until`
7. Sends security notification email (non-blocking, outside transaction)
8. Audit event: `security_password_changed`

---

### PUT /api/auth/username

Changes the authenticated user's username.

**Authentication:** Required (`requireAuth` — NextAuth JWT cookie **or** `Authorization: Bearer <access-token>`)

**Rate Limiting:** IP-based rate limiting

**Request Body:**
```json
{
  "newUsername": "newusername"
}
```

**Username Rules** (same as signup):
- 3–30 characters
- Only lowercase letters (a-z), digits (0-9), and hyphens (-)
- No spaces or underscores
- Cannot start or end with a hyphen
- No consecutive hyphens (--)
- Not a reserved word (admin, support, etc.)

**Response (200 OK):**
```json
{
  "message": "Username updated successfully"
}
```

**Error Responses:**
- `400 Bad Request`: Missing username
- `409 Conflict`: Username already taken by another user
- `422 Unprocessable Entity`: Invalid username format
  ```json
  {
    "error": "Invalid username",
    "details": ["Username must be at least 3 characters long"]
  }
  ```
- `429 Too Many Requests`: Rate limit exceeded
- `500 Internal Server Error`: Server error

**Behavior:**
1. Validates `newUsername` format using `validateUsername()`
2. Checks uniqueness in `users` table (excludes current user)
3. Updates `users.username`

---

## Security Architecture

### Database Schema

**users table:** Stores user profile information
- `userId` (UUID, primary key)
- `email`, `username` (unique)
- `passwordHash` (bcrypt, nullable for OAuth-only users)
- `tokenVersion` (integer, default 0) — Session version for JWT revocation
- Profile fields: `name`, `gender`, `bio`, `imageUrl`, etc.

**user_auth table:** Stores authentication state (separated for GDPR compliance)
- `userId` (UUID, primary key, references users.userId → CASCADE)
- `failedLoginAttempts` (integer, default 0)
- `lockUntil` (timestamp, nullable)
- `passwordResetToken` (text, unique, nullable)
- `passwordResetExpires` (timestamp, nullable)
- `emailVerified` (timestamp, nullable)
- `emailVerificationToken` (text, unique, nullable)
- `emailVerificationExpires` (timestamp, nullable)

**auth_sessions table:** Stores active device sessions for selective logout
- `id` (UUID, primary key) — Unique session ID embedded in JWT / bearer `sid` claim
- `userId` (UUID, references users.userId → CASCADE)
- `userAgent` (text, nullable) — User agent string
- `ipAddress` (text, nullable) — IP address
- `deviceName` (text, nullable) — Derived device name (e.g. "Chrome on Windows")
- `lastActiveAt` (timestamp, default now) — Last activity timestamp
- `createdAt` (timestamp, default now) — Session creation time
- `updatedAt` (timestamp, default now) — Last update time

**refresh_families table:** Stores rotating mobile refresh secrets (native bearer face)
- `id` (UUID, primary key) — Family ID returned by `/mobile/token`
- `userId` (UUID, references users.userId → CASCADE)
- `sessionId` (UUID, references auth_sessions.id → CASCADE) — Bound device session
- `refreshHash` (text, unique) — SHA-256 of the **current** opaque refresh secret
- `usedHashes` (text[], GIN-indexed) — SHA-256 of every secret already rotated away from this family; presenting any of these revokes the family (RFC 9700 theft signal)
- `tokenVersion` (integer) — Snapshot of `users.tokenVersion` at family creation
- `expiresAt` (timestamp) — Family lifetime (`MOBILE_REFRESH_TTL_DAYS`, default 30 days)
- `usedAt` (timestamp, nullable) — Last rotation time (audit only; reuse detection uses `usedHashes`)
- `revokedAt` (timestamp, nullable) — Family revoked (logout / password change / reuse)
- `createdAt` (timestamp, default now) — Family creation time

**user_providers table:** Stores linked auth providers per user (account linking)
- `userId` (UUID, PK, references users.userId → CASCADE)
- `provider` (text, PK) — `'credentials'` | `'google'`
- `providerAccountId` (text, nullable) — Google `sub` (null for credentials)
- `createdAt` (timestamp, default now) — When the provider was linked

**Indexes:**
- `auth_sessions_user_idx` on `userId` for user session queries
- `auth_sessions_id_idx` on `id` for session ID lookups (JWT verification)
- `auth_sessions_last_active_idx` on `lastActiveAt` for cleanup of inactive sessions
- `user_providers_user_idx` on `userId` for user provider lookups
- `user_providers_account_unique` unique index on `(provider, provider_account_id)` to prevent duplicate Google linking
- `refresh_families_hash_uq` unique index on `refreshHash` for O(1) current-token rotation lookup
- `refresh_families_used_hashes_gin` GIN index on `usedHashes` for reuse detection (`used_hashes @> ARRAY[$1]`)
- `refresh_families_user_idx` on `userId` for bulk family revocation (logout-all, password change)
- `refresh_families_session_idx` on `sessionId` for session-scoped family revocation

> **Migration note:** `refresh_families` migration **applied** (`drizzle/0099_wealthy_gamma_corps.sql`, confirmed by owner 2026-09-23). Schema remains authoritative in `src/db/schema.ts`; future schema edits still require manual `bun db:generate` / `bun db:migrate` (AGENTS.md §3.5).

### Security Features

**Password Security:**
- Bcrypt with 12 salt rounds
- Password strength validation (8+ chars, mixed case, numbers, special chars)
- Common password pattern detection

**Account Protection:**
- Exponential backoff lockout (5→15→60 minutes)
- IP-based rate limiting for public endpoints
- Email enumeration prevention (always returns success for auth flows)

**Token Security:**
- Random UUID tokens
- Password reset tokens: 1 hour expiry
- Email verification tokens: 24 hour expiry
- Single-use tokens (revoked after use)

**Session Security:**
- Per-device session tracking via `auth_sessions` table
- Session ID embedded in JWT (cookie) / bearer `sid` claim for verification
- LRU cache for session existence checks (reduces DB load)
- Selective session revocation (logout single device or all devices)
- `tokenVersion` mechanism for bulk JWT revocation (cookie + bearer)
- Mobile refresh families: rotating opaque secrets, SHA-256 stored, family-level revocation on reuse
- Password change / reset bump `tokenVersion` + soft-revoke all `refresh_families` in one transaction; logout-all-devices bumps `tokenVersion` + deletes all sessions (cascade removes families) in one transaction

**Bearer Token Security:**
- HS256 access JWT signed with `MOBILE_ACCESS_SECRET` (≥32 chars, separate from `AUTH_SECRET`)
- Dual-secret rotation via `MOBILE_ACCESS_SECRET_PREVIOUS` (zero-downtime key rotation)
- Short access TTL (default 15 minutes); refresh is opaque + rotated every use
- Claims: `sub`, `sid`, `tv`, `iss=twistloom-backend`, `aud`, `exp`, `iat`; header `kid=m0-hs256`
- Reuse detection revokes the entire refresh family (EQ3=B default)
- `/api/cron/*` service-bearer path (`CRON_SECRET`) exempted from user-JWT branch

**Email Security:**
- Resend email service integration
- HTML email templates
- Secure token-based verification
- Temporary/disposable email addresses blocked at signup

### Rate Limiting

Public endpoints implement IP-based rate limiting to prevent:
- Brute force attacks (login attempts)
- Email spam (forgot password, resend verification)
- Account creation abuse (signup)

**Implementation tiers:**
- **In-memory LRU** (`checkRateLimitByIP`): used by cookie-path credential/signup/reset flows for per-process throttling
- **Upstash Redis** (`checkRateLimit`): used by mobile token/refresh endpoints (`auth-mobile-token:${ip}` 10/60s, `auth-mobile-refresh:${ip}` 30/60s) — serverless-safe atomic counters, fail-open when Redis is unavailable (AGENTS.md §3.9.C)

---

## Environment Variables

### Required for Email Functionality

```bash
# Email Service (Resend)
RESEND_API_KEY=re_xxxxxxxxxxxxxx
RESEND_FROM_EMAIL=noreply@twistloom.com

# Frontend URL (for email links)
FRONTEND_URL=https://twistloom.vercel.app
```

### Required for Google Auth

```bash
GOOGLE_CLIENT_ID=xxxxxxxxxxxx-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.apps.googleusercontent.com
```

### Required for Mobile Bearer Tokens

```bash
# Separate from AUTH_SECRET (cookie JWE material). Min 32 chars.
# Generate: openssl rand -base64 32
MOBILE_ACCESS_SECRET=your_mobile_access_secret_here

# Optional dual-secret rotation window (old key still verifies during rollout)
# MOBILE_ACCESS_SECRET_PREVIOUS=

# Access TTL minutes (default 15)
MOBILE_ACCESS_TTL_MINUTES=15

# Refresh family lifetime days (default 30)
MOBILE_REFRESH_TTL_DAYS=30

# Provisional audience until parent Q6 / Step 12 enforces pen audiences
MOBILE_ACCESS_AUD=reader
```

### Optional Feature Flags

```bash
# Enable/disable specific security features
FEATURE_PASSWORD_VALIDATION=true
FEATURE_ACCOUNT_LOCKOUT=true
FEATURE_PASSWORD_RESET=true
FEATURE_EMAIL_VERIFICATION=true
```

---

## Error Handling

All endpoints follow a consistent error response format via the Hono `c*` helpers (`cApiError`, `cValidationError`, `cUnauthorizedError`, `cNotFoundError`, `cForbiddenError`, `cRateLimitError`, `cConflictError` in `src/utils/error.ts`):

```json
{
  "success": false,
  "error": "Error message describing the issue"
}
```

**Envelope variants (by helper / path):**
- `c*` helpers (most 4xx/5xx): `{ "success": false, "error": "..." }`
- Some route-specific 4xx (validation details, lockout, rate limit): `{ "error": "..." }` (no `success` field)
- Lockout (`429`): `{ "error": "Account locked...", "lockedUntil": "ISO-8601" }`
- Validation details (`422`): `{ "error": "Password does not meet security requirements", "details": ["..."] }`
- Cookie logout success (`200`): `{ "message": "Logged out successfully" }` (byte-identical, NB-4)

In development (`IS_DEVELOPMENT`), `cApiError` may include a `details` field with the serialized underlying error for debugging.

For validation errors with multiple issues:
```json
{
  "success": false,
  "error": "Invalid username",
  "details": ["Username must be at least 3 characters long"]
}
```

For account lockout errors:
```json
{
  "error": "Account locked. Try again in 5 minutes.",
  "lockedUntil": "2023-01-01T12:05:00.000Z"
}
```

---

## Integration with NextAuth

### Credentials Provider Configuration

The `/api/auth/verify-credentials` endpoint is designed to work with the NextAuth Credentials provider:

```typescript
// NextAuth configuration
credentials: {
  async authorize(credentials) {
    const res = await fetch(`${process.env.BACKEND_URL}/api/auth/verify-credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        emailOrUsername: credentials.email,
        password: credentials.password,
      }),
    });

    if (!res.ok) return null;

    const user = await res.json();
    return user;
  }
}
```

### Google One Tap Provider Configuration

The `/api/auth/google-one-tap` endpoint is used by the `googleonetap` Credentials provider:

```typescript
// NextAuth configuration
Credentials({
  id: 'googleonetap',
  name: 'Google One Tap',
  credentials: {
    credential: { label: 'Credential', type: 'text' },
  },
  async authorize(credentials) {
    const res = await fetch(`${process.env.BACKEND_URL}/api/auth/google-one-tap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: credentials.credential }),
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user;
  }
})
```

### Google OAuth / jwt() Callback Flow

The `/api/auth/google-oauth` endpoint is called server-to-server from the NextAuth `jwt()` callback on first sign-in:

```typescript
// NextAuth jwt() callback
async jwt({ token, account }) {
  if (account?.provider === 'google' && account.id_token) {
    const res = await fetch(`${API_BASE_URL}/auth/google-oauth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: account.id_token }),
    });
    const backendUser = await res.json();
    token.userId = backendUser.userId;
    token.username = backendUser.username;
    token.isNewUser = backendUser.isNewUser;
  }
  return token;
}
```

### Session Management

NextAuth handles (web / cookie face):
- Session cookie creation and validation
- JWT token generation and verification
- Session refresh and expiration
- Google OAuth integration

Backend handles:
- Credential verification
- User data management
- Password and email operations
- Device session tracking and revocation
- Mobile bearer token issue / refresh / revocation (`/mobile/token`, `/mobile/refresh`, `refresh_families`)

### Mobile Bearer Integration (Flutter)

```bash
# 1. Exchange credentials for tokens
curl -X POST http://localhost:3000/api/auth/mobile/token \
  -H "Content-Type: application/json" \
  -d '{ "emailOrUsername": "user@example.com", "password": "SecurePass123!" }'

# 2. Call a protected endpoint with the access token
curl http://localhost:3000/api/auth/sessions \
  -H "Authorization: Bearer eyJhbGciOi..."

# 3. Refresh before expiry (access TTL defaults to 15 min)
curl -X POST http://localhost:3000/api/auth/mobile/refresh \
  -H "Content-Type: application/json" \
  -d '{ "refreshToken": "previous-opaque-secret" }'
```

---

## Testing Examples

### Complete Signup Flow

```bash
# 1. Sign up
curl -X POST http://localhost:3000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "username": "testuser",
    "gender": "male",
    "password": "TestPass123!",
    "agreedToTerms": true
  }'

# 2. Verify email (using token from email)
curl -X POST http://localhost:3000/api/auth/verify-email \
  -H "Content-Type: application/json" \
  -d '{
    "token": "verification-token-from-email"
  }'

# 3. Login via NextAuth (frontend)
# NextAuth calls /api/auth/verify-credentials

# — or native mobile —
# 3b. Exchange credentials for bearer tokens
curl -X POST http://localhost:3000/api/auth/mobile/token \
  -H "Content-Type: application/json" \
  -d '{ "emailOrUsername": "test@example.com", "password": "TestPass123!" }'
```

### Password Reset Flow

```bash
# 1. Request password reset
curl -X POST http://localhost:3000/api/auth/forgot-password \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com"
  }'

# 2. Reset password using token from email
curl -X POST http://localhost:3000/api/auth/reset-password \
  -H "Content-Type: application/json" \
  -d '{
    "token": "reset-token-from-email",
    "password": "NewTestPass123!"
  }'

# 3. Login with new password
# NextAuth calls /api/auth/verify-credentials
```

### Session Management Flow

```bash
# 1. Get active sessions (authenticated)
curl -X GET http://localhost:3000/api/auth/sessions \
  -H "Cookie: next-auth.session-token=..."

# 2. Delete a specific session by ID (non-current only)
curl -X DELETE http://localhost:3000/api/auth/sessions/session-uuid-to-remove \
  -H "Cookie: next-auth.session-token=..."

# 3. Logout from a specific device
curl -X POST http://localhost:3000/api/auth/logout-session \
  -H "Cookie: next-auth.session-token=..." \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "session-uuid-to-remove"
  }'

# 4. Logout from all OTHER devices (keep current)
curl -X POST http://localhost:3000/api/auth/logout-all \
  -H "Cookie: next-auth.session-token=..."

# 5. Logout from ALL devices (including current, forces re-login)
curl -X POST http://localhost:3000/api/auth/logout-all-devices \
  -H "Cookie: next-auth.session-token=..."
```

---

## GDPR Compliance

### Data Separation

The authentication system implements GDPR-friendly data separation:
- **users table:** Personal profile data (name, bio, gender, etc.)
- **user_auth table:** Authentication state (tokens, lockout, verification status)

This separation enables:
- Easier data export (can export auth data separately)
- Simplified data deletion (can delete auth records while preserving profile)
- Clearer access control (different permissions for profile vs auth data)
- Audit trail for authentication events

### Data Retention

- Password reset tokens: 1 hour
- Email verification tokens: 24 hours
- Account lockout records: Until unlocked or manually reset
- Failed login attempts: Reset on successful login
- Active sessions: Until explicitly logged out or user deleted
- Mobile access JWTs: `MOBILE_ACCESS_TTL_MINUTES` (default 15 minutes)
- Mobile refresh families: `MOBILE_REFRESH_TTL_DAYS` (default 30 days), revoked early on logout / password change / reuse

---

## Future Enhancements

Planned features for future phases (see AUTH_ENHANCEMENT_ROADMAP.md):

- **Phase 2:** Session management, audit logging, CSRF protection, input sanitization
- **Phase 3:** Two-factor authentication (2FA), OAuth account linking, device fingerprinting
- **Phase 4:** Passwordless authentication (magic links), OAuth state verification
- **Mobile (see NATIVE_MOBILE_BEARER_AUTH_ROADMAP.md):** Apple Sign In (parent Q5 gate), pen audiences (parent Q6 / Step 12), refresh recovery EQ3=A fast-follow, remaining roadmap Steps 9/11/12

---

## Support

For issues or questions about the Authentication API:
- Check the [AUTH_ENHANCEMENT_ROADMAP.md](../AUTH_ENHANCEMENT_ROADMAP.md) for planned features
- Review the [DUAL_AUTH_ARCHITECTURE.md](../architecture/DUAL_AUTH_ARCHITECTURE.md) for architecture details
- Review the [NATIVE_MOBILE_BEARER_AUTH_ROADMAP.md](../roadmap/NATIVE_MOBILE_BEARER_AUTH_ROADMAP.md) for mobile bearer status
- Consult the [BACKEND_AUTH_MIGRATION_GUIDE.md](../BACKEND_AUTH_MIGRATION_GUIDE.md) for integration guidance
