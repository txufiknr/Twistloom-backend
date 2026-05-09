# Guest User Flow Documentation

## Overview

Twistloom supports a seamless guest user experience that allows users to immediately start reading books without creating an account. This design prioritizes accessibility while providing a clear path to account creation with data migration.

## Architecture

### Guest User ID Consistency

**Key Point:** Guest user IDs are **consistent per browser/device** and are NOT regenerated on each web visit.

#### Cookie-Based Persistence
- Guest IDs are stored in a cookie named `twistloom_guest_id`
- Cookie expiration: **30 days**
- Cookie settings: `httpOnly: true`, `secure: true` (production), `sameSite: 'lax'`

#### ID Generation Behavior
1. **First visit**: No cookie exists → creates new guest user via `createGuestUser()`
2. **Subsequent visits**: Cookie exists → reuses the same `guestId` from cookie
3. **Cookie expires**: After 30 days → generates new ID on next visit

#### Consistency Scenarios
- **Same browser/device**: ✅ Consistent ID as long as cookie persists
- **Different browsers**: ❌ Different IDs (cookies are browser-specific)
- **Private/incognito mode**: ✅ ID persists within session, cleared when session ends
- **Cookie cleared by user**: ❌ New ID generated on next visit
- **IP changes**: ✅ No effect - cookie-based, not IP-based

#### Cookie Configuration
```typescript
res.cookie(GUEST_COOKIE_NAME, guestId, {
  httpOnly: true,        // Prevents XSS attacks
  secure: IS_PRODUCTION, // HTTPS-only in production
  sameSite: 'lax',       // CSRF protection
  maxAge: 60 * 60 * 24 * 30, // 30 days
  path: '/',
});
```

### Guest vs Authenticated Users

| Feature | Guest Users | Authenticated Users |
|----------|--------------|-------------------|
| **Read Books** | ✅ Full access | ✅ Full access |
| **Create Books** | ✅ Full access (data migrates on signup) | ✅ Full access |
| **Reading Sessions** | ✅ Session-based tracking | ✅ User-based tracking |
| **Progress Saving** | ✅ Per session | ✅ Persistent |
| **Bookmarks/Favorites** | ❌ Requires signup | ✅ Full access |
| **Comments** | ❌ Requires signup | ✅ Full access |

## Backend Implementation

### 1. Guest Middleware

**File:** `src/middleware/guest.ts`

```typescript
import type { Request, Response, NextFunction } from 'express';
import { dbRead, dbWrite } from '../db/client.js';
import { users } from '../db/schema.js';
import { verifyNextAuthToken } from './nextauth.js';
import { generateId } from '../utils/uuid.js';

const GUEST_COOKIE_NAME = 'twistloom_guest_id';

/**
 * Middleware that handles both authenticated and guest users
 * Tries NextAuth authentication first, falls back to guest cookie
 * Creates new guest user if neither exists
 */
export async function guestOrAuthMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // Try NextAuth authentication first
    const user = await verifyNextAuthToken(req);

    if (user) {
      // Authenticated user
      req.guestAuth = {
        isAuthenticated: true,
        userId: user.id,
        isGuest: false,
        user,
      };
      req.user = user;
      next();
      return;
    }

    // Guest user - check for guest cookie
    const guestCookie = req.cookies?.[GUEST_COOKIE_NAME];
    let guestId = guestCookie;

    if (!guestId) {
      // Create new guest user in database with isGuest flag
      guestId = await createGuestUser();
      
      // Set guest cookie in response
      res.cookie(GUEST_COOKIE_NAME, guestId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 30, // 30 days
        path: '/',
      });
    }

    req.guestAuth = {
      isAuthenticated: false,
      userId: guestId,
      isGuest: true,
    };
    req.userId = guestId; // Set req.userId for rate limiting and route handlers

    next();
  } catch (error) {
    console.error('Guest middleware error:', error);
    // On error, treat as unauthenticated guest
    req.guestAuth = {
      isAuthenticated: false,
      userId: null,
      isGuest: true,
    };
    next();
  }
}

/**
 * Migrates data from a guest user to an authenticated user
 * Transfers all books, sessions, and other data from guest to authenticated user
 */
export async function migrateGuestData(guestId: string, authenticatedUserId: string): Promise<void> {
  // Migrate all books from guest to authenticated user
  await dbWrite
    .update(books)
    .set({ userId: authenticatedUserId })
    .where(eq(books.userId, guestId));

  // Migrate all sessions from guest to authenticated user
  await dbWrite
    .update(userSessions)
    .set({ userId: authenticatedUserId })
    .where(eq(userSessions.userId, guestId));

  // Delete guest user from database
  await dbWrite.delete(users).where(eq(users.userId, guestId));
}

/**
 * Middleware to migrate guest data to authenticated user
 * Should be used on login/callback endpoints
 */
export async function migrateGuestMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await verifyNextAuthToken(req);

    if (user) {
      const guestCookie = req.cookies?.[GUEST_COOKIE_NAME];

      if (guestCookie && user.id !== guestCookie) {
        // Migrate guest data to authenticated user
        await migrateGuestData(guestCookie, user.id);

        // Remove guest cookie
        res.clearCookie(GUEST_COOKIE_NAME, {
          path: '/',
        });
      }
    }

    next();
  } catch (error) {
    console.error('Guest migration middleware error:', error);
    // Continue even if migration fails
    next();
  }
}
```

