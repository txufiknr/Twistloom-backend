/**
 * Temporary Session Service
 * 
 * Manages ephemeral sessions before guest user creation.
 * Uses in-memory LRU cache for fast access and database for persistence.
 * 
 * Architecture:
 * - Primary storage: In-memory LRU cache (fast access, automatic eviction)
 * - Backup storage: Database temporary_sessions table (persistence, recovery)
 * - Recovery strategy: Rehydrate cache from database on startup
 * 
 * This approach addresses:
 * - Redis free tier limitations (no external dependency)
 * - Vercel serverless data loss (database backup)
 * - High write volume (LRU cache handles efficiently)
 */

import { LRUCache } from 'lru-cache';
import { generateId } from '../utils/uuid.js';
import { dbRead, dbWrite } from '../db/client.js';
import { temporarySessions } from '../db/schema.js';
import { eq, and, sql, isNull } from 'drizzle-orm';
import { TEMP_SESSION_CONFIG } from '../config/auth.js';

// ---------------------------------------------------------------------------
// LRU Cache Configuration
// ---------------------------------------------------------------------------

/**
 * In-memory LRU cache for temporary sessions
 * 
 * Benefits:
 * - Fast O(1) operations
 * - Automatic eviction when capacity reached
 * - No external dependency (avoids Redis free tier limits)
 * - Perfect fit for temporary session data (short-lived, can be recreated)
 * 
 * Trade-offs:
 * - Data loss on server restart (mitigated by database backup)
 * - No cross-instance sharing (acceptable for serverless)
 * - Limited by server memory (configurable via LRU_MAX_SIZE)
 */
