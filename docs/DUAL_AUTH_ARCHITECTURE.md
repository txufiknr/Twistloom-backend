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

## Key Benefits

1. **Single Session Format**: Both auth methods create the same NextAuth session cookie
2. **Backend Simplicity**: Backend only needs to verify JWT cookies (already implemented)
3. **Security**: NextAuth handles CSRF, session management, and security best practices
4. **Flexibility**: Users can choose their preferred login method
5. **Guest Support**: Seamless guest user flow with data migration on login

## Backend Implementation

### 1. Database Schema Changes

**File: `src/db/schema.ts`**

Added `passwordHash` field to users table:
```typescript
export const users = pgTable("users", {
  userId: userId().primaryKey(),
  name: text("name"),
  username: text("username"),
  email: text("email"),
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
  index("users_email_idx").on(t.email),      // NEW: For login lookups
  index("users_username_idx").on(t.username), // NEW: For login lookups
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
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
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

  if (!user || user.length === 0) {
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
// For unauthenticated endpoints (login, signup)
export function checkRateLimitByIP(ip: string): boolean {
  // LRU cache with max 10,000 entries, 1 minute TTL
  // Returns false if rate limited
}
```

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

### 3. Remove Old Auth API Service

**Delete or deprecate:** `src/lib/services/auth-api.ts`

This service is no longer needed since NextAuth handles authentication.

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
```

## User Registration Flow

To support email/password signup, you need to implement a signup endpoint:

### Backend Signup Endpoint

**File: `src/routes/auth.ts`**

```typescript
router.post('/signup', async (req, res) => {
  const { email, username, password, gender, name } = req.body;

  // Validate input
  if (!email || !username || !password) {
    return res.status(400).json({ error: 'Missing required fields' });
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
      name,
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
**Solution:** Adjust `IP_RATE_LIMIT` and `IP_RATE_WINDOW` in `src/middleware/rate-limit.ts`

### Issue: NextAuth session not persisting
**Cause:** AUTH_SECRET mismatch between frontend and backend
**Solution:** Ensure both use the same AUTH_SECRET environment variable

### Issue: CORS errors
**Cause:** Frontend URL not in CORS allowed origins
**Solution:** Add frontend URL to `FRONTEND_URL` environment variable

## Migration Checklist

### Backend
- [x] Add passwordHash field to users schema
- [ ] Run database migration (`pnpm db:generate && pnpm db:migrate`)
- [x] Create password hashing utilities
- [x] Create credential verification endpoint
- [x] Add IP-based rate limiting
- [x] Register auth routes
- [ ] Test credential verification endpoint
- [ ] Implement signup endpoint (if needed)

### Frontend
- [ ] Add Credentials provider to NextAuth config
- [ ] Update login components to use NextAuth signIn
- [ ] Remove/deprecate AuthApi service
- [ ] Update environment variables
- [ ] Test both login methods
- [ ] Test session persistence
- [ ] Test guest user migration (if applicable)

## References

- [NextAuth.js Documentation](https://next-auth.js.org/)
- [NextAuth Credentials Provider](https://next-auth.js.org/providers/credentials)
- [Bcrypt Documentation](https://github.com/kelektiv/node.bcrypt.js)
- [LRU Cache Documentation](https://github.com/isaacs/node-lru-cache)