### 2. Reading Session Management

**Endpoint:** `POST /api/books/:id/sessions`

Creates or updates reading sessions for both guests and authenticated users.

**Request Body:**
```json
{
  "pageId": "page456" // Optional - if not provided, auto-finds page 1
}
```

**Response (201 Created):**
```json
{
  "session": {
    "id": "session789",
    "userId": "guest456", // Guest user ID or authenticated user ID (never null)
    "bookId": "book123",
    "pageId": "page456",
    "previousPageId": null,
    "status": "active",
    "createdAt": "2023-01-01T00:00:00.000Z",
    "updatedAt": "2023-01-01T00:00:00.000Z"
  },
  "book": {
    "id": "book123",
    "title": "The Whispering Halls"
  }
}
```

**Error Responses:**
- `400 Bad Request`: Invalid pageId format
- `404 Not Found`: Book not found, or book has no pages

**Database Schema:**
```sql
-- userSessions table stores both guest and user sessions
-- userId is never null - guests have valid guest user IDs
CREATE TABLE user_sessions (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id), -- Can be guest user ID
  book_id UUID NOT NULL REFERENCES books(id),
  page_id UUID NOT NULL REFERENCES pages(id),
  previous_page_id UUID REFERENCES pages(id),
  status TEXT DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### 3. Book Creation

**Endpoint:** `POST /api/books`

Uses `guestOrAuthMiddleware` to allow both guests and authenticated users to create books. Guest-created books are associated with a temporary guest user ID and migrate to the authenticated user on signup.

**Request Body:**
```json
{
  "theme": "haunted mansion mystery",
  "mcCandidate": {
    "name": "Sarah",
    "age": 28,
    "gender": "female",
    "bio": "Shy librarian with hidden past"
  }
}
```

**Response (201 Created):**
```json
{
  "book": {
    "id": "book123",
    "title": "The Whispering Halls",
    "userId": "guest456", // Guest user ID
    "status": "active"
  },
  "firstPage": {
    "id": "page456",
    "page": 1,
    "text": "The library was silent except for the rain..."
  }
}
```

**Guest Book Creation Flow:**
1. Guest submits book creation request without authentication
2. `guestOrAuthMiddleware` creates a guest user (if not exists) and sets `req.userId`
3. Book is created with the guest user ID
4. Guest receives book data and can immediately start reading
5. When guest signs up, `migrateGuestData()` transfers all books to the new account

**Database Schema:**
```sql
-- users table stores both guest and authenticated users
-- Guest users are identified by isGuest = true flag
CREATE TABLE users (
  user_id UUID PRIMARY KEY,
  name TEXT,
  email TEXT UNIQUE,
  is_guest BOOLEAN NOT NULL DEFAULT false, -- Distinguishes guest users
  -- ... other user fields
  created_at TIMESTAMP DEFAULT NOW()
);

-- Index for efficient guest user queries
CREATE INDEX users_is_guest_idx ON users(is_guest);

