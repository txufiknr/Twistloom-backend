# Guest User Complete Removal Roadmap

## Overview

This document provides a comprehensive roadmap for completely removing the guest user feature from the Twistloom backend. This is a **breaking change** that simplifies the system to only support authenticated or unauthenticated users, with no guest data migration.

**Decision Rationale:**
- **Simplicity**: Removes complex guest migration logic
- **Clean Code**: Eliminates temporary session system and lazy guest creation
- **Clean Data**: No orphaned guest data, no migration complexity
- **Fresh Start**: All new signups start with fresh data

**Impact:**
- Users must authenticate to perform any write operations
- No temporary sessions or guest users
- Simplified authentication flow (authenticated or unauthenticated only)
- All existing guest data will be deleted

---

## Current Guest System Architecture

### Components to Remove

#### 1. Database Schema
- `users.isGuest` field (boolean flag)
- `temporarySessions` table (ephemeral session tracking)
- `sessionDataAssociations` table (session-to-user association)
- Indexes related to guest users
- Foreign key constraints referencing guest users

#### 2. Middleware
- `src/middleware/guest.ts` (entire file)
- Guest cookie management (`twistloom_guest_id`)
- Temporary session cookie management (`twistloom_temp_session_id`)
- Guest creation logic with deduplication
- Lazy guest creation logic

#### 3. Services
- `src/services/temporary-session.ts` (entire file)
- `src/services/session-data-association.ts` (entire file)
- Guest migration functions in `src/services/user-controller.ts`
  - `migrateGuestToAuthUser()`
  - `createGuestUser()`

#### 4. Configuration
- `ENABLE_LAZY_GUEST_CREATION` flag in `src/config/auth.ts`
- `TEMP_SESSION_CONFIG` in `src/config/auth.ts`
- `GUEST_CONFIG` in `src/config/auth.ts`
- Guest-related environment variables

#### 5. Routes Using Guest Middleware
- Any route using `guestOrAuthMiddleware` must be updated
- Routes must use either `requireAuth` or `optionalAuth` from `src/middleware/nextauth.ts`

#### 6. Documentation
- `docs/architecture/DUAL_AUTH_ARCHITECTURE.md` (guest sections)
- `docs/architecture/GUEST_USER_FLOW.md` (entire file)
- `docs/architecture/GUEST_USER_DEDUPLICATION_ANALYSIS.md` (entire file)
- `docs/architecture/LAZY_GUEST_CREATION_IMPLEMENTATION.md` (entire file)

---

## Removal Plan

### Phase 1: Database Schema Changes ✅ COMPLETED

#### Step 1.1: Create Migration to Drop Guest-Related Tables ✅ COMPLETED

**File:** `drizzle/migration/XXXXXX_drop_guest_tables.sql`

```sql
-- Drop session data associations table
DROP TABLE IF EXISTS session_data_associations CASCADE;

-- Drop temporary sessions table
DROP TABLE IF EXISTS temporary_sessions CASCADE;

-- Remove isGuest column from users table
ALTER TABLE users DROP COLUMN IF EXISTS is_guest;

-- Remove guest-related indexes (if any)
DROP INDEX IF EXISTS users_is_guest_idx;
```

#### Step 1.2: Update TypeScript Schema ✅ COMPLETED

**File:** `src/db/schema.ts`

**Changes:**
- ✅ Remove `isGuest` field from `users` table definition (already removed)
- ✅ Remove `temporarySessions` table export (already removed)
- ✅ Remove `sessionDataAssociations` table export (already removed)
- ✅ Remove `SessionEntityType` type definition (if only used for guest system)

**Before:**
```typescript
export const users = pgTable("users", {
  userId: uuid("user_id").primaryKey().defaultRandom(),
  // ... other fields
  isGuest: boolean("is_guest").notNull().default(false),
  // ... other fields
});

export const temporarySessions = pgTable("temporary_sessions", {
  // ... temporary session fields
});

export const sessionDataAssociations = pgTable("session_data_associations", {
  // ... session association fields
});
```

**After:**
```typescript
export const users = pgTable("users", {
  userId: uuid("user_id").primaryKey().defaultRandom(),
  // ... other fields (isGuest removed)
});
// temporarySessions and sessionDataAssociations removed
```

