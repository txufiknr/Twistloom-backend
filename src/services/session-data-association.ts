/**
 * Session Data Association Service
 * 
 * Manages association of temporary data with sessions or guest users.
 * Enables seamless migration from temporary sessions to guest users.
 * 
 * IMPORTANT: Guest users can only perform read operations and limited write operations
 * related to reading progress. Book creation, likes, comments, and other social features
 * require authentication.
 * 
 * Guest-allowed operations (require persistence):
 * - user_sessions: Track reading sessions for books
 * - user_page_progress: Track reading progress (page choices, branch navigation)
 * 
 * Auth-required operations (not tracked for guests):
 * - book creation: Requires authentication
 * - likes: Requires authentication
 * - comments: Requires authentication
 * - All other social features: Require authentication
 * 
 * 
 * Migration Flow (Two-Step Process):
 * 
 * Step 1: Temporary Session → Guest User (session-data-association.ts)
 * - When a temporary session is promoted to a guest user (first write operation)
 * - `migrateSessionDataToUser()` migrates data from temporary session to guest user
 * - Uses `sessionDataAssociations` table to track associations
 * - Guest user is created/updated with the migrated data
 * 
 * Step 2: Guest User → Authenticated User (user-controller.ts)
 * - When a guest user logs in (OAuth or email/password)
 * - `migrateGuestToAuthUser()` migrates all data from guest to authenticated user
 * - Directly updates tables: userSessions, userPageProgress, userActivityLogs
 * - Guest user is deleted from database
 * 
 * These two services are NOT redundant - they serve different migration stages:
 * - session-data-association.ts: Temporary session → Guest user (intermediate migration)
 * - user-controller.ts: Guest user → Authenticated user (final migration)
 */

import { dbRead, dbWrite } from '../db/client.js';
import { sessionDataAssociations } from '../db/schema.js';
import { eq, and, isNull } from 'drizzle-orm';
import type { SessionEntityType } from '../types/session.js';

// ---------------------------------------------------------------------------
// Association Management
// ---------------------------------------------------------------------------

/**
 * Associates data with a temporary session
 * 
 * This function creates a record in the sessionDataAssociations table to track
 * which entities (e.g., user_sessions, user_page_progress) belong to a temporary session.
 * This enables migration of data from temporary sessions to guest users when the session
 * is promoted to a guest user on the first write operation.
 * 
 * The association is stored with the sessionId and can later be migrated to a userId
 * when the temporary session is promoted to a guest user.
 * 
 * @param entityType - Type of entity (e.g., 'user_session', 'user_page_progress')
 * @param entityId - ID of the entity to associate with the session
 * @param sessionId - Temporary session ID from the in-memory LRU cache
 * 
 * @example
 * ```typescript
 * // Associate a reading session with a temporary session
 * await associateDataWithSession('user_session', 'session123', 'temp-session-456');
 * 
 * // Associate page progress with a temporary session
 * await associateDataWithSession('user_page_progress', 'progress789', 'temp-session-456');
 * ```
 */
export async function associateDataWithSession(
  entityType: SessionEntityType,
  entityId: string,
  sessionId: string
): Promise<void> {
  await dbWrite.insert(sessionDataAssociations).values({
    entityType,
    entityId,
    sessionId,
    createdAt: new Date(),
  }).catch((error) => {
    console.error('[session-data] ❌ Failed to associate data with session:', error);
  });
  
  console.log('[session-data] 🔗 Associated data with session:', { entityType, entityId, sessionId });
}

