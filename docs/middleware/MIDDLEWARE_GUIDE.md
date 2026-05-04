# Middleware Guide

This document provides comprehensive documentation for all available middleware in the Twistloom backend application.

## Overview

The application uses Express.js middleware for authentication, guest user management, and request processing. Each middleware serves a specific purpose and is designed to handle different authentication scenarios.

## Available Middleware

### 1. `requireAuth` - Authentication Required

**Location:** `src/middleware/nextauth.ts`

**Purpose:** Enforces authentication using NextAuth JWT tokens. Rejects unauthenticated requests.

**Use Cases:**
- Protected endpoints that require authenticated users
- Operations that need user identity and permissions
- Credit consumption endpoints
- User-specific data operations

**Behavior:**
- Verifies NextAuth JWT token from request cookies
- Sets `req.user` with user information
- Sets `req.userId` for backward compatibility
- Returns 401 Unauthorized if authentication fails
- Does NOT allow guest users

**Example Usage:**
```typescript
import { requireAuth } from '../middleware/nextauth.js';

router.post('/api/books', requireAuth, async (req: Request, res: Response) => {
  // req.user is guaranteed to exist
  const userId = req.userId!; // Non-null assertion is safe
  
  // User is authenticated, can consume credits
  await consumeCredits(userId, "STORY_GENERATION");
  
  res.json({ success: true });
});
```

**Error Response:**
```json
{
  "error": {
    "type": "AUTHENTICATION_ERROR",
    "message": "Authentication required"
  }
}
```

---

### 2. `optionalAuth` - Optional Authentication

**Location:** `src/middleware/nextauth.ts`

**Purpose:** Attempts authentication but continues regardless of success. Provides user context when available.

**Use Cases:**
- Public endpoints that can benefit from user context
- Personalized content for authenticated users
- Statistics and analytics endpoints
- Content that can be served to both guests and authenticated users

**Behavior:**
- Verifies NextAuth JWT token from request cookies
- Sets `req.user` and `req.userId` only if authentication succeeds
- Continues to next middleware regardless of authentication status
- Does NOT create guest users
- No database operations

**Example Usage:**
```typescript
import { optionalAuth } from '../middleware/nextauth.js';

router.get('/api/books/explore', optionalAuth, async (req: Request, res: Response) => {
  const books = await getExploreBooks();
  
  if (req.user) {
    // Personalize for authenticated user
    const enrichedBooks = books.map(book => ({
      ...book,
      isLiked: await checkIfUserLiked(book.id, req.userId!),
      isRead: await checkIfUserRead(book.id, req.userId!)
    }));
    res.json({ books: enrichedBooks });
  } else {
    // Serve generic content to guests
    res.json({ books });
  }
});
```

**Performance Benefits:**
- No database operations
- Lightweight authentication check
- Fast for high-traffic public endpoints

---

### 3. `guestOrAuthMiddleware` - Guest or Authenticated Users

**Location:** `src/middleware/guest.ts`

**Purpose:** Supports both authenticated users and guest users with persistent guest accounts.

**Use Cases:**
- Endpoints that need user identification for any user
- Content creation and personalization
- Reading sessions and progress tracking
- Operations that benefit from guest user persistence

**Behavior:**
1. **First:** Attempts NextAuth authentication
2. **Fallback:** Checks for existing guest cookie
3. **Creation:** Creates new guest user if neither exists
4. **Persistence:** Sets guest cookie with 30-day expiration
5. **Always:** Sets `req.userId` for rate limiting

**Request Object:**
```typescript
// For authenticated users
req.guestAuth = {
  isAuthenticated: true,
  userId: "user123",
  isGuest: false,
  user: { /* NextAuth user object */ }
};
req.user = { /* NextAuth user object */ };
req.userId = "user123";

// For guest users
req.guestAuth = {
  isAuthenticated: false,
  userId: "guest456",
  isGuest: true
};
req.user = undefined;
req.userId = "guest456";
```

**Example Usage:**
```typescript
import { guestOrAuthMiddleware } from '../middleware/guest.js';

router.get('/api/books', guestOrAuthMiddleware, async (req: Request, res: Response) => {
  const { isAuthenticated, userId, isGuest } = req.guestAuth!;
  
  // Always have a userId for rate limiting
  await rateLimitCheck(userId);
  
  const books = await getUserBooks(userId);
  
  res.json({ 
    books,
    isGuest,
    isAuthenticated
  });
});
```

**Guest Cookie Details:**
- **Name:** `twistloom_guest_id`
- **Duration:** 30 days
- **Security:** HttpOnly, Secure (production), SameSite (Lax/None)
- **Domain:** Auto-detected from request headers

**Database Operations:**
- Creates guest users in `users` table
- Handles race conditions with retry logic (max 3 attempts)
- UUID v7 generation for guest IDs

---