#### Step 1.3: Run Migration ✅ COMPLETED

```bash
pnpm db:generate
pnpm db:migrate
```

**Verification:**
- ✅ Confirm tables are dropped
- ✅ Confirm `isGuest` column is removed
- ✅ Verify no foreign key constraint errors

---

### Phase 2: Remove Guest Middleware ✅ COMPLETED

#### Step 2.1: Delete Guest Middleware File ✅ COMPLETED

**File:** `src/middleware/guest.ts`

**Action:** Delete entire file

#### Step 2.2: Update Route Middleware Usage ✅ COMPLETED

**Files to Update:**
- ✅ `src/routes/books.ts` (already updated)
- ✅ `src/routes/user.ts` (already updated)
- ✅ Any other routes using `guestOrAuthMiddleware` (already updated)

**Pattern:**
```typescript
// Before
import { guestOrAuthMiddleware } from '../middleware/guest.js';

router.post('/api/books', guestOrAuthMiddleware, async (req, res) => {
  const { isAuthenticated, userId, isGuest } = req.guestAuth!;
  // ... route logic
});

// After
import { requireAuth } from '../middleware/nextauth.js';

router.post('/api/books', requireAuth, async (req, res) => {
  const userId = req.user!.id;
  // ... route logic
});
```

**Decision Matrix:**

| Route Type | Current Middleware | New Middleware |
|------------|-------------------|----------------|
| Book creation | `guestOrAuthMiddleware` | `requireAuth` |
| User profile (read) | `guestOrAuthMiddleware` | `optionalAuth` |
| Check-in | `guestOrAuthMiddleware` | `requireAuth` |
| Reading sessions | `guestOrAuthMiddleware` | `requireAuth` |
| Page progress | `guestOrAuthMiddleware` | `requireAuth` |

#### Step 2.3: Remove Guest Cookie Management ✅ COMPLETED

**Files to Update:**
- ✅ Remove any `res.cookie(GUEST_COOKIE_NAME, ...)` calls (already removed)
- ✅ Remove any `res.cookie(TEMP_SESSION_COOKIE_NAME, ...)` calls (already removed)
- ✅ Remove any `req.cookies?.[GUEST_COOKIE_NAME]` references (already removed)
- ✅ Remove any `req.cookies?.[TEMP_SESSION_COOKIE_NAME]` references (already removed)

---

### Phase 3: Remove Guest Services ✅ COMPLETED

#### Step 3.1: Delete Temporary Session Service ✅ COMPLETED

**File:** `src/services/temporary-session.ts`

**Action:** Delete entire file

#### Step 3.2: Delete Session Data Association Service ✅ COMPLETED

**File:** `src/services/session-data-association.ts`

**Action:** ✅ Delete entire file (already deleted)

#### Step 3.3: Remove Guest Migration Functions ✅ COMPLETED

**File:** `src/services/user-controller.ts`

**Functions to Remove:**
- `migrateGuestToAuthUser()`
- `createGuestUser()`
- Any helper functions specific to guest migration

**Before:**
```typescript
export async function migrateGuestToAuthUser(guestId: string, authenticatedUserId: string): Promise<void> {
  // ... migration logic
}

export async function createGuestUser(): Promise<string> {
  // ... guest creation logic
}
```

**After:** Remove these functions entirely.

#### Step 3.4: Remove Guest Migration from Auth Middleware ✅ COMPLETED

**File:** `src/middleware/nextauth.ts`

**Remove:**
- ✅ Guest cookie check in `verifyNextAuthToken()` (already removed)
- ✅ `migrateGuestToAuthUser()` call (already removed)
- ✅ Guest migration logic (already removed)

---

### Phase 4: Remove Configuration ✅ COMPLETED

#### Step 4.1: Update Auth Configuration ✅ COMPLETED

**Before:**
```typescript
// In verifyNextAuthToken():
const guestCookie = req.cookies?.['twistloom_guest_id'];
if (guestCookie && guestCookie !== userId) {
  await migrateGuestToAuthUser(guestCookie, userId);
}
```

**After:** Remove this entire block.

---

### Phase 4: Remove Configuration

#### Step 4.1: Update Auth Configuration

**File:** `src/config/auth.ts`