/**
 * Migrates all data from a temporary session to a guest user
 * 
 * This function is called when a temporary session is promoted to a guest user
 * (typically on the first write operation). It performs the following steps:
 * 
 * 1. Queries the sessionDataAssociations table for all entities associated with the sessionId
 * 2. For each entity, calls migrateEntityToUser() to update the actual entity's userId field
 * 3. Updates the association record with the guestUserId and migration timestamp
 * 
 * Only unmigrated associations (where userId is null) are processed to prevent
 * duplicate migrations. The migration is idempotent - calling it multiple times
 * with the same sessionId will not cause issues.
 * 
 * This is Step 1 of the two-step migration flow:
 * - Step 1: Temporary Session → Guest User (this function)
 * - Step 2: Guest User → Authenticated User (migrateGuestToAuthUser in user-controller.ts)
 * 
 * @param sessionId - Temporary session ID to migrate data from
 * @param guestUserId - Guest user ID to migrate data to
 * 
 * @example
 * ```typescript
 * // Promote temporary session to guest user on first write
 * const guestUserId = await getOrCreateGuestUser(req);
 * await migrateSessionDataToUser('temp-session-123', guestUserId);
 * ```
 */
export async function migrateSessionDataToUser(
  sessionId: string,
  guestUserId: string
): Promise<void> {
  const associations = await dbRead
    .select({ entityType: sessionDataAssociations.entityType, entityId: sessionDataAssociations.entityId })
    .from(sessionDataAssociations)
    .where(and(
      eq(sessionDataAssociations.sessionId, sessionId),
      isNull(sessionDataAssociations.userId) // Only unmigrated associations
    ));

  if (associations.length === 0) {
    console.log('[session-data] ℹ️ No data to migrate for session:', sessionId);
    return;
  }

  for (const association of associations) {
    // Update the actual entity to point to the guest user
    await migrateEntityToUser(association.entityType, association.entityId, guestUserId);
    
    // Update the association record
    await dbWrite.update(sessionDataAssociations)
      .set({
        userId: guestUserId,
        migratedAt: new Date(),
      })
      .where(and(
        eq(sessionDataAssociations.sessionId, sessionId),
        eq(sessionDataAssociations.entityId, association.entityId)
      ))
      .catch((error) => {
        console.error('[session-data] ❌ Failed to update association record:', error);
      });
  }
  
  console.log('[session-data] 🔄 Migrated session data:', associations.length, 'entities');
}

/**
 * Migrates a specific entity to a user
 * 
 * This is a helper function that updates the userId field of a specific entity
 * (e.g., user_session, user_page_progress) to point to a new user. It is called
 * by migrateSessionDataToUser() for each entity associated with a temporary session.
 * 
 * The function uses dynamic imports to avoid circular dependencies with the schema file.
 * It handles the following entity types:
 * 
 * - 'user_session': Updates the userId field in the userSessions table
 * - 'user_page_progress': Updates the userId field in the userPageProgress table
 * 
 * Unknown entity types are logged as warnings but do not throw errors, allowing
 * the migration to continue for other entities.
 * 
 * @param entityType - Type of entity to migrate (e.g., 'user_session', 'user_page_progress')
 * @param entityId - ID of the entity to migrate
 * @param userId - User ID to migrate the entity to (guest user or authenticated user)
 * 
 * @example
 * ```typescript
 * // Migrate a reading session to a guest user
 * await migrateEntityToUser('user_session', 'session-123', 'guest-456');
 * 
 * // Migrate page progress to a guest user
 * await migrateEntityToUser('user_page_progress', 'progress-789', 'guest-456');
 * ```
 */
async function migrateEntityToUser(
  entityType: SessionEntityType,
  entityId: string,
  userId: string
): Promise<void> {
  // Import tables dynamically to avoid circular dependencies
  const { userSessions } = await import('../db/schema.js');
  const { userPageProgress } = await import('../db/schema.js');
  
  switch (entityType) {
    case 'user_session':
      await dbWrite.update(userSessions)
        .set({ userId })
        .where(eq(userSessions.id, entityId))
        .catch((error) => {
          console.error('[session-data] ❌ Failed to migrate user session:', entityId, error);
        });
      break;
    
    case 'user_page_progress':
      await dbWrite.update(userPageProgress)
        .set({ userId })
        .where(eq(userPageProgress.id, entityId))
        .catch((error) => {
          console.error('[session-data] ❌ Failed to migrate page progress:', entityId, error);
        });
      break;
    
    default:
      console.warn('[session-data] ⚠️ Unknown entity type:', entityType);
  }
}