const sessionCache = new LRUCache<string, TemporarySessionData>({
  max: TEMP_SESSION_CONFIG.LRU_MAX_SIZE,
  ttl: TEMP_SESSION_CONFIG.TTL_SEC * 1000, // Convert to milliseconds
  updateAgeOnGet: true, // Extend TTL on access (sliding expiry)
  updateAgeOnHas: true,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TemporarySessionData {
  sessionId: string;
  ipAddress: string;
  userAgent: string;
  createdAt: Date;
  lastSeenAt: Date;
  pageViews: number;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Session Lifecycle
// ---------------------------------------------------------------------------

/**
 * Creates a new temporary session
 * 
 * Stores session in both LRU cache (fast access) and database (persistence).
 * 
 * @param ipAddress - Client IP address
 * @param userAgent - Client user agent
 * @param metadata - Optional metadata (referrer, etc.)
 * @returns Session ID
 * 
 * @example
 * ```typescript
 * const sessionId = await createTemporarySession('192.168.1.1', 'Mozilla/5.0...', {
 *   referrer: 'https://google.com'
 * });
 * ```
 */
export async function createTemporarySession(
  ipAddress: string,
  userAgent: string,
  metadata?: Record<string, unknown>
): Promise<string> {
  const sessionId = generateId();
  const now = new Date();
  
  const sessionData: TemporarySessionData = {
    sessionId,
    ipAddress,
    userAgent,
    createdAt: now,
    lastSeenAt: now,
    pageViews: 0,
    metadata,
  };
  
  // Store in LRU cache (primary storage)
  sessionCache.set(sessionId, sessionData);
  
  // Store in database (backup for persistence and recovery)
  await dbWrite.insert(temporarySessions).values({
    sessionId,
    ipAddress,
    userAgent,
    firstSeenAt: now,
    lastSeenAt: now,
    pageViews: 0,
    metadata: metadata || {},
  }).catch((error) => {
    console.error('[temp-session] ❌ Failed to store session in database:', error);
    // Continue even if database write fails (cache is primary)
  });
  
  console.log('[temp-session] 🆕 Created temporary session:', sessionId);
  return sessionId;
}

/**
 * Gets temporary session data from LRU cache
 * 
 * @param sessionId - Session ID
 * @returns Session data or null
 * 
 * @example
 * ```typescript
 * const session = await getTemporarySession('session123');
 * if (session) {
 *   console.log('Session found:', session.pageViews);
 * }
 * ```
 */
export async function getTemporarySession(
  sessionId: string
): Promise<TemporarySessionData | null> {
  // Check LRU cache first (primary storage)
  const cached = sessionCache.get(sessionId);
  if (cached) {
    return cached;
  }
  
  // Fallback to database (for recovery after restart)
  const dbSession = await dbRead
    .select()
    .from(temporarySessions)
    .where(and(
      eq(temporarySessions.sessionId, sessionId),
      isNull(temporarySessions.userId) // Only unmigrated sessions
    ))
    .limit(1)
    .then(rows => rows[0]);
  
  if (dbSession) {
    // Rehydrate cache from database
    const sessionData: TemporarySessionData = {
      sessionId: dbSession.sessionId,
      ipAddress: dbSession.ipAddress || 'unknown',
      userAgent: dbSession.userAgent || 'unknown',
      createdAt: dbSession.firstSeenAt,
      lastSeenAt: dbSession.lastSeenAt,
      pageViews: dbSession.pageViews,
      metadata: dbSession.metadata as Record<string, unknown> || {},
    };
    
    sessionCache.set(sessionId, sessionData);
    return sessionData;
  }
  
  return null;
}

/**
 * Updates temporary session activity
 * 
 * Increments page view count and updates last seen timestamp.
 * Updates both LRU cache and database asynchronously.
 * 
 * @param sessionId - Session ID
 * @param incrementPageViews - Whether to increment page view count
 * 
 * @example
 * ```typescript
 * await updateTemporarySession('session123', true);
 * ```
 */
export async function updateTemporarySession(
  sessionId: string,
  incrementPageViews: boolean = true
): Promise<void> {
  const session = sessionCache.get(sessionId);
  
  if (!session) {
    return;
  }
  
  if (incrementPageViews) {
    session.pageViews += 1;
  }
  
  session.lastSeenAt = new Date();
  
  // Update LRU cache (primary storage)
  sessionCache.set(sessionId, session);
  
  // Update database asynchronously (backup)
  dbWrite.update(temporarySessions)
    .set({
      lastSeenAt: session.lastSeenAt,
      pageViews: incrementPageViews ? sql`${temporarySessions.pageViews} + 1` : undefined,
    })
    .where(eq(temporarySessions.sessionId, sessionId))
    .catch((error) => {
      console.error('[temp-session] ❌ Failed to update session in database:', error);
    });
}

/**
 * Migrates temporary session to guest user
 * 
 * Updates database record to associate session with guest user.
 * Removes from LRU cache (no longer needed).
 * 
 * @param sessionId - Temporary session ID
 * @param guestUserId - New guest user ID
 * 
 * @example
 * ```typescript
 * await migrateTemporarySessionToGuest('session123', 'guest456');
 * ```
 */
export async function migrateTemporarySessionToGuest(
  sessionId: string,
  guestUserId: string
): Promise<void> {
  // Update database record
  await dbWrite.update(temporarySessions)
    .set({
      userId: guestUserId,
      migratedAt: new Date(),
    })
    .where(eq(temporarySessions.sessionId, sessionId))
    .catch((error) => {
      console.error('[temp-session] ❌ Failed to migrate session in database:', error);
    });
  
  // Remove from LRU cache (no longer needed)
  sessionCache.delete(sessionId);
  
  console.log('[temp-session] 🔄 Migrated temporary session to guest:', sessionId, '->', guestUserId);
}

/**
 * Cleans up expired temporary sessions
 * 
 * Should be run periodically (e.g., every hour) via cron job.
 * Removes sessions older than 2 hours that haven't been migrated.
 * 
 * @returns Number of sessions cleaned up
 * 
 * @example
 * ```typescript
 * const cleanedCount = await cleanupExpiredTemporarySessions();
 * console.log(`Cleaned up ${cleanedCount} expired sessions`);
 * ```
 */
export async function cleanupExpiredTemporarySessions(): Promise<number> {
  const expiredSessions = await dbRead
    .select({ sessionId: temporarySessions.sessionId })
    .from(temporarySessions)
    .where(and(
      isNull(temporarySessions.userId), // Only unmigrated sessions
      sql`${temporarySessions.lastSeenAt} < NOW() - INTERVAL '2 hours'`
    ));

  if (expiredSessions.length === 0) {
    return 0;
  }

  // Delete expired sessions from database
  const sessionIds = expiredSessions.map(s => s.sessionId);
  
  // Batch delete (Drizzle limitation - need to delete one by one or use raw SQL)
  for (const sessionId of sessionIds) {
    await dbWrite
      .delete(temporarySessions)
      .where(eq(temporarySessions.sessionId, sessionId))
      .catch((error) => {
        console.error('[temp-session] ❌ Failed to delete expired session:', sessionId, error);
      });
    
    // Also remove from LRU cache if present
    sessionCache.delete(sessionId);
  }

  console.log('[temp-session] 🧹 Cleaned up expired sessions:', sessionIds.length);
  return sessionIds.length;
}

/**
 * Rehydrates LRU cache from database
 * 
 * Should be called on application startup to recover sessions after restart.
 * Loads recent unmigrated sessions into LRU cache.
 * 
 * @returns Number of sessions rehydrated
 * 
 * @example
 * ```typescript
 * // Call on startup
 * const rehydratedCount = await rehydrateSessionCache();
 * console.log(`Rehydrated ${rehydratedCount} sessions from database`);
 * ```
 */
export async function rehydrateSessionCache(): Promise<number> {
  const recentSessions = await dbRead
    .select()
    .from(temporarySessions)
    .where(and(
      isNull(temporarySessions.userId), // Only unmigrated sessions
      sql`${temporarySessions.lastSeenAt} > NOW() - INTERVAL '1 hour'` // Only recent sessions
    ))
    .limit(TEMP_SESSION_CONFIG.LRU_MAX_SIZE);

  let rehydratedCount = 0;
  
  for (const dbSession of recentSessions) {
    const sessionData: TemporarySessionData = {
      sessionId: dbSession.sessionId,
      ipAddress: dbSession.ipAddress || 'unknown',
      userAgent: dbSession.userAgent || 'unknown',
      createdAt: dbSession.firstSeenAt,
      lastSeenAt: dbSession.lastSeenAt,
      pageViews: dbSession.pageViews,
      metadata: dbSession.metadata as Record<string, unknown> || {},
    };
    
    sessionCache.set(dbSession.sessionId, sessionData);
    rehydratedCount++;
  }

  console.log('[temp-session] 💧 Rehydrated session cache:', rehydratedCount, 'sessions');
  return rehydratedCount;
}

/**
 * Gets cache statistics for monitoring
 * 
 * @returns Cache statistics
 * 
 * @example
 * ```typescript
 * const stats = getSessionCacheStats();
 * console.log('Cache size:', stats.size, 'Max size:', stats.maxSize);
 * ```
 */
export function getSessionCacheStats(): { size: number; maxSize: number; hitRate: number } {
  return {
    size: sessionCache.size,
    maxSize: sessionCache.max,
    hitRate: sessionCache.calculatedSize / sessionCache.max,
  };
}
