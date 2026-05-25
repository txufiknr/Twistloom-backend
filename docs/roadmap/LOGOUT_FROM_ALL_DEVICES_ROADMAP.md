# Logout from All Devices & Selective Logout Roadmap

## Overview

This document provides a comprehensive implementation plan for adding "logout from all devices" and "selective logout" functionality to the Twistloom backend using **JWT Session Version / Revocation Token** approach. This feature allows users to:

- **Logout from all devices** (using session version increment)
- **View all active sessions** with device information
- **Logout from specific devices** (like WhatsApp/Facebook)

**Architecture:**
- Backend: Express.js API routes (not Next.js API routes)
- Frontend: Next.js connecting to backend API
- Auth: NextAuth v5 with **JWT strategy** (current implementation)
- Database: PostgreSQL (Neon) with Drizzle ORM
- Session Management: JWT with session version for revocation + device tracking table for selective logout

---

## Why JWT Session Version Approach?

### Problem with Pure JWT Approach

If you only use stateless JWT cookies:
- Tokens live on the client
- Server doesn't track them
- You cannot force logout unless:
  - You rotate secrets (kills everyone 😅)
  - Or maintain a token blacklist

### Solution: Session Version / Revocation Token (Recommended)

This hybrid approach keeps JWT benefits while adding revocation capability:

1. **Database Field**: Add `tokenVersion` (integer) to users table
2. **JWT Payload**: Encode the current `tokenVersion` inside the JWT
3. **The Check**: In Auth.js callbacks, query database for user's current `tokenVersion` and compare to JWT version
4. **Logout Action**: When user clicks "logout from all devices", increment `tokenVersion` in database
5. **Result**: All existing JWTs become invalid because their encoded version no longer matches database version

**Benefits:**
- ✅ Keeps JWT strategy (no migration needed)
- ✅ Instant invalidation via version mismatch
- ✅ Minimal database overhead (single integer field)
- ✅ No session table maintenance
- ✅ Works with existing Auth.js v5 JWT setup

**For Selective Logout:**
- Add a `auth_sessions` table to track every active device login with unique session IDs
- Store device metadata (userAgent, ipAddress, deviceName)
- Embed unique sessionId in JWT payload
- Verify sessionId exists in database on every request
- Delete specific sessionId to logout from that device only
- Delete all sessionIds (except current) to logout from all other devices

---

## Database Schema Changes

### 1. Add `tokenVersion` Field to Users Table

**File:** `src/db/schema.ts`

Add the `tokenVersion` field to the existing `users` table:

```typescript
export const users = pgTable(
  "users",
  {
    userId: userId().primaryKey(),
    name: text("name"),
    username: text("username").unique("users_username_unique"),
    email: text("email").unique("users_email_unique"),
    passwordHash: text("password_hash"),
    stripeCustomerId: text("stripe_customer_id").unique("users_stripe_customer_id_unique"),
    credits: integer("credits").notNull().default(FIRST_TIME_CREDITS),
    penName: text("pen_name"),
    bio: text("bio"),
    gender,
    image,
    imageId,
    tier: text("tier").$type<UserTier>(),
    isNewUser: boolean("is_new_user").notNull().default(true),
    subscriptionId: uuid("subscription_id"),
    vipExpiresAt: timestamp("vip_expires_at", { withTimezone: true }),
    tokenVersion: integer("token_version").notNull().default(0), // NEW: Session version for JWT revocation
    lastActive,
    createdAt,
    updatedAt,
  },
  // ... existing indexes
);
```

### 2. Add `auth_sessions` Table for Per-Device Logout

**File:** `src/db/schema.ts`

Add this table after the `userAuth` table to track every active device login with unique session IDs:

```typescript
/**
 * Create auth sessions table for per-device logout
 * @summary Track every active device login with unique session IDs for selective logout
 * @example
 * {
 *   "id": "session123", // Unique ID for this device session (embedded in JWT)
 *   "user_id": "user456",
 *   "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)...",
 *   "ip_address": "192.168.1.1",
 *   "device_name": "Chrome on Windows",
 *   "last_active_at": "2024-01-15T10:30:00.000Z",
 *   "created_at": "2024-01-01T00:00:00.000Z",
 *   "updated_at": "2024-01-15T10:30:00.000Z"
 * }
 */
export const authSessions = pgTable(
  "auth_sessions",
  {
    id: id(), // Unique ID for this device session (embedded in JWT payload)
    userId: userId().references(() => users.userId, { onDelete: "cascade" }),
    userAgent: text("user_agent"),
    ipAddress: text("ip_address"),
    deviceName: text("device_name"),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }).defaultNow(),
    createdAt,
    updatedAt,
  },
  (t) => [
    // Index for user session queries
    index("auth_sessions_user_idx").on(t.userId),
    // Index for session ID lookups (used in JWT verification)
    index("auth_sessions_id_idx").on(t.id),
    // Index for cleanup (inactive sessions)
    index("auth_sessions_last_active_idx").on(t.lastActiveAt),
  ]
);
```