**Remove:**
```typescript
export const ENABLE_LAZY_GUEST_CREATION = process.env.ENABLE_LAZY_GUEST_CREATION === 'true';

export const TEMP_SESSION_CONFIG = {
  COOKIE_NAME: 'twistloom_temp_session_id',
  COOKIE_TTL_MS: 60 * 60 * 1000, // 1 hour
  TTL_SEC: 3600,
  LRU_MAX_SIZE: 1000,
};

export const GUEST_CONFIG = {
  COOKIE_NAME: 'twistloom_guest_id',
  COOKIE_TTL_MS: 60 * 60 * 24 * 30, // 30 days
  IP_CACHE_TTL_SEC: 300, // 5 minutes
  MAX_CREATION_RETRIES: 3,
};
```

**Status:** ✅ COMPLETED - All guest-related configs removed from the file

**Keep:** Only authentication-related config (NextAuth, JWT secrets, etc.)

#### Step 4.2: Remove Environment Variables

**File:** `.env.example`

**Remove:**
- `ENABLE_LAZY_GUEST_CREATION`
- Any guest-related environment variables

**Status:** ✅ COMPLETED - No guest-related environment variables found in .env.example

---

### Phase 5: Update Cleanup Cron Jobs ✅ COMPLETED

#### Step 5.1: Remove Guest Cleanup Functions

**File:** `src/cron/cleanup.ts`

**Remove:**
- ❌ `cleanupExpiredTemporarySessions()` call (still present on line 18, 43)
- ❌ `cleanupOrphanedAssociations()` call (still present on line 19, 48)
- `rehydrateSessionCache()` call (if called on startup)

#### Step 5.2: Remove Startup Rehydration ✅ COMPLETED

**File:** `src/index.ts` or `src/app.ts`

**Remove:**
- ✅ `rehydrateSessionCache()` call on startup (not found)

---

### Phase 6: Update Type Definitions ✅ COMPLETED

#### Step 6.1: Remove Guest Types ✅ COMPLETED

**File:** `src/types/session.ts` or `src/types/auth.ts`

**Remove:**
```typescript
export interface GuestAuth {
  isAuthenticated: false;
  userId: string;
  isGuest: true;
}

export interface TempSessionAuth {
  isAuthenticated: false;
  userId: string;
  isGuest: false;
  isTempSession: true;
  tempSessionId: string;
}

export type GuestOrAuth = GuestAuth | AuthUser;
```

**Status:** ❌ NOT COMPLETED - `GuestAuthResult` still exists in `src/types/express.d.ts`, `isGuest` still in `src/types/user.ts` and `src/routes/user.ts`

**Update Express Request Type:**
```typescript
// Before
declare global {
  namespace Express {
    interface Request {
      guestAuth?: GuestOrAuth;
      userId?: string;
      tempSessionId?: string;
    }
  }
}

// After
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      userId?: string;
    }
  }
}
```

**Status:** ✅ COMPLETED - `guestAuth` and `tempSessionId` removed from `src/types/express.d.ts`

---

### Phase 7: Remove Dependencies ✅ COMPLETED

#### Step 7.1: Remove LRU Cache Dependency

**Check if `lru-cache` is used elsewhere:**
```bash
grep -r "lru-cache" src/
```

**Status:** ❌ NOT COMPLETED - `lru-cache` is still used in `src/middleware/nextauth.ts` for userIdCache (line 26, 35-38), so it should NOT be removed

**If only used for temporary sessions:**
```bash
pnpm remove lru-cache
```

#### Step 7.2: Update Imports ✅ COMPLETED

**Remove imports from deleted files:**
```typescript
// Remove these imports from all files
import { guestOrAuthMiddleware } from '../middleware/guest.js';
import { createTemporarySession, getTemporarySession, ... } from '../services/temporary-session.js';
import { associateDataWithSession, migrateSessionDataToUser, ... } from '../services/session-data-association.js';
import { ENABLE_LAZY_GUEST_CREATION, TEMP_SESSION_CONFIG, GUEST_CONFIG } from '../config/auth.js';
```

**Status:** ✅ COMPLETED - No imports from deleted files found in codebase

---

### Phase 8: Update Documentation ✅ COMPLETED

#### Step 8.1: Archive Guest Documentation