/**
 * Gets all data associated with a temporary session
 * 
 * Queries the sessionDataAssociations table to retrieve all entities that are
 * associated with a given temporary session ID. This is useful for debugging,
 * logging, or understanding what data will be migrated when a session is promoted
 * to a guest user.
 * 
 * The returned array includes both migrated and unmigrated associations.
 * To check if an association has been migrated, verify the userId field in the
 * association record (null = unmigrated, set = migrated).
 * 
 * @param sessionId - Temporary session ID to query
 * @returns Array of associated entities with entityType and entityId
 * 
 * @example
 * ```typescript
 * // Check what data is associated with a temporary session
 * const entities = await getSessionData('temp-session-123');
 * console.log('Associated entities:', entities);
 * // Output: [{ entityType: 'user_session', entityId: 'session-456' }, ...]
 * ```
 */
export async function getSessionData(
  sessionId: string
): Promise<Array<{ entityType: string; entityId: string }>> {
  const associations = await dbRead
    .select({ entityType: sessionDataAssociations.entityType, entityId: sessionDataAssociations.entityId })
    .from(sessionDataAssociations)
    .where(eq(sessionDataAssociations.sessionId, sessionId));

  return associations;
}

/**
 * Gets all data associated with a user
 * 
 * Queries the sessionDataAssociations table to retrieve all entities that have
 * been migrated to a specific user ID. This is useful for:
 * 
 * - Debugging migration issues
 * - Tracking what data belongs to a guest user
 * - Verifying that all expected data was migrated from a temporary session
 * 
 * Only associations where the userId field is set are returned. This function
 * does not return associations that are still linked to temporary sessions.
 * 
 * @param userId - User ID (guest user or authenticated user) to query
 * @returns Array of associated entities with entityType and entityId
 * 
 * @example
 * ```typescript
 * // Check what data belongs to a guest user
 * const entities = await getUserData('guest-user-123');
 * console.log('User entities:', entities);
 * // Output: [{ entityType: 'user_session', entityId: 'session-456' }, ...]
 * ```
 */
export async function getUserData(
  userId: string
): Promise<Array<{ entityType: string; entityId: string }>> {
  const associations = await dbRead
    .select({ entityType: sessionDataAssociations.entityType, entityId: sessionDataAssociations.entityId })
    .from(sessionDataAssociations)
    .where(eq(sessionDataAssociations.userId, userId));

  return associations;
}

/**
 * Cleans up orphaned association records
 * 
 * Removes association records where both sessionId and userId are null.
 * This is a safety cleanup function that should not normally find any records
 * to delete, as associations should always have either a sessionId (linked to
 * a temporary session) or a userId (migrated to a user).
 * 
 * Orphaned associations could occur due to:
 * - Database corruption or inconsistencies
 * - Failed migrations that left partial state
 * - Manual database modifications
 * 
 * This function is called by the daily cleanup cron job to ensure database
 * hygiene. It logs the number of records cleaned up for monitoring purposes.
 * 
 * @returns Number of orphaned association records deleted
 * 
 * @example
 * ```typescript
 * // Clean up orphaned associations (called by cron job)
 * const cleanedCount = await cleanupOrphanedAssociations();
 * console.log(`Cleaned up ${cleanedCount} orphaned associations`);
 * ```
 */
export async function cleanupOrphanedAssociations(): Promise<number> {
  const orphaned = await dbRead
    .select({ id: sessionDataAssociations.id })
    .from(sessionDataAssociations)
    .where(and(
      isNull(sessionDataAssociations.sessionId),
      isNull(sessionDataAssociations.userId)
    ));

  if (orphaned.length === 0) {
    return 0;
  }

  const ids = orphaned.map(o => o.id);
  
  for (const id of ids) {
    await dbWrite
      .delete(sessionDataAssociations)
      .where(eq(sessionDataAssociations.id, id))
      .catch((error) => {
        console.error('[session-data] ❌ Failed to delete orphaned association:', id, error);
      });
  }

  console.log('[session-data] 🧹 Cleaned up orphaned associations:', ids.length);
  return ids.length;
}