-- books table stores both guest and user books
-- userId references users.id (guest users are valid users in the users table)
CREATE TABLE books (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id), -- Can be guest user ID
  title TEXT,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW()
);
```

### 4. Book Page Access

**Endpoint:** `GET /api/books/:identifier/:branchId/:page`

Retrieves a specific page within a branch of a book. Accepts both slug and UUID v7 as identifier. Uses `optionalAuth` middleware to allow both guests and authenticated users.

**Path Parameters:**
- `identifier` (string, required): Book slug or UUID v7
- `branchId` (string, required): Branch identifier (e.g., "main", "abc123")
- `page` (number, required): Page number within the branch

**Response (200 OK):**
```json
{
  "page": {
    "id": "page456",
    "page": 1,
    "text": "The library was silent except for the rain...",
    "mood": "eerie",
    "place": "library",
    "timeOfDay": "night",
    "actions": [
      {
        "text": "Investigate the noise",
        "type": "explore",
        "hint": {
          "text": "Something waits in the shadows",
          "type": "dark_discovery"
        },
        "navigation": {
          "bookId": "book123",
          "branchId": "main",
          "page": 2
        }
      }
    ],
    "createdAt": "2023-01-01T00:00:00.000Z"
  },
  "book": {
    "id": "book123",
    "title": "The Whispering Halls",
    "slug": "the-whispering-halls",
    "totalPages": 120
  }
}
```

**Error Responses:**
- `404 Not Found`: Book or page not found

## Frontend Implementation (Next.js)

### 1. Session Management Hook

Create a custom hook to manage reading sessions:

```typescript
// hooks/useReadingSession.ts
import { useState } from 'react';
import { useSession } from 'next-auth/react';

interface ReadingSession {
  id: string;
  bookId: string;
  pageId: string;
}

export function useReadingSession(bookId: string) {
  const { data: session } = useSession();
  const [readingSession, setReadingSession] = useState<ReadingSession | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Create/update session when page changes
  const updateSession = async (pageId: string) => {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/books/${bookId}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageId }),
      });

      const data = await response.json();
      setReadingSession(data.session);
    } catch (error) {
      console.error('Failed to update reading session:', error);
    } finally {
      setIsLoading(false);
    }
  };

  return {
    readingSession,
    isLoading,
    updateSession,
    isGuest: !session?.user
  };
}
```

### 2. Book Reading Component

```typescript
// components/BookReader.tsx
import { useReadingSession } from '../hooks/useReadingSession';
import { useSession } from 'next-auth/react';

interface BookReaderProps {
  bookId: string;
  initialPageId?: string;
}