### 4. `migrateGuestMiddleware` - Guest Data Migration

**Location:** `src/middleware/guest.ts`

**Purpose:** Migrates guest data to authenticated user on login.

**Use Cases:**
- Login/callback endpoints
- Authentication success handlers
- User account creation flows

**Behavior:**
- Verifies NextAuth authentication
- Checks for existing guest cookie
- Migrates all guest data (books, sessions, etc.) to authenticated user
- Removes guest cookie
- Deletes guest user record

**Migration Operations:**
```typescript
// Transfers ownership of:
- Books (books.userId)
- Reading sessions (user_sessions.userId)
- Page progress (user_page_progress.userId)
- Likes, favorites, comments
```

**Example Usage:**
```typescript
import { migrateGuestMiddleware } from '../middleware/guest.js';

router.post('/api/auth/callback', migrateGuestMiddleware, async (req: Request, res: Response) => {
  // Guest data has been migrated if applicable
  // User is now authenticated with all their previous guest content
  res.json({ success: true });
});
```

---

## Middleware Comparison

| Feature | `requireAuth` | `optionalAuth` | `guestOrAuthMiddleware` | `migrateGuestMiddleware` |
|---------|---------------|----------------|------------------------|--------------------------|
| **Authentication Required** | ✅ Yes | ❌ No | ❌ No | ✅ Yes |
| **Guest Users Supported** | ❌ No | ❌ No | ✅ Yes | ✅ Yes (migration only) |
| **Database Operations** | ❌ No | ❌ No | ✅ Yes (guest creation) | ✅ Yes (data migration) |
| **Cookie Management** | ❌ No | ❌ No | ✅ Yes (guest cookie) | ✅ Yes (cookie cleanup) |
| **Sets req.user** | ✅ Yes | ✅ If auth | ✅ If auth | ✅ Yes |
| **Sets req.userId** | ✅ Yes | ✅ If auth | ✅ Always | ✅ Yes |
| **Sets req.guestAuth** | ❌ No | ❌ No | ✅ Always | ❌ No |
| **Use Case** | Protected operations | Optional personalization | Guest + auth support | Data migration |
| **Performance** | Fast | Fastest | Medium (DB ops) | Medium (DB ops) |

## Usage Patterns

### Pattern 1: Protected Operations
```typescript
// Book creation, credit consumption, user settings
router.post('/api/books', requireAuth, async (req, res) => {
  // Guaranteed authenticated user
  const userId = req.userId!;
});
```

### Pattern 2: Public with Personalization
```typescript
// Explore page, public content with optional personalization
router.get('/api/books/explore', optionalAuth, async (req, res) => {
  if (req.user) {
    // Personalized content
  } else {
    // Generic content
  }
});
```

### Pattern 3: Guest + Auth Support
```typescript
// User library, reading sessions, content creation
router.get('/api/books', guestOrAuthMiddleware, async (req, res) => {
  const { isAuthenticated, isGuest, userId } = req.guestAuth!;
  // Always have userId for operations
});
```

### Pattern 4: Authentication Flow
```typescript
// Login, signup, authentication callbacks
router.post('/api/auth/callback', migrateGuestMiddleware, async (req, res) => {
  // Guest data migrated to authenticated user
});
```

## Performance Considerations

### `requireAuth` (Fastest)
- JWT verification only
- No database operations
- ~1-5ms per request

### `optionalAuth` (Fastest)
- JWT verification only (if token present)
- No database operations
- ~1-5ms per request

### `guestOrAuthMiddleware` (Medium)
- JWT verification + potential DB operations
- Guest user creation (if needed)
- ~10-50ms per request (with guest creation)
- ~5-10ms per request (existing guest)

### `migrateGuestMiddleware` (Medium)
- JWT verification + data migration
- Multiple database updates
- ~50-200ms per request (depending on data volume)

## Security Considerations

### JWT Security
- Uses NextAuth's secure JWT verification
- Token expiration handled automatically
- No manual token validation required

### Guest Cookie Security
- **HttpOnly:** Prevents XSS attacks
- **Secure:** HTTPS only in production
- **SameSite:** CSRF protection (Lax/None based on cross-origin)
- **Expiration:** 30 days limits exposure

### Rate Limiting
- All middleware set `req.userId` for rate limiting
- Guest users are rate limited by guest ID
- Authenticated users are rate limited by user ID

## Best Practices

### 1. Choose the Right Middleware
```typescript
// ❌ Wrong: Using requireAuth for public endpoint
router.get('/api/public/stats', requireAuth, handler); // Blocks guests

// ✅ Correct: Using optionalAuth for public endpoint
router.get('/api/public/stats', optionalAuth, handler); // Allows all users
```

