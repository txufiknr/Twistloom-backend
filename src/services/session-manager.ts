/**
 * Session Management Service
 * 
 * Provides functions for managing user sessions and device tracking
 * for "logout from all devices" and "selective logout" functionality.
 * 
 * Architecture:
 * - Uses auth_sessions table to track every active device login
 * - Each session has a unique ID embedded in the JWT payload
 * - Sessions can be selectively revoked by deleting from the database
 * - Uses LRU cache to reduce database queries for session verification
 * 
 * @example
 * ```typescript
 * import { getUserSessions, logoutFromSpecificDevice } from './session-manager.js';
 * 
 * const sessions = await getUserSessions(userId);
 * await logoutFromSpecificDevice(userId, sessionId);
 * ```
 */

import { db } from '../db/client.js';
import { authSessions, users } from '../db/schema.js';
import { eq, and, desc, ne, sql } from 'drizzle-orm';
import { LRUCache } from 'lru-cache';
import { UAParser } from 'ua-parser-js';

/**
 * LRU cache for session ID existence checks
 * 
 * Caches session ID lookups to reduce database query overhead.
 * Uses a maximum of 5000 entries with a 10-minute TTL.
 * 
 * Note: This is a partial implementation of Redis optimization using LRU cache.
 * For high-traffic production environments, consider migrating to Upstash Redis
 * for distributed caching across multiple server instances.
 */
const sessionCache = new LRUCache<string, boolean>({
  max: 5000,
  ttl: 10 * 60 * 1000, // 10 minutes
});

/**
 * Check if a session exists (with LRU cache optimization)
 * @param sessionId - The session ID to check
 * @returns True if session exists, false otherwise
 * 
 * @example
 * ```typescript
 * const exists = await sessionExists('session456');
 * if (!exists) {
 *   // Session was revoked
 * }
 * ```
 */
export async function sessionExists(sessionId: string): Promise<boolean> {
  // Check cache first
  const cached = sessionCache.get(sessionId);
  if (cached !== undefined) {
    return cached;
  }

  // Cache miss: query database
  const [session] = await db
    .select({ id: authSessions.id })
    .from(authSessions)
    .where(eq(authSessions.id, sessionId))
    .limit(1);

  const exists = !!session;

  // Cache the result
  sessionCache.set(sessionId, exists);

  return exists;
}

/**
 * Invalidate session cache entry
 * @param sessionId - The session ID to invalidate
 * 
 * @example
 * ```typescript
 * invalidateSessionCache('session456');
 * ```
 */
export function invalidateSessionCache(sessionId: string): void {
  sessionCache.delete(sessionId);
}

/**
 * Get all active sessions for a user
 * @param userId - The user ID to fetch sessions for
 * @param currentSessionId - The current session ID to mark as isCurrent
 * @returns Array of active sessions with device information and isCurrent flag
 * 
 * @example
 * ```typescript
 * const sessions = await getUserSessions('user123', 'currentSessionId');
 * console.log(`User has ${sessions.length} active sessions`);
 * ```
 */
export async function getUserSessions(userId: string, currentSessionId?: string) {
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

  return sessions.map(session => ({
    ...session,
    isCurrent: currentSessionId ? session.id === currentSessionId : false,
  }));
}

/**
 * Logout from a specific device (delete specific session)
 * @param userId - The user ID
 * @param sessionId - The session ID to delete
 * @returns Number of sessions deleted
 * 
 * @example
 * ```typescript
 * const deletedCount = await logoutFromSpecificDevice('user123', 'session456');
 * console.log(`Logged out from ${deletedCount} device(s)`);
 * ```
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

  // Invalidate cache for this session
  invalidateSessionCache(sessionId);

  return result.rowCount || 0;
}

/**
 * Logout from all other devices (exclude current session)
 * @param userId - The user ID
 * @param currentSessionId - The current session ID to exclude
 * @returns Number of sessions deleted
 * 
 * @example
 * ```typescript
 * const deletedCount = await logoutFromAllOtherDevices('user123', 'currentSession789');
 * console.log(`Logged out from ${deletedCount} other device(s)`);
 * ```
 */
