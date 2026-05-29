/**
 * Progress event storage system for candidate generation
 *
 * This module provides storage and retrieval of action progress events
 * for Server-Sent Events polling scenarios.
 *
 * Implementation Status: DATABASE PERSISTENT STORAGE
 * ===================================================
 * Uses PostgreSQL database for persistent progress tracking across server restarts
 * and long-running generation processes (up to 30+ minutes).
 *
 * Current Behavior:
 * - storeActionProgressEvent: Upserts progress events to database
 * - getActionProgressEvents: Retrieves all progress events for a page
 * - clearActionProgressEvents: Deletes progress events for a page
 *
 * Database Schema:
 * - Table: action_progress
 * - Unique constraint: (pageId, actionText)
 * - TTL: No TTL (persistent storage)
 * - Automatic cleanup via explicit deletion
 *
 * Benefits over LRU cache:
 * - Survives server restarts
 * - Supports long-running processes (30+ minutes)
 * - Enables multi-server deployments
 * - Provides audit trail and debugging capabilities
 */

import { dbWrite } from '../db/client.js';
import { actionProgress } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import type { ActionProgressEvent } from '../types/candidate-generation.js';

/**
 * Stores or updates an action progress event in the database
 *
 * Uses upsert operation to handle both new and existing progress entries.
 * This allows for status updates (e.g., started -> completed) without duplicate entries.
 *
 * @param pageId - Page ID for which to store the event
 * @param event - Progress event data to store
 */
export async function storeActionProgressEvent(
  pageId: string,
  event: ActionProgressEvent
): Promise<void> {
  const { action: actionText, status, error, destinationPageId } = event;

  // Early exit: No need to store invalid action progress event
  if (!actionText) return;

  const context = `${status} action "${actionText}" from page ${pageId}`;
  try {
    // Determine timestamps based on status
    const startedAt = status === 'started' ? new Date(event.timestamp) : undefined;
    const completedAt = status === 'completed' || status === 'failed' ? new Date(event.timestamp) : undefined;

    // Upsert progress entry
    await dbWrite
      .insert(actionProgress)
      .values({
        pageId,
        actionText,
        status,
        error,
        destinationPageId,
        startedAt,
        completedAt,
      })
      .onConflictDoUpdate({
        target: [actionProgress.pageId, actionProgress.actionText],
        set: {
          status,
          error,
          destinationPageId,
          startedAt: startedAt || actionProgress.startedAt,
          completedAt: completedAt || actionProgress.completedAt,
          updatedAt: new Date(),
        },
      });

    console.log(`[storeActionProgressEvent] 📊 Stored progress event for ${context}`);
  } catch (error) {
    console.error(`[storeActionProgressEvent] ❌ Failed to store progress event for ${context}:`, error);
  }
}

/**
 * Retrieves all action progress events for a page from the database
 *
 * Retrieves events for the page without clearing them.
 * This allows multiple polling requests to access the same progress data.
 * Use clearActionProgressEvents to explicitly remove events when generation completes.
 *
 * @param pageId - Page ID for which to retrieve events
 * @returns Promise resolving to array of stored events
 */
export async function getActionProgressEvents(
  pageId: string
): Promise<ActionProgressEvent[]> {
  try {
    const rows = await dbWrite
      .select()
      .from(actionProgress)
      .where(eq(actionProgress.pageId, pageId));

    const events: ActionProgressEvent[] = rows.map(row => ({
      action: row.actionText,
      status: row.status,
      error: row.error || undefined,
      timestamp: row.updatedAt.toISOString(),
      destinationPageId: row.destinationPageId || undefined,
    }) satisfies ActionProgressEvent);

    console.log(`[getActionProgressEvents] 📊 Retrieved ${events.length} progress events for page ${pageId}`);
    return events;
  } catch (error) {
    console.error(`[getActionProgressEvents] ❌ Failed to retrieve progress events for page ${pageId}:`, error);
    throw error;
  }
}

/**
 * Clears all action progress events for a page from the database
 *
 * Explicitly removes events from the database after generation completes.
 * This should be called when generation is finished to clean up resources.
 *
 * @param pageId - Page ID for which to clear events
 */
export async function clearActionProgressEvents(
  pageId: string
): Promise<void> {
  try {
    await dbWrite
      .delete(actionProgress)
      .where(eq(actionProgress.pageId, pageId));

    console.log(`[clearActionProgressEvents] ✨ Cleared all progress events for page ${pageId}`);
  } catch (error) {
    console.error(`[clearActionProgressEvents] ❌ Failed to clear progress events for page ${pageId}:`, error);
    throw error;
  }
}
