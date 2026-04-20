# NextAuth v5 Dual Providers Architecture

## Overview

This document describes the dual authentication architecture for Twistloom, supporting both Google OAuth and Email/Password login using NextAuth v5.

## Architecture

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
│  requireAuth / optionalAuth - Middleware for routes         │
│  guest middleware - Handles unauthenticated users            │
└─────────────────────────────────────────────────────────────┘
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
   - Sets `req.userId` for authenticated requests
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
   - `req.userId` is not set (guest user flow applies)

**Optional backend cleanup (POST /api/auth/logout):**

The backend provides `POST /api/auth/logout` as an optional endpoint for:

- Future extensibility (refresh tokens, server-side sessions)
- Analytics logging (logout events)
- Cleanup operations (invalidate tokens, clear cache)

Currently this is a placeholder since NextAuth handles all session management client-side. If you implement refresh tokens or server-side sessions in the future, this endpoint would be called from the frontend after NextAuth's `signOut()`.

### Summary

- **Login:** NextAuth `signIn()` → Credentials provider → Backend `/verify-credentials` → Session cookie
- **Logout:** NextAuth `signOut()` → Clears cookie (backend optional for cleanup)
- **Session verification:** Backend middleware validates JWT cookie on every request
- **Both auth methods (Google + Email/Password)** create the same session cookie format

## Key Benefits

1. **Single Session Format**: Both auth methods create the same NextAuth session cookie
2. **Backend Simplicity**: Backend only needs to verify JWT cookies (already implemented)
3. **Security**: NextAuth handles CSRF, session management, and security best practices
4. **Flexibility**: Users can choose their preferred login method
5. **Guest Support**: Seamless guest user flow with data migration on login

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

**File: `src/routes/auth.ts`**

Endpoint for NextAuth Credentials provider:
```typescript
router.post('/verify-credentials', async (req, res) => {
  // Rate limiting (IP-based, 5 attempts/minute)
  const ip = req.ip || req.socket.remoteAddress || 'unknown'; // FIXED: Use socket.remoteAddress
  if (!checkRateLimitByIP(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  }

  const { emailOrUsername, password } = req.body;

  // Find user by email or username
  const user = await dbRead
    .select({ userId, email, username, name, image, passwordHash })
    .from(users)
    .where(or(eq(users.email, emailOrUsername), eq(users.username, emailOrUsername)))
    .limit(1);

  if (user.length === 0) { // FIXED: Removed redundant null check
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Check if user has password (OAuth-only users won't have passwordHash)
  if (!user[0].passwordHash) {
    return res.status(401).json({ error: 'This account uses OAuth login. Please sign in with Google.' });
  }

  // Verify password
  const isValid = await verifyPassword(password, user[0].passwordHash);
  if (!isValid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Return user data for NextAuth (exclude passwordHash)
  res.json({
    userId: user[0].userId,
    email: user[0].email,
    name: user[0].name,
    image: user[0].image,
  });
});
```

### 4. Rate Limiting

**File: `src/middleware/rate-limit.ts`**

Two rate limiting strategies:

1. **User-based (authenticated endpoints)**: Uses Upstash Redis, keyed by `req.userId`
2. **IP-based (unauthenticated endpoints)**: Uses LRU cache, keyed by IP address

```typescript
// For unauthenticated endpoints (login, signup, forgot-password)
export function checkRateLimitByIP(ip: string): boolean {
  // LRU cache with max 10,000 entries, 1 minute TTL
  // Configurable via environment variables
  // Returns false if rate limited
}
```

**Environment Variables (Optional):**
- `AUTH_RATE_LIMIT_MAX_ATTEMPTS`: Maximum attempts per window (default: 5)
- `AUTH_RATE_LIMIT_WINDOW_MS`: Time window in milliseconds (default: 60000 = 1 minute)

### 5. Route Registration

**File: `src/routes/index.ts`**

```typescript
import authRouter from "./auth.js";

router.use("/auth", authRouter);
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
AUTH_SECRET=your-secret-here (same as frontend)
FRONTEND_URL=http://localhost:3001
AUTH_URL=http://localhost:3001

# Auth Rate Limiting (Optional)
AUTH_RATE_LIMIT_MAX_ATTEMPTS=5
AUTH_RATE_LIMIT_WINDOW_MS=60000
```

## User Registration Flow

### Backend Signup Endpoint