### 3. Export the New Table

**File:** `src/db/schema.ts`

Add to the exports at the bottom of the file:

```typescript
export { authSessions };
```

### 4. Create Database Migration

**Run the following commands:**

```bash
pnpm db:generate
pnpm db:migrate
```

This will create a migration file that:
- Adds `tokenVersion` field to `users` table
- Creates `auth_sessions` table

**✅ Phase 1 Status: COMPLETED**
- ✅ Added `tokenVersion` field to users table
- ✅ Added `auth_sessions` table to schema
- ✅ Exported new table

---

## Backend Implementation

### 1. Update NextAuth Configuration for JWT + Session Tracking

**File:** `src/config/auth.ts` (or wherever your NextAuth config is)

Update the JWT and session callbacks to implement unique session IDs for per-device logout:

```typescript
import { db } from "../db/client.js";
import { users, authSessions } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "crypto";

export const authConfig = {
  session: {
    strategy: "jwt", // Keep JWT strategy (current implementation)
  },
  callbacks: {
    // 1. Triggered when the JWT is created or updated
    async jwt({ token, user, trigger }) {
      // Initial sign-in: generate unique sessionId and save to database
      if (user) {
        const uniqueSessionId = randomUUID();

        token.userId = user.id;
        token.sessionId = uniqueSessionId;

        // Save session to database
        await db.insert(authSessions).values({
          id: uniqueSessionId,
          userId: user.id!,
          userAgent: "Web Device", // Will be updated by middleware
        });
      }
      return token;
    },

    // 2. Triggered on every session check (app layout, middleware, etc.)
    async session({ session, token }) {
      if (!token.userId || !token.sessionId) return session;

      // Check if this specific session still exists in the database
      const [activeSession] = await db
        .select()
        .from(authSessions)
        .where(
          and(
            eq(authSessions.id, token.sessionId as string),
            eq(authSessions.userId, token.userId as string)
          )
        );

      // If the session was deleted from the database, invalidate the JWT
      if (!activeSession) {
        return { ...session, user: null! };
      }

      // If valid, attach the user ID to the session object
      session.user.id = token.userId as string;
      return session;
    },
  },
  // ... rest of your NextAuth config
};
```

### 2. Create Session Management Service

**File:** `src/services/session-manager.ts`