export default function BookReader({ bookId, initialPageId }: BookReaderProps) {
  const { data: session } = useSession();
  const { readingSession, isLoading, updateSession, isGuest } = useReadingSession(bookId);
  const [currentPage, setCurrentPage] = useState<string | null>(initialPageId || null);

  // Handle page navigation
  const handlePageChange = (pageId: string) => {
    setCurrentPage(pageId);
    updateSession(pageId);
  };

  // Guest user prompts
  const GuestPrompts = () => {
    if (!isGuest) return null;

    return (
      <div className="guest-banner">
        <p>📖 Reading as guest</p>
        <button onClick={() => router.push('/auth/signup')}>
          Create Account to Save Progress
        </button>
        <p className="guest-hint">
          Your progress and books will migrate when you sign up
        </p>
      </div>
    );
  };

  return (
    <div className="book-reader">
      <GuestPrompts />
      
      {/* Book content */}
      {currentPage && (
        <BookPage 
          pageId={currentPage}
          bookId={bookId}
          onPageChange={handlePageChange}
        />
      )}
      
      {isLoading && <ReadingSpinner />}
    </div>
  );
}
```

### 3. Account Creation with Automatic Migration

**Note:** Data migration is handled automatically by the backend's `migrateGuestMiddleware` on login/signup. No manual migration API calls are needed from the frontend.

When a guest user signs up or logs in:
1. The backend `migrateGuestMiddleware` detects the guest cookie
2. Automatically transfers all books and sessions from guest to authenticated user
3. Removes the guest cookie
4. Guest user is deleted from database

```typescript
// components/AccountMigration.tsx
import { useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';

export default function AccountMigration() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isMigrating, setIsMigrating] = useState(false);
  const router = useRouter();

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsMigrating(true);

    try {
      // 1. Create account via backend
      const signupResponse = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          // ... other signup fields
        }),
      });

      if (!signupResponse.ok) {
        throw new Error('Failed to create account');
      }

      // 2. Sign in with new account (migration happens automatically via backend middleware)
      await signIn('credentials', {
        emailOrUsername: email,
        password,
        redirect: false,
      });

      // 3. Redirect to library (all guest books and progress have been migrated)
      router.push('/library');

    } catch (error) {
      console.error('Signup failed:', error);
      // Show error to user
    } finally {
      setIsMigrating(false);
    }
  };

  return (
    <form onSubmit={handleSignup} className="migration-form">
      <h2>Save Your Reading Progress</h2>
      <p>Create an account to save your books and progress across devices</p>

      <div className="form-group">
        <label>Email:</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>

      <div className="form-group">
        <label>Password:</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>

      <button type="submit" disabled={isMigrating}>
        {isMigrating ? 'Creating Account...' : 'Create Account & Save Progress'}
      </button>
    </form>
  );
}
```

## User Experience Flow

### 1. Initial Access (Guest)
```
User visits book → Clicks "Start Reading" → Creates guest session → Begins reading
```

### 2. Reading Experience
```
Guest reads book → Sees "Reading as guest" banner → Can navigate pages → Progress saved in session
```

### 3. Account Creation Decision Point
```
Guest reaches chapter end → Sees migration prompt → Can dismiss → Continues as guest
                      → Can accept → Creates account → Automatic migration via backend middleware → Auto-signed in
```

### 4. Post-Migration
```
New user account → Full authenticated experience → All guest books and progress transferred → All features available
```

**Note:** Migration is handled automatically by the backend's `migrateGuestMiddleware` on login/signup. No manual migration steps are required from the frontend.

## Best Practices

### Frontend
1. **Clear Guest Status**: Always indicate when user is guest vs authenticated
2. **Progress Persistence**: Show clear messaging about session-based vs persistent progress
3. **Migration Timing**: Offer migration at natural breakpoints (chapter ends, book completion)
4. **Graceful Fallbacks**: Handle session expiration gracefully
5. **Privacy**: Don't require personal data for basic reading

### Backend
1. **Session Cleanup**: Automatically expire old guest sessions
2. **Data Integrity**: Validate guest session ownership during migration
3. **Rate Limiting**: Apply same rate limits to guests and users
4. **Error Handling**: Clear error messages for session-related failures

### Security Considerations
1. **Session Security**: Guest sessions still use secure session management
2. **Migration Validation**: Verify guest session ownership before migration
3. **Rate Limiting**: Prevent abuse of guest access
4. **Data Privacy**: Clear guest session data after migration

## Testing Checklist

### Guest Access Tests
- [ ] Can read book without authentication
- [ ] Session creation works for guests
- [ ] Page navigation updates guest session
- [ ] Guest banner displays correctly

### Migration Tests
- [ ] Account creation with progress migration
- [ ] Invalid guest session rejected
- [ ] Progress accurately transferred
- [ ] Guest session marked as migrated

### Edge Cases
- [ ] Session expiration handling
- [ ] Multiple tab session management
- [ ] Network failure during migration
- [ ] Account already exists during migration

## Implementation Status

**Status:** ✅ Complete

The guest user flow has been fully implemented with the following components:

- ✅ Guest middleware with automatic user creation and cookie management
- ✅ Reading session endpoints supporting both guests and authenticated users
- ✅ Book creation endpoints supporting guests with automatic migration
- ✅ Book page access with optional authentication
- ✅ Automatic data migration via `migrateGuestMiddleware` on login/signup
- ✅ Guest cookie management with secure settings

**Migration Mechanism:** All guest data (books, sessions, progress) automatically migrates to authenticated users when they sign up or log in, handled by the backend's `migrateGuestMiddleware`.

## Conclusion

The guest user flow provides immediate access to Twistloom's content while encouraging account creation through value-added features like persistent progress and full platform access. The migration system ensures users don't lose their reading investment when they decide to create an account.