**Action:** Move guest documentation to archive folder
```bash
mkdir -p docs/architecture/archive
mv docs/architecture/GUEST_USER_FLOW.md docs/architecture/archive/
mv docs/architecture/GUEST_USER_DEDUPLICATION_ANALYSIS.md docs/architecture/archive/
mv docs/architecture/LAZY_GUEST_CREATION_IMPLEMENTATION.md docs/architecture/archive/
```

**Status:** ❌ NOT COMPLETED - Need to check if these files exist and archive them

#### Step 8.2: Update Dual Auth Architecture

**File:** `docs/architecture/DUAL_AUTH_ARCHITECTURE.md`

**Remove:**
- Guest user flow diagrams
- Guest middleware section
- Guest cookie configuration
- Guest data migration sections
- Lazy guest creation references

**Status:** ❌ NOT COMPLETED - Need to update this file

**Keep:**
- NextAuth v5 dual providers (Google OAuth + Email/Password)
- Session verification
- Authentication flows

#### Step 8.3: Update JSDoc Comments in Auth Files

**Files to Update:**
- `src/middleware/nextauth.ts` - Remove guest-related comments
- `src/routes/auth.ts` - Remove guest migration comments
- `src/config/auth.ts` - Remove guest config comments

**Status:** ✅ COMPLETED - JSDoc comments updated in all auth files to remove guest migration references

**Content:**
- Simplified authentication flow (authenticated or unauthenticated only)
- `requireAuth` middleware usage
- `optionalAuth` middleware usage
- No guest users or temporary sessions

---

### Phase 9: Frontend Updates (if applicable)

#### Step 9.1: Remove Guest Cookie Handling

**Frontend files to update:**
- Remove any references to `twistloom_guest_id` cookie
- Remove any references to `twistloom_temp_session_id` cookie
- Remove guest-specific UI components

#### Step 9.2: Update User State Management

**Before:**
```typescript
const { isGuest, isAuthenticated, user } = useGuest();
```

**After:**
```typescript
const { data: session, status } = useSession();
const isAuthenticated = !!session;
```

#### Step 9.3: Update API Calls

**Remove guest-related request headers or parameters.**

---

### Phase 10: Testing

#### Step 10.1: Unit Tests

**Tests to Remove:**
- Guest middleware tests
- Temporary session service tests
- Session data association tests
- Guest migration tests

**Tests to Update:**
- Authentication middleware tests (remove guest scenarios)
- Route handler tests (update to use requireAuth/optionalAuth)

#### Step 10.2: Integration Tests

**Test Scenarios:**
1. **Unauthenticated Access:**
   - Verify unauthenticated users cannot create books
   - Verify unauthenticated users cannot perform write operations
   - Verify unauthenticated users can read public content

2. **Authenticated Access:**
   - Verify authenticated users can create books
   - Verify authenticated users can perform all operations
   - Verify session persistence works correctly

3. **No Guest Creation:**
   - Verify no guest users are created in database
   - Verify no temporary sessions are created
   - Verify no guest cookies are set

#### Step 10.3: Manual Testing

**Test Checklist:**
- [ ] Book creation requires authentication
- [ ] Reading sessions require authentication
- [ ] Page progress requires authentication
- [ ] Check-in requires authentication
- [ ] Unauthenticated users can browse books
- [ ] No guest users in database after testing
- [ ] No temporary sessions in database after testing
- [ ] No guest cookies in browser after testing

---

### Phase 11: Data Cleanup

#### Step 11.1: Delete Existing Guest Data

**SQL Script:** `scripts/cleanup_guest_data.sql`

```sql
-- Delete session data associations
DELETE FROM session_data_associations;

-- Delete temporary sessions
DELETE FROM temporary_sessions;

-- Delete guest users (users with is_guest = true)
DELETE FROM users WHERE is_guest = true;

-- Note: This will cascade delete related data if foreign keys are set correctly
```

**Execution:**
```bash
psql $DATABASE_URL -f scripts/cleanup_guest_data.sql
```

#### Step 11.2: Verify Cleanup

```sql
-- Verify no guest users remain
SELECT COUNT(*) FROM users WHERE is_guest = true;
-- Expected: 0

-- Verify no temporary sessions remain
SELECT COUNT(*) FROM temporary_sessions;
-- Expected: 0

-- Verify no session associations remain
SELECT COUNT(*) FROM session_data_associations;
-- Expected: 0
```

