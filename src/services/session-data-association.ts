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
 * @param entityType - Type of entity (book, user_session, etc.)
 * @param entityId - ID of the entity
 * @param sessionId - Temporary session ID
 * 
 * @example
 * ```typescript
 * await associateDataWithSession('book', 'book123', 'session456');
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
 * Migrates all data from temporary session to guest user
 * 
 * Updates the actual entity to point to the guest user and updates
 * the association record with migration timestamp.
 * 
 * @param sessionId - Temporary session ID
 * @param guestUserId - Guest user ID
 * 
 * @example
 * ```typescript
 * await migrateSessionDataToUser('session456', 'guest789');
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
 * @param entityType - Type of entity
 * @param entityId - ID of the entity
 * @param userId - User ID to migrate to
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
 * Gets all data associated with a session
 * 
 * @param sessionId - Temporary session ID
 * @returns List of associated entities
 * 
 * @example
 * ```typescript
 * const entities = await getSessionData('session456');
 * console.log('Associated entities:', entities);
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
 * @param userId - User ID
 * @returns List of associated entities
 * 
 * @example
 * ```typescript
 * const entities = await getUserData('user123');
 * console.log('User entities:', entities);
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
 * Removes associations where both sessionId and userId are null
 * (shouldn't happen in normal operation, but cleanup for safety)
 * 
 * @returns Number of records cleaned up
 * 
 * @example
 * ```typescript
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