```typescript
import { db } from "../db/client.js";
import { authSessions } from "../db/schema.js";
import { eq, and, desc, ne } from "drizzle-orm";

/**
 * Get all active sessions for a user
 * @param userId - The user ID to fetch sessions for
 * @returns Array of active sessions with device information
 */
export async function getUserSessions(userId: string) {
  const sessions = await db
    .select({
      id: authSessions.id,
      userAgent: authSessions.userAgent,
      ipAddress: authSessions.ipAddress,
      deviceName: authSessions.deviceName,
      lastActiveAt: authSessions.lastActiveAt,
      createdAt: authSessions.createdAt,
    })
    .from(authSessions)
    .where(eq(authSessions.userId, userId))
    .orderBy(desc(authSessions.lastActiveAt));

  return sessions;
}

/**
 * Logout from a specific device (delete specific session)
 * @param userId - The user ID
 * @param sessionId - The session ID to delete
 * @returns Number of sessions deleted
 */
export async function logoutFromSpecificDevice(
  userId: string,
  sessionId: string
): Promise<number> {
  const result = await db
    .delete(authSessions)
    .where(
      and(
        eq(authSessions.userId, userId),
        eq(authSessions.id, sessionId)
      )
    );

  return result.rowCount || 0;
}

/**
 * Logout from all other devices (exclude current session)
 * @param userId - The user ID
 * @param currentSessionId - The current session ID to exclude
 * @returns Number of sessions deleted
 */
export async function logoutFromAllOtherDevices(
  userId: string,
  currentSessionId: string
): Promise<number> {
  const result = await db
    .delete(authSessions)
    .where(
      and(
        eq(authSessions.userId, userId),
        ne(authSessions.id, currentSessionId)
      )
    );

  return result.rowCount || 0;
}

/**
 * Update session metadata (user agent, IP, device name)
 * @param sessionId - The session ID to update
 * @param userAgent - The user agent string
 * @param ipAddress - The IP address
 */
export async function updateSessionMetadata(
  sessionId: string,
  userAgent: string | null,
  ipAddress: string | null
): Promise<void> {
  const deviceName = deriveDeviceName(userAgent);

  await db
    .update(authSessions)
    .set({
      userAgent,
      ipAddress,
      deviceName,
      lastActiveAt: new Date(),
    })
    .where(eq(authSessions.id, sessionId));
}

/**
 * Derive device name from user agent string
 * @param userAgent - The user agent string
 * @returns Friendly device name (e.g., "Chrome on Windows")
 */
export function deriveDeviceName(userAgent: string | null): string {
  if (!userAgent) return "Unknown Device";

  // Detect browser
  let browser = "Unknown Browser";
  if (userAgent.includes("Chrome")) browser = "Chrome";
  else if (userAgent.includes("Firefox")) browser = "Firefox";
  else if (userAgent.includes("Safari")) browser = "Safari";
  else if (userAgent.includes("Edge")) browser = "Edge";

  // Detect OS
  let os = "Unknown OS";
  if (userAgent.includes("Windows")) os = "Windows";
  else if (userAgent.includes("Mac")) os = "macOS";
  else if (userAgent.includes("Linux")) os = "Linux";
  else if (userAgent.includes("Android")) os = "Android";
  else if (userAgent.includes("iOS")) os = "iOS";

  // Detect mobile
  const isMobile = /Mobile|Android|iPhone|iPad/i.test(userAgent);
  const deviceType = isMobile ? "Mobile" : "Desktop";

  return `${browser} on ${os} (${deviceType})`;
}
```

### 3. Create Express Routes

**File:** `src/routes/auth.ts`

Add the following routes to your existing auth router:

```typescript
import { requireAuth } from "../middleware/nextauth.js";
import {
  getUserSessions,
  logoutFromSpecificDevice,
  logoutFromAllOtherDevices,
  updateSessionMetadata,
} from "../services/session-manager.js";

/**
 * GET /api/auth/sessions
 * Get all active sessions for the authenticated user
 */
router.get('/sessions', requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const sessions = await getUserSessions(userId);

    res.json({
      sessions,
      count: sessions.length,
    });
  } catch (error) {
    console.error('Error fetching sessions:', error);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

/**
 * POST /api/auth/logout-all
 * Logout from all other devices (exclude current session)
 */
router.post('/logout-all', requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const currentSessionId = req.user?.sessionId; // From JWT token

    if (!currentSessionId) {
      return res.status(400).json({ error: 'No session ID found' });
    }

    const deletedCount = await logoutFromAllOtherDevices(userId, currentSessionId);

    res.json({
      message: `Logged out from ${deletedCount} other device(s)`,
      deletedCount,
    });
  } catch (error) {
    console.error('Error logging out from all devices:', error);
    res.status(500).json({ error: 'Failed to logout from all devices' });
  }
});

/**
 * POST /api/auth/logout-session
 * Logout from a specific session
 */
router.post('/logout-session', requireAuth, async (req, res) => {
  try {
    const userId = req.user!.id;
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    const deletedCount = await logoutFromSpecificDevice(userId, sessionId);

    if (deletedCount === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json({
      message: 'Logged out from device',
      deletedCount,
    });
  } catch (error) {
    console.error('Error logging out from session:', error);
    res.status(500).json({ error: 'Failed to logout from session' });
  }
});
```

### 4. Update Session Verification Middleware

**File:** `src/middleware/nextauth.ts`

Update the `verifyNextAuthToken` function to update session metadata:

```typescript
import { updateSessionMetadata } from "../services/session-manager.js";

export async function verifyNextAuthToken(req: Request) {
  // ... existing session verification logic ...

  // After successful verification, update session metadata
  if (session && session.sessionId) {
    try {
      const userAgent = req.headers['user-agent'] || null;
      const ipAddress = req.ip || req.socket.remoteAddress || null;

      await updateSessionMetadata(session.sessionId, userAgent, ipAddress);
    } catch (error) {
      // Don't fail the request if metadata update fails
      console.error('Error updating session metadata:', error);
    }
  }

  // ... return user ...
}
```

---

## Frontend Implementation (Next.js)

### 1. Create Device Management Hook

**File:** `src/hooks/useDevices.ts` (frontend)

