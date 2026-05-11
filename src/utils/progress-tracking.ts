/**
 * Progress event storage system for candidate generation
 * 
 * This module provides storage and retrieval of action progress events
 * for Server-Sent Events polling scenarios.
 * 
 * Phase 2.2 Implementation Status: IN-MEMORY PLACEHOLDER
 * ====================================================
 * This is an in-memory placeholder implementation for Phase 2.2 of the UX Enhancement Roadmap.
 * The actual Redis-based storage will be implemented in a future iteration.
 * 
 * Current Behavior:
 * - storeActionProgressEvent: Stores events in memory with 5-minute TTL
 * - getActionProgressEvents: Retrieves and cleans up stored events
 * 
 * Planned Implementation (Phase 2.2):
 * - Redis storage with 5-minute TTL for progress events
 * - Automatic cleanup after retrieval to prevent memory buildup
 * - Atomic operations for concurrent access safety
 */

import type { ActionProgressEvent } from '../types/candidates.js';

// In-memory storage with TTL (Phase 2.2 placeholder)
const progressEventStore = new Map<string, { events: ActionProgressEvent[], timestamp: number }>();
const EVENT_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Cleanup expired events from memory store
 */
function cleanupExpiredEvents(): void {
  const now = Date.now();
  for (const [pageId, data] of progressEventStore.entries()) {
    if (now - data.timestamp > EVENT_TTL_MS) {
      progressEventStore.delete(pageId);
    }
  }
}

/**
 * Stores an action progress event for later retrieval
 * 
 * PHASE 2.2 IN-MEMORY PLACEHOLDER: Stores events in memory with TTL
 * 
 * @param pageId - Page ID for which to store the event
 * @param event - Progress event data to store
 */
export async function storeActionProgressEvent(
  pageId: string, 
  event: ActionProgressEvent
): Promise<void> {
  // PHASE 2.2 IN-MEMORY PLACEHOLDER: Store with TTL
  cleanupExpiredEvents();
  
  const existing = progressEventStore.get(pageId);
  if (existing) {
    existing.events.push(event);
    existing.timestamp = Date.now(); // Update timestamp on new events
  } else {
    progressEventStore.set(pageId, {
      events: [event],
      timestamp: Date.now()
    });
  }
  
  console.log(`[storeActionProgressEvent] 📊 IN-MEMORY - Stored event for page ${pageId}:`, event.status);
}

/**
 * Retrieves stored action progress events for a page
 * 
 * PHASE 2.2 IN-MEMORY PLACEHOLDER: Retrieves and cleans up events
 * 
 * @param pageId - Page ID for which to retrieve events
 * @returns Promise resolving to array of stored events
 */
export async function getActionProgressEvents(
  pageId: string
): Promise<ActionProgressEvent[]> {
  // PHASE 2.2 IN-MEMORY PLACEHOLDER: Retrieve and cleanup
  cleanupExpiredEvents();
  
  const data = progressEventStore.get(pageId);
  if (!data) {
    console.log(`[getActionProgressEvents] 📊 IN-MEMORY - No events for page ${pageId}`);
    return [];
  }
  
  // Return events and cleanup (simulating Redis behavior)
  const events = [...data.events];
  progressEventStore.delete(pageId); // Cleanup after retrieval
  
  console.log(`[getActionProgressEvents] 📊 IN-MEMORY - Retrieved ${events.length} events for page ${pageId}`);
  return events;
}