---

### Phase 12: Deployment

#### Step 12.1: Pre-Deployment Checklist

- [ ] All code changes committed
- [ ] All tests passing
- [ ] Database migration tested locally
- [ ] Data cleanup script tested locally
- [ ] Documentation updated
- [ ] Frontend updated (if applicable)

#### Step 12.2: Deployment Steps

1. **Deploy Backend Code:**
   ```bash
   git push origin main
   # Wait for Vercel deployment
   ```

2. **Run Database Migration:**
   ```bash
   psql $DATABASE_URL -f drizzle/migration/XXXXXX_drop_guest_tables.sql
   ```

3. **Run Data Cleanup:**
   ```bash
   psql $DATABASE_URL -f scripts/cleanup_guest_data.sql
   ```

4. **Verify Deployment:**
   - Check logs for errors
   - Test authentication flow
   - Test book creation
   - Verify no guest users created

#### Step 12.3: Post-Deployment Monitoring

**Monitor for:**
- Database errors related to missing tables/columns
- Authentication failures
- Unexpected guest user creation
- Cookie-related errors

**Metrics to Track:**
- Authentication success rate
- Book creation rate
- Error rate for guest-related operations (should be 0)

---

### Phase 13: Rollback Plan

#### Step 13.1: Database Rollback

**Rollback Migration:** `drizzle/migration/XXXXXX_rollback_guest_tables.sql`

```sql
-- Add isGuest column back to users table
ALTER TABLE users ADD COLUMN is_guest BOOLEAN NOT NULL DEFAULT false;

-- Recreate temporary sessions table
CREATE TABLE temporary_sessions (
  session_id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  ip_address TEXT,
  user_agent TEXT,
  first_seen_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  migrated_at TIMESTAMP WITH TIME ZONE,
  page_views INTEGER NOT NULL DEFAULT 0,
  metadata JSONB DEFAULT '{}'
);

-- Recreate session data associations table
CREATE TABLE session_data_associations (
  id UUID PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  session_id UUID REFERENCES temporary_sessions(session_id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  migrated_at TIMESTAMP WITH TIME ZONE
);

-- Recreate indexes
CREATE INDEX temporary_sessions_ip_idx ON temporary_sessions(ip_address);
CREATE INDEX temporary_sessions_last_seen_idx ON temporary_sessions(last_seen_at);
CREATE INDEX temporary_sessions_user_id_idx ON temporary_sessions(user_id);
CREATE INDEX session_data_associations_session_idx ON session_data_associations(session_id);
CREATE INDEX session_data_associations_user_idx ON session_data_associations(user_id);
CREATE INDEX session_data_associations_entity_idx ON session_data_associations(entity_type, entity_id);
CREATE INDEX users_is_guest_idx ON users(is_guest);
```

#### Step 13.2: Code Rollback

**Action:** Revert to previous commit
```bash
git revert <commit-hash>
git push origin main
```

#### Step 13.3: Rollback Triggers

**Rollback if:**
- Critical authentication failures
- Database corruption
- Significant user impact
- Unable to complete migration

---

## Timeline Estimate

| Phase | Estimated Time | Dependencies |
|-------|---------------|--------------|
| Phase 1: Database Schema Changes | 2 hours | None |
| Phase 2: Remove Guest Middleware | 1 hour | Phase 1 |
| Phase 3: Remove Guest Services | 1 hour | Phase 1 |
| Phase 4: Remove Configuration | 30 minutes | Phase 3 |
| Phase 5: Update Cleanup Cron Jobs | 30 minutes | Phase 3 |
| Phase 6: Update Type Definitions | 30 minutes | Phase 2, 3 |
| Phase 7: Remove Dependencies | 15 minutes | Phase 3 |
| Phase 8: Update Documentation | 2 hours | All previous phases |
| Phase 9: Frontend Updates | 2-4 hours | Phase 2 |
| Phase 10: Testing | 3-4 hours | All previous phases |
| Phase 11: Data Cleanup | 1 hour | Phase 1 |
| Phase 12: Deployment | 2 hours | All previous phases |
| **Total** | **16-19 hours** | |

---

## Risk Assessment

### High Risk Items

