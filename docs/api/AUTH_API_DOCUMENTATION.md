# Authentication API Documentation

## Overview

The Authentication API provides endpoints for user registration, credential verification, Google OAuth, password management, email verification, and session management. This API works in conjunction with NextAuth v5 to provide a complete authentication solution supporting both Google OAuth and Email/Password authentication methods.

**Base URL:** `/api/auth`

**Authentication:** Most endpoints are public (no authentication required) for signup/login flows. Protected endpoints use NextAuth JWT cookies via the `requireAuth` middleware.

**Architecture:**
- NextAuth v5 handles session creation and cookie management
- Backend validates credentials and manages user data
- Email/Password and Google OAuth authentication methods supported

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
6. [Session Management](#session-management)
   - [Get Active Sessions](#get-apiauthsessions)
   - [Logout from Other Devices](#post-apiauthlogout-all)
   - [Logout from All Devices](#post-apiauthlogout-all-devices)
   - [Logout from Specific Session](#post-apiauthlogout-session)
   - [Logout](#post-apiauthlogout)

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
  "isNewUser": false
}
```

**Error Responses:**
- `400 Bad Request`: Email/username and password are required
- `401 Unauthorized`: Invalid credentials or account uses OAuth
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
  "gender": "string",          // Gender: male/female/other (required)
  "password": "string",        // Plaintext password (required)
  "receiveEmails": boolean,    // Email subscription preference (optional)
  "agreedToTerms": boolean,    // Terms agreement (required)
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
- `400 Bad Request`: Invalid input, weak password, or terms not agreed
  ```json
  {
    "error": "Password does not meet security requirements",
    "details": ["Password must be at least 8 characters long", "Password must contain at least one uppercase letter"]
  }
  ```
- `409 Conflict`: Email or username already exists
- `422 Unprocessable Entity`: Weak password, invalid username, or disposable email
- `429 Too Many Requests`: Rate limit exceeded
- `500 Internal Server Error`: Server error

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
  "message": "Password reset email sent if account exists"
}
```

**Error Responses:**
- `400 Bad Request`: Email is required
- `429 Too Many Requests`: Rate limit exceeded
- `500 Internal Server Error`: Server error

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

**Database Operations:**
1. Verifies token in `user_auth` table
2. Validates token expiry
3. Hashes new password with bcrypt
4. Updates `users.password_hash`
5. Clears reset token and lockout in `user_auth` table

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
  "message": "Verification email sent"
}
```

**Error Responses:**
- `400 Bad Request`: Email is required
- `429 Too Many Requests`: Rate limit exceeded
- `500 Internal Server Error`: Server error

**Security Features:**
- IP-based rate limiting
- Email enumeration prevention (always returns success for unknown/verified emails)
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
  "isNewUser": false
}
```

**Error Responses:**
- `400 Bad Request`: ID token is required
- `401 Unauthorized`: Token verification failed or invalid payload
- `429 Too Many Requests`: Rate limit exceeded
- `500 Internal Server Error`: Server error

**Security Features:**
- Verifies Google ID token signature and audience
- Extracts user info from verified token payload
- IP-based rate limiting to prevent abuse
- Uses Google OAuth2Client for token verification

**Database Operations:**
1. Verifies Google ID token signature and audience
2. Extracts user info (email, name, picture) from token
3. Creates or updates user account via `createOrUpdateOAuthUser()`
4. Fetches complete user data for NextAuth session

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
  "isNewUser": false
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

## Session Management

### GET /api/auth/sessions

Gets all active sessions for the authenticated user. Returns session information including device details, last activity, and creation time.

**Authentication:** Required (uses NextAuth JWT cookie via `requireAuth` middleware)

**Rate Limiting:** None (authenticated endpoint)

**Request Headers:**
```
Cookie: next-auth.session-token=...
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
      "lastActiveAt": "2023-01-01T12:00:00.000Z",
      "createdAt": "2023-01-01T10:00:00.000Z"
    }
  ],
  "count": 1
}
```

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

### POST /api/auth/logout-all

Logs out from all **other** devices, excluding the current session. The current device stays signed in.

**Authentication:** Required (uses NextAuth JWT cookie via `requireAuth` middleware)

**Rate Limiting:** None (authenticated endpoint)

**Request Headers:**
```
Cookie: next-auth.session-token=...
```

**Request Body:** None (uses current session ID from JWT token)

**Response (200 OK):**
```json
{
  "message": "Logged out from 2 other device(s)",
  "deletedCount": 2
}
```

**Error Responses:**
- `400 Bad Request`: No session ID found in JWT token
- `401 Unauthorized`: Invalid or missing authentication token
- `500 Internal Server Error`: Server error

**Security Features:**
- Requires authentication via `requireAuth` middleware
- Excludes current session from deletion (user stays logged in)
- Only affects sessions belonging to the authenticated user
- Invalidates LRU cache entries for deleted sessions

**Database Operations:**
1. Extracts current session ID from JWT token
2. Deletes all sessions for user except current session
3. Invalidates cache entries for deleted sessions

---

### POST /api/auth/logout-all-devices

Logs out from **all** devices including the current one. Deletes every session for the user and increments `tokenVersion` on the user record, invalidating all existing JWTs and forcing re-login everywhere.

**Authentication:** Required (uses NextAuth JWT cookie via `requireAuth` middleware)

**Rate Limiting:** None (authenticated endpoint)

**Request Headers:**
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
- Increments `tokenVersion` to invalidate all existing JWTs
- Invalidates LRU cache entries for all deleted sessions

**Database Operations:**
1. Fetches all session IDs for the user (for cache invalidation)
2. Deletes all sessions from `auth_sessions` table
3. Increments `users.tokenVersion` to revoke all existing JWTs
4. Invalidates cache entries for all deleted sessions

---

### POST /api/auth/logout-session

Logs out from a specific session by session ID. Allows selective logout of individual devices.

**Authentication:** Required (uses NextAuth JWT cookie via `requireAuth` middleware)

**Rate Limiting:** None (authenticated endpoint)

**Request Headers:**
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
- `401 Unauthorized`: Invalid or missing authentication token
- `404 Not Found`: Session not found or doesn't belong to user
- `500 Internal Server Error`: Server error

**Security Features:**
- Requires authentication via `requireAuth` middleware
- Only allows deleting sessions belonging to the authenticated user
- Prevents deletion of other users' sessions
- Invalidates LRU cache entry for deleted session

**Database Operations:**
1. Deletes session from `auth_sessions` table where id and userId match
2. Invalidates cache entry for deleted session

---

### POST /api/auth/logout

Placeholder for backend-side cleanup on logout. Session clearing is handled entirely by NextAuth on the frontend via `signOut()`.

**Authentication:** Not required (public endpoint, but typically called alongside frontend sign-out)

**Request Body:** None

**Response (200 OK):**
```json
{
  "message": "Logged out successfully"
}
```

**Error Responses:**
- `500 Internal Server Error`: Server error

**Note:** NextAuth handles the actual session clearing on the frontend via `signOut()`. This backend endpoint is provided for future extensibility such as:
- Invalidating refresh tokens (if implemented)
- Logging logout events for analytics
- Clearing server-side session data

**Frontend Usage (Primary Method):**
```javascript
import { signOut } from 'next-auth/react';
await signOut({ callbackUrl: '/' });
```

**Backend Usage (If Needed for Cleanup):**
```bash
curl -X POST http://localhost:3000/api/auth/logout
```

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
- `id` (UUID, primary key) — Unique session ID embedded in JWT
- `userId` (UUID, references users.userId → CASCADE)
- `userAgent` (text, nullable) — User agent string
- `ipAddress` (text, nullable) — IP address
- `deviceName` (text, nullable) — Derived device name (e.g. "Chrome on Windows")
- `lastActiveAt` (timestamp, default now) — Last activity timestamp
- `createdAt` (timestamp, default now) — Session creation time
- `updatedAt` (timestamp, default now) — Last update time

**Indexes:**
- `auth_sessions_user_idx` on `userId` for user session queries
- `auth_sessions_id_idx` on `id` for session ID lookups (JWT verification)
- `auth_sessions_last_active_idx` on `lastActiveAt` for cleanup of inactive sessions

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
- Session ID embedded in JWT for verification
- LRU cache for session existence checks (reduces DB load)
- Selective session revocation (logout single device or all devices)
- `tokenVersion` mechanism for bulk JWT revocation

**Email Security:**
- Resend email service integration
- HTML email templates
- Secure token-based verification
- Temporary/disposable email addresses blocked at signup

### Rate Limiting

All public endpoints implement IP-based rate limiting using an in-memory LRU cache to prevent:
- Brute force attacks (login attempts)
- Email spam (forgot password, resend verification)
- Account creation abuse (signup)

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

All endpoints follow a consistent error response format:

```json
{
  "error": "Error message describing the issue"
}
```

For validation errors with multiple issues:
```json
{
  "error": "Error message",
  "details": ["Specific error 1", "Specific error 2"]
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

NextAuth handles:
- Session cookie creation and validation
- JWT token generation and verification
- Session refresh and expiration
- Google OAuth integration

Backend handles:
- Credential verification
- User data management
- Password and email operations
- Device session tracking and revocation

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

# 2. Logout from a specific device
curl -X POST http://localhost:3000/api/auth/logout-session \
  -H "Cookie: next-auth.session-token=..." \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "session-uuid-to-remove"
  }'

# 3. Logout from all OTHER devices (keep current)
curl -X POST http://localhost:3000/api/auth/logout-all \
  -H "Cookie: next-auth.session-token=..."

# 4. Logout from ALL devices (including current, forces re-login)
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

---

## Future Enhancements

Planned features for future phases (see AUTH_ENHANCEMENT_ROADMAP.md):

- **Phase 2:** Session management, audit logging, CSRF protection, input sanitization
- **Phase 3:** Two-factor authentication (2FA), OAuth account linking, device fingerprinting
- **Phase 4:** Passwordless authentication (magic links), OAuth state verification

---

## Support

For issues or questions about the Authentication API:
- Check the [AUTH_ENHANCEMENT_ROADMAP.md](../AUTH_ENHANCEMENT_ROADMAP.md) for planned features
- Review the [DUAL_AUTH_ARCHITECTURE.md](../DUAL_AUTH_ARCHITECTURE.md) for architecture details
- Consult the [BACKEND_AUTH_MIGRATION_GUIDE.md](../BACKEND_AUTH_MIGRATION_GUIDE.md) for integration guidance