### 2. Handle Guest vs Auth Appropriately
```typescript
// ✅ Good: Check authentication status
router.get('/api/books', guestOrAuthMiddleware, async (req, res) => {
  const { isAuthenticated, isGuest } = req.guestAuth!;
  
  if (isGuest) {
    // Limit guest functionality
    const books = await getGuestBooks(req.userId);
  } else {
    // Full authenticated functionality
    const books = await getUserBooks(req.userId);
  }
});
```

### 3. Use Type Guards
```typescript
// ✅ Good: Type-safe authentication checks
function isAuthenticated(req: Request): req is Request & { user: User } {
  return !!req.user;
}

router.get('/api/data', optionalAuth, async (req, res) => {
  if (isAuthenticated(req)) {
    // TypeScript knows req.user exists
    const userData = await getUserData(req.user.id);
  }
});
```

### 4. Error Handling
```typescript
// ✅ Good: Handle middleware failures gracefully
router.post('/api/books', requireAuth, async (req, res) => {
  try {
    // Protected operation
  } catch (error) {
    if (error.type === 'AUTHENTICATION_ERROR') {
      return res.status(401).json({ error: 'Authentication required' });
    }
    // Handle other errors
  }
});
```

## Migration Guide

### From `optionalAuth` to `guestOrAuthMiddleware`
```typescript
// Before
router.get('/api/books', optionalAuth, async (req, res) => {
  if (req.user) {
    const books = await getUserBooks(req.userId!);
  } else {
    const books = []; // Empty for guests
  }
});

// After
router.get('/api/books', guestOrAuthMiddleware, async (req, res) => {
  const { isAuthenticated, userId } = req.guestAuth!;
  const books = await getUserBooks(userId); // Works for both auth and guests
});
```

### From `guestOrAuthMiddleware` to `requireAuth`
```typescript
// Before
router.post('/api/books', guestOrAuthMiddleware, async (req, res) => {
  if (req.guestAuth!.isGuest) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  // Continue with authenticated user
});

// After
router.post('/api/books', requireAuth, async (req, res) => {
  // req.user is guaranteed to exist
  // Continue with authenticated user
});
```

## Testing Considerations

### Unit Testing Middleware
```typescript
// Test requireAuth
it('should reject unauthenticated requests', async () => {
  const req = { cookies: {} } as Request;
  const res = {} as Response;
  const next = jest.fn();
  
  await requireAuth(req, res, next);
  
  expect(next).not.toHaveBeenCalled();
  // Expect 401 response
});

// Test guestOrAuthMiddleware
it('should create guest user for new visitors', async () => {
  const req = { cookies: {} } as Request;
  const res = { cookie: jest.fn() } as Response;
  const next = jest.fn();
  
  await guestOrAuthMiddleware(req, res, next);
  
  expect(req.guestAuth?.isGuest).toBe(true);
  expect(req.userId).toBeDefined();
  expect(res.cookie).toHaveBeenCalled();
});
```

### Integration Testing
```typescript
// Test full authentication flow
it('should migrate guest data on login', async () => {
  // Create guest user and data
  const guestId = await createGuestUser();
  await createBook({ userId: guestId });
  
  // Simulate login with migration
  const response = await request(app)
    .post('/api/auth/callback')
    .set('Cookie', `twistloom_guest_id=${guestId}`)
    .send({ /* auth data */ });
  
  expect(response.status).toBe(200);
  
  // Verify data migration
  const books = await getUserBooks(authenticatedUserId);
  expect(books).toHaveLength(1);
});
```

## Troubleshooting

### Common Issues

1. **Guest Cookie Not Set**
   - Check frontend domain configuration
   - Verify SameSite settings for cross-origin requests
   - Ensure HTTPS in production for Secure cookies

2. **Authentication Fails Silently**
   - Verify NextAuth configuration
   - Check JWT token expiration
   - Ensure proper cookie domain/path

3. **Guest Data Not Migrating**
   - Verify `migrateGuestMiddleware` is used in auth flow
   - Check guest cookie exists during login
   - Ensure database connectivity for migration operations

4. **Performance Issues**
   - Use `optionalAuth` for high-traffic public endpoints
   - Monitor guest creation frequency
   - Consider caching for frequently accessed data

### Debug Mode
Enable debug logging to trace middleware behavior:

```typescript
// In development
if (process.env.NODE_ENV === 'development') {
  console.log('Middleware debug:', {
    hasUser: !!req.user,
    hasGuestAuth: !!req.guestAuth,
    userId: req.userId,
    cookies: req.cookies
  });
}
```

---

## Conclusion

The middleware system provides flexible authentication options for different use cases:

- **`requireAuth`** for protected operations
- **`optionalAuth`** for lightweight optional authentication
- **`guestOrAuthMiddleware`** for full guest + auth support
- **`migrateGuestMiddleware`** for data migration

Choose the appropriate middleware based on your endpoint requirements, considering performance, security, and user experience needs.