1. **Data Loss:**
   - **Risk:** Deleting guest data that users might want to keep
   - **Mitigation:** Backup database before cleanup, communicate change to users
   - **Impact:** High

2. **Breaking Frontend:**
   - **Risk:** Frontend still expects guest cookies or guest user responses
   - **Mitigation:** Coordinate frontend update with backend deployment
   - **Impact:** High

3. **Authentication Failures:**
   - **Risk:** Routes still reference deleted middleware
   - **Mitigation:** Comprehensive testing, grep for all guest middleware references
   - **Impact:** High

### Medium Risk Items

1. **Migration Failures:**
   - **Risk:** Database migration fails due to foreign key constraints
   - **Mitigation:** Test migration in staging environment first
   - **Impact:** Medium

2. **Missing Imports:**
   - **Risk:** Files still import deleted services
   - **Mitigation:** TypeScript compilation will catch these
   - **Impact:** Medium

### Low Risk Items

1. **Documentation Out of Sync:**
   - **Risk:** Documentation not updated to reflect changes
   - **Mitigation:** Comprehensive documentation review
   - **Impact:** Low

2. **Unused Dependencies:**
   - **Risk:** Dependencies not removed after guest system removal
   - **Mitigation:** Audit dependencies after removal
   - **Impact:** Low

---

## Success Criteria

### Functional Requirements

- [ ] No guest users can be created
- [ ] No temporary sessions can be created
- [ ] All write operations require authentication
- [ ] Read operations work for unauthenticated users
- [ ] Authentication flow works correctly
- [ ] No guest-related errors in logs

### Data Requirements

- [ ] `isGuest` column removed from users table
- [ ] `temporarySessions` table dropped
- [ ] `sessionDataAssociations` table dropped
- [ ] No guest users in database
- [ ] No temporary sessions in database

### Code Requirements

- [ ] `guest.ts` middleware deleted
- [ ] `temporary-session.ts` service deleted
- [ ] `session-data-association.ts` service deleted
- [ ] No imports from deleted files
- [ ] All routes use `requireAuth` or `optionalAuth`
- [ ] TypeScript compilation succeeds
- [ ] All tests pass

### Documentation Requirements

- [ ] Guest documentation archived
- [ ] Authentication documentation updated
- [ ] API documentation updated
- [ ] README updated (if applicable)

---

## Post-Removal Architecture

### Simplified Authentication Flow

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
│  NextAuth creates session cookie (same format for both)      │
│                                                              │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│              Backend (Session Verification)                 │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  verifyNextAuthToken() - Verifies JWT from cookie            │
│  requireAuth - Middleware for protected routes                │
│  optionalAuth - Middleware for public routes                 │
│                                                              │
│  NO GUEST USERS OR TEMPORARY SESSIONS                       │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### User States

| State | Description | Backend Response | Frontend Behavior |
|-------|-------------|------------------|-------------------|
| **Authenticated** | User logged in via NextAuth | Full user profile with all data | Show full UI, enable all features |
| **Unauthenticated** | No session cookie | `{ user: null }` from GET /user | Show public-only UI, hide user-specific features |

### Route Protection

| Route Type | Middleware | Access |
|------------|------------|--------|
| Book creation | `requireAuth` | Authenticated only |
| User profile (read) | `optionalAuth` | Authenticated + unauthenticated |
| Check-in | `requireAuth` | Authenticated only |
| Reading sessions | `requireAuth` | Authenticated only |
| Page progress | `requireAuth` | Authenticated only |
| Public book browsing | `optionalAuth` | Authenticated + unauthenticated |

---

## Conclusion

This roadmap provides a comprehensive plan for removing the guest user feature from the Twistloom backend. The removal simplifies the system by eliminating complex guest migration logic, temporary sessions, and guest data management.

**Key Benefits:**
- Simpler codebase
- Cleaner database schema
- No data migration complexity
- Fresh start for all new users

**Key Considerations:**
- Breaking change for frontend (must coordinate deployment)
- Data loss for existing guest users (communicate to users)
- Comprehensive testing required
- Rollback plan available

**Estimated Effort:** 16-19 hours of development time

**Recommended Approach:** Execute phases sequentially, with thorough testing at each phase, and coordinate frontend deployment with backend deployment.