**File: `src/routes/auth.ts`**

```typescript
router.post('/signup', async (req, res) => {
  // Rate limiting based on IP address
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimitByIP(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  const { email, username, gender, password, receiveEmails, agreedToTerms } = req.body;

  // Validate input
  if (!email || !username || !password || !gender) {
    return res.status(400).json({ error: 'Email, username, password, and gender are required' });
  }

  if (!agreedToTerms) {
    return res.status(400).json({ error: 'You must agree to the terms' });
  }

  // Check if email or username already exists
  const existing = await dbRead
    .select({ userId: users.userId })
    .from(users)
    .where(or(eq(users.email, email), eq(users.username, username)))
    .limit(1);

  if (existing && existing.length > 0) {
    return res.status(409).json({ error: 'Email or username already exists' });
  }

  // Hash password
  const passwordHash = await hashPassword(password);

  // Create user
  const newUser = await dbWrite
    .insert(users)
    .values({
      userId: generateId(),
      email,
      username,
      passwordHash,
      gender,
    })
    .returning({ userId: users.userId });

  res.status(201).json({ userId: newUser[0].userId });
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

**File: `src/routes/auth.ts`**

```typescript
router.post('/forgot-password', async (req, res) => {
  // Rate limiting based on IP address
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimitByIP(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  const { email } = req.body;

  // Validate input
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  // Check if email exists (don't reveal if it doesn't to prevent email enumeration)
  const user = await dbRead
    .select({ userId: users.userId, email: users.email })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  // TODO: Implement actual email sending logic
  // If user exists, send password reset email
  // For now, just return success to prevent email enumeration
  if (user && user.length > 0) {
    console.log(`Password reset requested for: ${email}`);
    // Email sending logic would go here
    // Example: await sendPasswordResetEmail(email, user[0].userId);
  }

  // Always return success (prevents email enumeration)
  res.json({ message: 'Password reset email sent' });
});
```

**Note:** This is a placeholder implementation. The actual email sending logic needs to be implemented with an email service (e.g., Resend, SendGrid).

### Logout Endpoint

**Backend Logout Endpoint**

**File: `src/routes/auth.ts`**

```typescript
router.post('/logout', async (req, res) => {
  try {
    // NextAuth handles session clearing on the frontend
    // This endpoint is for any backend cleanup if needed
    
    // TODO: Add any backend cleanup logic here
    // - Invalidate refresh tokens (if implemented)
    // - Log logout event for analytics
    // - Clear server-side session data
    
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    handleApiError(res, 'Failed to logout', error, 500);
  }
});
```

**Note:** With NextAuth, logout is primarily handled on the frontend via `await signOut({ callbackUrl: '/' })`. This backend endpoint is provided for future extensibility (refresh tokens, analytics logging, etc.).

## Security Considerations

### Password Security
- **Bcrypt with 12 salt rounds** - Industry-standard password hashing
- **Never store plaintext passwords** - Always hash before storage
- **Password requirements** - Enforce minimum length and complexity on frontend

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
- **Automatic expiration** - Sessions expire after configured TTL
- **Revocation support** - Can revoke sessions if needed

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
- [ ] Run database migration (`pnpm db:generate && pnpm db:migrate`)
- [x] Create password hashing utilities
- [x] Create credential verification endpoint
- [x] Add IP-based rate limiting with LRU cache
- [x] Make rate limits configurable via environment variables
- [x] Register auth routes
- [x] Implement signup endpoint
- [x] Implement forgot-password endpoint
- [x] Implement logout endpoint
- [ ] Test credential verification endpoint
- [ ] Test signup endpoint
- [ ] Test rate limiting

### Frontend
- [ ] Add Credentials provider to NextAuth config
- [ ] Update AuthApi service (login/logout to use NextAuth, keep signup/forgot-password backend calls)
- [ ] Update login components to use NextAuth signIn
- [ ] Update environment variables
- [ ] Test both login methods (Google + Email/Password)
- [ ] Test session persistence
- [ ] Test guest user migration (if applicable)

## References

- [NextAuth.js Documentation](https://next-auth.js.org/)
- [NextAuth Credentials Provider](https://next-auth.js.org/providers/credentials)
- [Bcrypt Documentation](https://github.com/kelektiv/node.bcrypt.js)
- [LRU Cache Documentation](https://github.com/isaacs/node-lru-cache)