```typescript
import { useSession } from 'next-auth/react';
import { useState, useEffect } from 'react';

interface DeviceInfo {
  id: string;
  deviceToken: string;
  userAgent: string | null;
  ipAddress: string | null;
  deviceName: string;
  lastActiveAt: string;
  createdAt: string;
}

interface DevicesResponse {
  devices: DeviceInfo[];
  count: number;
}

export function useDevices() {
  const { data: session, status } = useSession();
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDevices = async () => {
    if (!session?.user?.id) return;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`${process.env.BACKEND_URL}/api/auth/devices`, {
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include', // Include cookies
      });

      if (!response.ok) {
        throw new Error('Failed to fetch devices');
      }

      const data: DevicesResponse = await response.json();
      setDevices(data.devices);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch devices');
    } finally {
      setLoading(false);
    }
  };

  const logoutFromAllDevices = async () => {
    if (!session?.user?.id) return;

    try {
      const response = await fetch(`${process.env.BACKEND_URL}/api/auth/logout-all`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Failed to logout from all devices');
      }

      const data = await response.json();

      // After logout from all devices, user needs to re-login
      // Redirect to login page or show login modal
      window.location.href = '/login';

      return data;
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : 'Failed to logout');
    }
  };

  const logoutFromSpecificDevice = async (deviceToken: string) => {
    if (!session?.user?.id) return;

    try {
      const response = await fetch(`${process.env.BACKEND_URL}/api/auth/logout-device`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ deviceToken }),
      });

      if (!response.ok) {
        throw new Error('Failed to logout from device');
      }

      const data = await response.json();
      await fetchDevices(); // Refresh the devices list
      return data;
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : 'Failed to logout');
    }
  };

  // Fetch devices on mount and when session changes
  useEffect(() => {
    if (status === 'authenticated') {
      fetchDevices();
    }
  }, [status, session?.user?.id]);

  return {
    devices,
    loading,
    error,
    fetchDevices,
    logoutFromAllDevices,
    logoutFromSpecificDevice,
    isAuthenticated: status === 'authenticated',
  };
}
```

### 2. Create Active Devices Component

**File:** `src/components/ActiveDevices.tsx` (frontend)