export async function logoutFromAllOtherDevices(
  userId: string,
  currentSessionId: string
): Promise<number> {
  // Get all sessions to invalidate cache
  const allSessions = await db
    .select({ id: authSessions.id })
    .from(authSessions)
    .where(eq(authSessions.userId, userId));

  // Delete all sessions except current
  const result = await db
    .delete(authSessions)
    .where(
      and(
        eq(authSessions.userId, userId),
        ne(authSessions.id, currentSessionId)
      )
    );

  // Invalidate cache for all deleted sessions
  for (const session of allSessions) {
    if (session.id !== currentSessionId) {
      invalidateSessionCache(session.id);
    }
  }

  return result.rowCount || 0;
}

/**
 * Logout from all devices (including current) by deleting every session and
 * incrementing `tokenVersion` to invalidate all existing JWTs.
 * @param userId - The user ID
 * @returns Total number of sessions deleted
 *
 * @example
 * ```typescript
 * const deletedCount = await logoutFromAllDevices('user123');
 * console.log(`Logged out from ${deletedCount} device(s) and revoked all tokens`);
 * ```
 */
export async function logoutFromAllDevices(userId: string): Promise<number> {
  // Get all sessions to invalidate cache
  const allSessions = await db
    .select({ id: authSessions.id })
    .from(authSessions)
    .where(eq(authSessions.userId, userId));

  // Delete all sessions for this user
  const result = await db
    .delete(authSessions)
    .where(eq(authSessions.userId, userId));

  // Invalidate cache for all deleted sessions
  for (const session of allSessions) {
    invalidateSessionCache(session.id);
  }

  // Increment tokenVersion to invalidate all existing JWTs
  await db
    .update(users)
    .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
    .where(eq(users.userId, userId));

  return result.rowCount || 0;
}

/**
 * Delete a specific session by ID for a user.
 * Prevents deleting the current session.
 * @param userId - The user ID
 * @param sessionId - The session ID to delete
 * @param currentSessionId - The current session ID (cannot delete this one)
 * @returns True if deleted, false if not found
 * @throws Error if trying to delete the current session
 * 
 * @example
 * ```typescript
 * const deleted = await deleteSessionById('user123', 'session456', 'currentSession789');
 * if (!deleted) {
 *   // Session not found
 * }
 * ```
 */
export async function deleteSessionById(
  userId: string,
  sessionId: string,
  currentSessionId: string,
): Promise<boolean> {
  if (sessionId === currentSessionId) {
    throw new Error('Cannot delete current session');
  }

  const result = await db
    .delete(authSessions)
    .where(
      and(
        eq(authSessions.userId, userId),
        eq(authSessions.id, sessionId),
      )
    );

  if (result.rowCount && result.rowCount > 0) {
    invalidateSessionCache(sessionId);
    return true;
  }

  return false;
}

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
 * Derive device name from user agent string using UA Parser
 * @param userAgent - The user agent string
 * @returns Friendly device name (e.g., "iPhone 15 - Safari on iOS")
 * 
 * @example
 * ```typescript
 * const deviceName = deriveDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
 * console.log(deviceName); // "iPhone - Safari on iOS"
 * ```
 */
export function deriveDeviceName(userAgent: string | null): string {
  if (!userAgent) return 'Unknown Device';

  const parser = new UAParser(userAgent);
  const result = parser.getResult();

  const browser = result.browser.name || 'Unknown Browser';
  const os = result.os.name || 'Unknown OS';
  const device = result.device.model || result.device.type || 'Desktop';

  // Format: "iPhone 15 - Safari on iOS" or "Chrome on Windows (Desktop)"
  if (result.device.model) {
    return `${device} - ${browser} on ${os}`;
  }

  return `${browser} on ${os} (${device})`;
}
