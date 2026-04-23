# Guest User Flow Documentation

## Overview

Twistloom supports a seamless guest user experience that allows users to immediately start reading books without creating an account. This design prioritizes accessibility while providing a clear path to account creation with data migration.

## Architecture

### Guest vs Authenticated Users

| Feature | Guest Users | Authenticated Users |
|----------|--------------|-------------------|
| **Read Books** | ✅ Full access | ✅ Full access |
| **Create Books** | ❌ Requires signup | ✅ Full access |
| **Reading Sessions** | ✅ Session-based tracking | ✅ User-based tracking |
| **Progress Saving** | ✅ Per session | ✅ Persistent |
| **Bookmarks/Favorites** | ❌ Requires signup | ✅ Full access |
| **Comments** | ❌ Requires signup | ✅ Full access |

## Backend Implementation

### 1. Guest Middleware

**File:** `src/middleware/guest.ts`

```typescript
import { Request, Response, NextFunction } from 'express';
import { verifyNextAuthToken } from './nextauth.js';

/**
 * Middleware that allows both authenticated users and guests
 * Sets req.userId for authenticated users, leaves undefined for guests
 */
export function guestOrAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.['next-auth.session-token'];
    
    if (token) {
      const payload = verifyNextAuthToken(token);
      if (payload) {
        req.userId = payload.userId;
        req.user = payload; // User data available
      }
    }
    // If no token, user remains undefined (guest)
  } catch (error) {
    // Invalid token - treat as guest
    console.warn('Invalid auth token, treating as guest:', error);
  }
  
  next();
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
    "userId": "user456", // null for guests
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
CREATE TABLE user_sessions (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id), -- null for guests
  book_id UUID NOT NULL REFERENCES books(id),
  page_id UUID NOT NULL REFERENCES pages(id),
  previous_page_id UUID REFERENCES pages(id),
  status TEXT DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### 3. Book Page Access

**Endpoint:** `GET /api/books/:id/:pageId`

Uses `optionalAuth` middleware to allow both guests and authenticated users.

**Response:**
```json
{
  "id": "page456",
  "pageNumber": 1,
  "page": "The hallway stretched endlessly before me...",
  "mood": "eerie",
  "actions": ["investigate noise", "run away"],
  "readingSession": {
    "id": "session789",
    "currentPage": "page456",
    "progress": 0.65
  }
}
```

## Frontend Implementation (Next.js)

### 1. Session Management Hook

Create a custom hook to manage reading sessions:

```typescript
// hooks/useReadingSession.ts
import { useState, useEffect } from 'react';
import { useSession } from 'next-auth/react';

interface ReadingSession {
  id: string;
  bookId: string;
  pageId: string;
  progress: number;
}

export function useReadingSession(bookId: string) {
  const { data: session } = useSession();
  const [readingSession, setReadingSession] = useState<ReadingSession | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Load existing session on mount
  useEffect(() => {
    const loadSession = async () => {
      try {
        const response = await fetch(`/api/books/${bookId}/current-session`);
        const data = await response.json();
        if (data.session) {
          setReadingSession(data.session);
        }
      } catch (error) {
        console.error('Failed to load reading session:', error);
      }
    };

    loadSession();
  }, [bookId]);

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
          Your progress is saved in this browser session only
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

### 3. Account Creation with Progress Migration

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
      // 1. Create account
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

      const { userId } = await signupResponse.json();

      // 2. Get current guest session
      const guestSessionResponse = await fetch('/api/books/current-session');
      const guestSession = await guestSessionResponse.json();

      // 3. Migrate reading progress (if exists)
      if (guestSession.session) {
        await fetch('/api/users/migrate-guest-progress', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${userId}` // New user token
          },
          body: JSON.stringify({
            guestSessionId: guestSession.session.id,
            bookId: guestSession.session.bookId,
            currentPageId: guestSession.session.pageId,
            progress: guestSession.session.progress
          }),
        });
      }

      // 4. Sign in with new account
      await signIn('credentials', {
        emailOrUsername: email,
        password,
        redirect: false,
      });

      // 5. Redirect to book with preserved progress
      router.push(`/books/${guestSession.session.bookId}`);
      
    } catch (error) {
      console.error('Migration failed:', error);
      // Show error to user
    } finally {
      setIsMigrating(false);
    }
  };

  return (
    <form onSubmit={handleSignup} className="migration-form">
      <h2>Save Your Reading Progress</h2>
      <p>Create an account to save your reading progress across devices</p>
      
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

### 4. Progress Migration Endpoint

**Backend Endpoint:** `POST /api/users/migrate-guest-progress`

```typescript
// routes/user.ts
router.post('/migrate-guest-progress', requireAuth, async (req: Request, res: Response) => {
  try {
    const { guestSessionId, bookId, currentPageId, progress } = req.body;
    const userId = req.userId!;

    // Verify guest session exists and belongs to this user's session
    const guestSession = await dbRead
      .select()
      .from(userSessions)
      .where(and(
        eq(userSessions.id, guestSessionId),
        isNull(userSessions.userId) // Must be a guest session
      ))
      .limit(1);

    if (!guestSession.length) {
      return res.status(404).json({ error: 'Guest session not found' });
    }

    // Create new user session with migrated progress
    await dbWrite.insert(userSessions).values({
      userId,
      bookId,
      pageId: currentPageId,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Mark guest session as migrated
    await dbWrite
      .update(userSessions)
      .set({ 
        status: 'migrated',
        updatedAt: new Date(),
      })
      .where(eq(userSessions.id, guestSessionId));

    res.json({ 
      message: 'Progress migrated successfully',
      bookId,
      currentPageId 
    });

  } catch (error) {
    handleApiError(res, 'Failed to migrate progress', error, 500);
  }
});
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
                      → Can accept → Creates account → Progress migrated → Auto-signed in
```

### 4. Post-Migration
```
New user account → Full authenticated experience → Persistent progress → All features available
```

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

## Implementation Timeline

### Phase 1: Basic Guest Support (Week 1)
- Implement guest middleware
- Create reading session endpoints
- Update book page access

### Phase 2: Migration System (Week 2)
- Build account migration flow
- Implement progress transfer
- Add migration endpoint

### Phase 3: Polish & Optimization (Week 3)
- Add guest prompts and banners
- Implement session cleanup
- Performance optimization
- Comprehensive testing

## Conclusion

The guest user flow provides immediate access to Twistloom's content while encouraging account creation through value-added features like persistent progress and full platform access. The migration system ensures users don't lose their reading investment when they decide to create an account.