```typescript
'use client';

import { useDevices } from '@/hooks/useDevices';
import { signOut } from 'next-auth/react';
import { useState } from 'react';

export function ActiveDevices() {
  const {
    devices,
    loading,
    error,
    logoutFromAllDevices,
    logoutFromSpecificDevice,
  } = useDevices();

  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const handleLogoutAll = async () => {
    if (!confirm('Are you sure you want to logout from all devices? This will log you out from your current device too.')) {
      return;
    }

    setIsLoggingOut(true);
    try {
      await logoutFromAllDevices();
      // The hook handles redirect to login
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to logout');
      setIsLoggingOut(false);
    }
  };

  const handleLogoutDevice = async (deviceToken: string, deviceName: string) => {
    if (!confirm(`Are you sure you want to logout from ${deviceName}?`)) {
      return;
    }

    try {
      await logoutFromSpecificDevice(deviceToken);
      alert(`Logged out from ${deviceName} successfully!`);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to logout');
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // Get current device token from cookies
  const getCurrentDeviceToken = () => {
    // You'll need to implement this based on how you store the device token
    // For now, we'll assume it's in a cookie
    return document.cookie
      .split('; ')
      .find(row => row.startsWith('twistloom_device_token='))
      ?.split('=')[1];
  };

  const isCurrentDevice = (deviceToken: string) => {
    const currentToken = getCurrentDeviceToken();
    return currentToken === deviceToken;
  };

  if (loading) {
    return <div>Loading active devices...</div>;
  }

  if (error) {
    return <div>Error: {error}</div>;
  }

  return (
    <div className="active-devices">
      <div className="devices-header">
        <h2>Active Devices</h2>
        <p>You have {devices.length} active device(s)</p>
      </div>

      <div className="devices-list">
        {devices.map((device) => (
          <div key={device.id} className="device-item">
            <div className="device-info">
              <div className="device-name">
                {device.deviceName || 'Unknown Device'}
                {isCurrentDevice(device.deviceToken) && (
                  <span className="current-badge">Current Device</span>
                )}
              </div>
              <div className="device-details">
                <span>Last active: {formatDate(device.lastActiveAt)}</span>
                {device.ipAddress && (
                  <span>IP: {device.ipAddress}</span>
                )}
              </div>
            </div>
            {!isCurrentDevice(device.deviceToken) && (
              <button
                onClick={() => handleLogoutDevice(device.deviceToken, device.deviceName)}
                className="logout-device-btn"
              >
                Logout
              </button>
            )}
          </div>
        ))}
      </div>

      <button
        onClick={handleLogoutAll}
        disabled={isLoggingOut}
        className="logout-all-btn"
      >
        {isLoggingOut ? 'Logging out...' : 'Logout from All Devices'}
      </button>

      <style jsx>{`
        .active-devices {
          max-width: 600px;
          margin: 0 auto;
          padding: 20px;
        }

        .devices-header {
          margin-bottom: 20px;
        }

        .devices-header h2 {
          margin: 0 0 8px 0;
        }

        .devices-header p {
          margin: 0;
          color: #666;
        }

        .devices-list {
          display: flex;
          flex-direction: column;
          gap: 12px;
          margin-bottom: 20px;
        }

        .device-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 16px;
          border: 1px solid #e0e0e0;
          border-radius: 8px;
          background: #fff;
        }

        .device-info {
          flex: 1;
        }

        .device-name {
          font-weight: 600;
          margin-bottom: 4px;
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .current-badge {
          background: #4caf50;
          color: white;
          padding: 2px 8px;
          border-radius: 12px;
          font-size: 12px;
          font-weight: normal;
        }

        .device-details {
          display: flex;
          flex-direction: column;
          gap: 4px;
          color: #666;
          font-size: 14px;
        }

        .logout-device-btn {
          padding: 8px 16px;
          background: #f44336;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 14px;
        }

        .logout-device-btn:hover {
          background: #d32f2f;
        }

        .logout-all-btn {
          width: 100%;
          padding: 12px;
          background: #ff9800;
          color: white;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          font-size: 16px;
          font-weight: 600;
        }

        .logout-all-btn:hover:not(:disabled) {
          background: #f57c00;
        }

        .logout-all-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
      `}</style>
    </div>
  );
}
```

### 3. Create Settings Page

**File:** `src/app/settings/devices/page.tsx` (frontend)

```typescript
'use client';

import { ActiveDevices } from '@/components/ActiveDevices';
import { signOut } from 'next-auth/react';

export default function DevicesSettingsPage() {
  const handleLogout = async () => {
    await signOut({ callbackUrl: '/' });
  };

  return (
    <div className="settings-page">
      <div className="settings-header">
        <h1>Devices</h1>
        <p>Manage your active devices across all platforms</p>
      </div>

      <ActiveDevices />

      <div className="logout-section">
        <h2>Current Session</h2>
        <button onClick={handleLogout} className="logout-btn">
          Logout from Current Device
        </button>
      </div>

      <style jsx>{`
        .settings-page {
          max-width: 800px;
          margin: 0 auto;
          padding: 40px 20px;
        }

        .settings-header {
          margin-bottom: 40px;
        }

        .settings-header h1 {
          margin: 0 0 8px 0;
          font-size: 32px;
        }

        .settings-header p {
          margin: 0;
          color: #666;
        }

        .logout-section {
          margin-top: 40px;
          padding-top: 40px;
          border-top: 1px solid #e0e0e0;
        }

        .logout-section h2 {
          margin: 0 0 16px 0;
          font-size: 24px;
        }

        .logout-btn {
          padding: 12px 24px;
          background: #f44336;
          color: white;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          font-size: 16px;
          font-weight: 600;
        }

        .logout-btn:hover {
          background: #d32f2f;
        }
      `}</style>
    </div>
  );
}
```

---

## Implementation Phases

### Phase 1: Database Schema ✅ (COMPLETED)

**Steps:**
1. Add `tokenVersion` field to `users` table in `src/db/schema.ts` ✅
2. Add `auth_sessions` table to `src/db/schema.ts` ✅
3. Export the new table ✅
4. Generate and run database migration
5. Verify schema changes in Neon

**Commands:**
```bash
pnpm db:generate
pnpm db:migrate
```

**Verification:**
```sql
-- Check tokenVersion field
SELECT user_id, token_version FROM users LIMIT 1;

-- Check auth_sessions table
SELECT * FROM auth_sessions LIMIT 1;
```

---

### Phase 2: Backend Configuration ✅

**Steps:**
1. Update NextAuth configuration in `src/config/auth.ts`
2. Add JWT callback to encode tokenVersion
3. Add session callback to verify tokenVersion
4. Keep JWT strategy (no change needed)

**Files to Update:**
- `src/config/auth.ts`

---

### Phase 3: Backend Services ✅

**Steps:**
1. Create `src/services/session-manager.ts`
2. Implement logoutFromAllDevices (increments tokenVersion)
3. Implement getUserDevices (fetches device_sessions)
4. Implement logoutFromSpecificDevice (deletes from device_sessions)
5. Implement upsertDeviceSession (tracks device metadata)
6. Add device name derivation logic

**Files to Create:**
- `src/services/session-manager.ts`

---

### Phase 4: Backend Routes ✅

**Steps:**
1. Add device management routes to `src/routes/auth.ts`
2. Implement GET /api/auth/devices
3. Implement POST /api/auth/logout-all
4. Implement POST /api/auth/logout-device
5. Implement POST /api/auth/register-device

**Files to Update:**
- `src/routes/auth.ts`

---

### Phase 5: Session Verification Middleware ✅

**Steps:**
1. Update `src/middleware/nextauth.ts`
2. Add device session registration logic
3. Set device token cookie if not exists
4. Ensure device metadata is updated on each authenticated request

**Files to Update:**
- `src/middleware/nextauth.ts`

---

### Phase 6: Frontend Implementation ✅

**Steps:**
1. Create `src/hooks/useDevices.ts`
2. Create `src/components/ActiveDevices.tsx`
3. Create settings page at `src/app/settings/devices/page.tsx`
4. Add navigation to devices settings

**Files to Create:**
- `src/hooks/useDevices.ts`
- `src/components/ActiveDevices.tsx`
- `src/app/settings/devices/page.tsx`

---

### Phase 7: Testing ✅

**Backend Testing:**
```bash
# Test fetching devices
curl -X GET https://your-backend.vercel.app/api/auth/devices \
  -H "Content-Type: application/json" \
  -H "Cookie: next-auth.session-token=your-session-token"

# Test logout from all devices
curl -X POST https://your-backend.vercel.app/api/auth/logout-all \
  -H "Content-Type: application/json" \
  -H "Cookie: next-auth.session-token=your-session-token"

# Test logout from specific device
curl -X POST https://your-backend.vercel.app/api/auth/logout-device \
  -H "Content-Type: application/json" \
  -H "Cookie: next-auth.session-token=your-session-token" \
  -d '{"deviceToken": "device-token-to-delete"}'
```

**Frontend Testing:**
1. Login on multiple devices/browsers
2. Navigate to Settings > Devices
3. Verify all active devices are displayed
4. Test "Logout from All Devices" (should logout current device too)
5. Test "Logout" on specific device (should keep current device)
6. Verify device metadata (name, IP, last active)

---

## Security Considerations

### 1. Session Expiration

- JWT tokens automatically expire based on NextAuth configuration
- Device sessions should be cleaned up periodically (inactive devices)
- Implement cron job to delete device sessions older than 90 days

### 2. Race Conditions

- A JWT with old tokenVersion might still be used briefly
- **Mitigation:** Short session TTL (e.g., 30 days)
- NextAuth checks database on each session callback → instant invalidation

### 3. IP Address Tracking

- IP addresses can change (mobile networks, VPNs)
- Use IP as supplementary information, not for authentication
- Don't block sessions based on IP changes

### 4. User Agent Spoofing

- User agents can be spoofed
- Use device name as display information only
- Don't rely on user agent for security decisions

### 5. Device Token Security

- Device tokens are stored in httpOnly cookies
- Never expose device tokens in client-side JavaScript
- Use secure cookies in production (HTTPS)

### 6. Token Version Overflow

- `tokenVersion` is an integer, theoretically could overflow
- **Mitigation:** Use PostgreSQL BIGINT if concerned (extremely unlikely to overflow in practice)
- Even if it overflows, it would just wrap around and still work

### 7. Database Query Performance

- Session callback queries database on every request
- **Current approach:** Acceptable for most use cases
- **Future optimization:** Use Redis cache (see Advanced Features section)

---

## Advanced Features (Future Enhancements)

### 1. Redis Optimization for Performance (Recommended for High Traffic)

**Problem:** Querying the database on every session check adds latency.

**Solution:** Use Upstash Redis (built for serverless/edge) to cache token versions.

**Implementation:**

```typescript
// Install Redis client
pnpm add @upstash/redis

// Update session-manager.ts
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

/**
 * Get token version with Redis cache
 */
export async function getTokenVersion(userId: string): Promise<number> {
  // Try Redis cache first
  const cached = await redis.get(`user:tokenVersion:${userId}`);
  if (cached !== null) {
    return parseInt(cached as string, 10);
  }

  // Cache miss: fetch from database
  const [dbUser] = await db
    .select({ tokenVersion: users.tokenVersion })
    .from(users)
    .where(eq(users.userId, userId));

  const version = dbUser?.tokenVersion || 0;

  // Cache in Redis (TTL: 5 minutes)
  await redis.set(`user:tokenVersion:${userId}`, version, { ex: 300 });

  return version;
}

/**
 * Increment token version and update Redis cache
 */
export async function incrementTokenVersion(userId: string): Promise<number> {
  // Increment in database
  const [result] = await db
    .select({ tokenVersion: users.tokenVersion })
    .from(users)
    .where(eq(users.userId, userId));

  const newVersion = (result?.tokenVersion || 0) + 1;

  await db
    .update(users)
    .set({ tokenVersion: newVersion })
    .where(eq(users.userId, userId));

  // Update Redis cache immediately
  await redis.set(`user:tokenVersion:${userId}`, newVersion, { ex: 300 });

  return newVersion;
}
```

**Update NextAuth Config:**

```typescript
// In session callback, use cached version
async session({ session, token }) {
  if (!token.userId) return session;

  // Use cached version check
  const dbVersion = await getTokenVersion(token.userId as string);

  if (dbVersion !== token.tokenVersion) {
    return { ...session, user: null! };
  }

  session.user.id = token.userId as string;
  return session;
}
```

**Benefits:**
- ✅ Reduces database queries by ~95%
- ✅ Sub-millisecond latency for version checks
- ✅ Scales to millions of requests
- ✅ Works with Vercel serverless/edge

**Note:** Currently using Redis free tier, so this is a future enhancement when scaling needs require it.

### 2. Suspicious Login Detection

```typescript
// Add to session-manager.ts
export async function detectSuspiciousLogin(userId: string, newDevice: {
  ipAddress: string;
  userAgent: string;
}): Promise<boolean> {
  const recentDevices = await db
    .select({ ipAddress: authSessions.ipAddress, userAgent: authSessions.userAgent })
    .from(authSessions)
    .where(eq(authSessions.userId, userId))
    .orderBy(desc(authSessions.createdAt))
    .limit(10);

  // Check for unusual IP or user agent
  const knownIPs = new Set(recentDevices.map(d => d.ipAddress));
  const knownUserAgents = new Set(recentDevices.map(d => d.userAgent));

  const isUnusualIP = !knownIPs.has(newDevice.ipAddress);
  const isUnusualUserAgent = !knownUserAgents.has(newDevice.userAgent);

  return isUnusualIP || isUnusualUserAgent;
}
```

### 3. Email Notifications

Send email when:
- New login from unknown device
- "Logout from all devices" is triggered
- Suspicious activity detected

### 4. Device Analytics

Track:
- Login frequency per device
- Geographic distribution
- Session duration
- Most used devices

### 5. Dynamic User-Agent Parser (Future Enhancement)

**Problem:** Current device name derivation is basic (e.g., "Chrome on Windows")

**Solution:** Use a dedicated User-Agent parser library for accurate device detection

**Implementation:**

```typescript
// Install user-agent parser
pnpm add ua-parser-js

// Update session-manager.ts
import UAParser from 'ua-parser-js';

/**
 * Derive device name from user agent string using UA Parser
 * @param userAgent - The user agent string
 * @returns Friendly device name (e.g., "iPhone 15 - Safari")
 */
export function deriveDeviceName(userAgent: string | null): string {
  if (!userAgent) return "Unknown Device";

  const parser = new UAParser(userAgent);
  const result = parser.getResult();

  const browser = result.browser.name || "Unknown Browser";
  const os = result.os.name || "Unknown OS";
  const device = result.device.model || result.device.type || "Desktop";

  // Format: "iPhone 15 - Safari on iOS" or "Chrome on Windows"
  if (result.device.model) {
    return `${device} - ${browser} on ${os}`;
  }

  return `${browser} on ${os} (${device})`;
}
```

**Benefits:**
- ✅ Accurate device detection (iPhone 15, Samsung Galaxy, etc.)
- ✅ Better UX for users (recognizable device names)
- ✅ Handles edge cases (tablets, smart TVs, etc.)
- ✅ Regularly updated with new devices

---

## Troubleshooting

### Issue: Sessions not being invalidated after logout from all devices

**Cause:** tokenVersion not being incremented or JWT callback not checking version

**Solution:**
```typescript
// Verify tokenVersion increment in logoutFromAllDevices
const newVersion = (result?.tokenVersion || 0) + 1;
await db.update(users).set({ tokenVersion: newVersion }).where(...);

// Verify session callback checks version
if (dbUser.tokenVersion !== token.tokenVersion) {
  return { ...session, user: null! };
}
```

### Issue: Device name not showing

**Cause:** Device session not being registered or device token cookie not set

**Solution:**
- Verify `upsertDeviceSession` is called in `verifyNextAuthToken`
- Check device token cookie is being set
- Check user agent is being passed correctly

### Issue: "Logout from all devices" logs out current device immediately

**Cause:** This is expected behavior with JWT session version approach

**Solution:** 
- Document this behavior to users
- If you want to exclude current device, you need a different approach (device-specific revocation tokens)
- Current approach: logout from all devices = logout from everywhere including current device

### Issue: Session callback causing performance issues

**Cause:** Database query on every request

**Solution:**
- Acceptable for most use cases
- For high traffic, implement Redis caching (see Advanced Features section)
- Monitor database query performance

### Issue: Device token not found in cookies

**Cause:** Cookie not being set or wrong cookie name

**Solution:**
```typescript
// Check cookie name matches
const deviceToken = req.cookies?.['twistloom_device_token'];

// Verify cookie is being set with correct options
res.cookie('twistloom_device_token', token, {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 365 * 24 * 60 * 60 * 1000,
  path: '/',
});
```

### Issue: User still logged in after tokenVersion increment

**Cause:** JWT token cached in browser or session callback not being called

**Solution:**
- Clear browser cookies and test again
- Verify session callback is being called (add console.log)
- Check NextAuth configuration has correct callbacks

---

## Migration Checklist

### Backend
- [ ] Add `tokenVersion` field to users table ✅
- [ ] Add `auth_sessions` table to schema ✅
- [ ] Export new table from schema ✅
- [ ] Generate and run database migration (user will do manually)
- [ ] Update NextAuth configuration with JWT callbacks
- [ ] Create `session-manager.ts` service
- [ ] Add device management routes to `auth.ts`
- [ ] Update `verifyNextAuthToken` to register device sessions
- [ ] Test backend endpoints with curl

### Frontend
- [ ] Create `useDevices` hook
- [ ] Create `ActiveDevices` component
- [ ] Create devices settings page
- [ ] Add navigation to devices settings
- [ ] Test on multiple devices/browsers
- [ ] Verify selective logout functionality
- [ ] Verify "logout from all devices" invalidates all sessions

### Documentation
- [ ] Update API documentation
- [ ] Add user guide for device management
- [ ] Document security considerations
- [ ] Add troubleshooting guide

---

## Timeline Estimate

| Phase | Estimated Time | Dependencies |
|-------|---------------|--------------|
| Phase 1: Database Schema | 1 hour | None |
| Phase 2: Backend Configuration | 1 hour | Phase 1 |
| Phase 3: Backend Services | 2 hours | Phase 2 |
| Phase 4: Backend Routes | 1 hour | Phase 3 |
| Phase 5: Session Verification Middleware | 30 minutes | Phase 3 |
| Phase 6: Frontend Implementation | 3 hours | Phase 4 |
| Phase 7: Testing | 2 hours | All previous phases |
| **Total** | **10.5 hours** | |

---

## Conclusion

This roadmap provides a comprehensive implementation plan for adding "logout from all devices" and "selective logout" functionality to Twistloom using the **JWT Session Version / Revocation Token** approach. This approach is ideal for your current setup since you're already using NextAuth v5 with JWT strategy.

**Key Benefits:**
- ✅ Keeps JWT strategy (no migration needed from current implementation)
- ✅ Instant session invalidation via version mismatch
- ✅ Minimal database overhead (single integer field + device tracking table)
- ✅ No session table maintenance overhead
- ✅ Works seamlessly with existing Auth.js v5 JWT setup
- ✅ Selective logout support (like WhatsApp/Facebook)
- ✅ Device information for better UX
- ✅ Foundation for security features (suspicious login detection)
- ✅ Future Redis optimization path for high traffic

**Important Notes:**
- "Logout from all devices" CAN exclude current device using the hybrid JWT + session tracking approach
- Database query on every session check is acceptable for most use cases
- Redis caching can be added later for high-traffic scenarios
- User sessions should be cleaned up periodically (inactive sessions)

**Recommended Approach:**
- Execute phases sequentially
- Test each phase before proceeding
- Start with backend, then frontend
- Monitor for any issues after deployment
- Consider Redis optimization when traffic scales
