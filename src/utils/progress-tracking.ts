/**
 * Progress event storage system for candidate generation
 * 
 * This module provides storage and retrieval of action progress events
 * for Server-Sent Events polling scenarios.
 * 
 * Phase 2.2 Implementation Status: IN-MEMORY LRU CACHE
 * =====================================================
 * Uses LRUCache package for automatic TTL management and memory-efficient storage.
 * Leverages existing "lru-cache" package already used in the codebase (book.ts).
 * 
 * Current Behavior:
 * - storeActionProgressEvent: Stores events in LRU cache with 5-minute TTL
 * - getActionProgressEvents: Retrieves and cleans up stored events
 * - Automatic cleanup handled by LRUCache
 * 
 * Cache Configuration:
 * - Max entries: 100 (prevents memory bloat for concurrent generations)
 * - TTL: 5 minutes (matches generation timeout)
 * - Automatic LRU eviction when cache is full
 * 
 * Migration Path to Redis (when needed):
 * - When scaling to multi-server deployments
 * - When high concurrent users (>100 simultaneous generations)
 * - When paid Redis tier with guaranteed memory allocation is available
 */

import { LRUCache } from 'lru-cache';
import type { ActionProgressEvent } from '../types/candidates.js';

/**
 * LRU cache for progress event storage
 * 
 * Cache key format: "progress:{pageId}"
 * - pageId: Page ID for which progress events are stored
 * 
 * TTL: 5 minutes to match generation timeout
 * Max size: 100 entries to prevent memory bloat (supports ~100 concurrent generations)
 */
const progressEventCache = new LRUCache<string, ActionProgressEvent[]>({
  max: 100, // Support up to 100 concurrent generations
  ttl: 5 * 60 * 1000, // 5 minutes
});

/**
 * Stores an action progress event for later retrieval
 * 
 * Uses LRUCache for automatic TTL management and memory-efficient storage.
 * Events are appended to existing array for the same pageId.
 * 
 * @param pageId - Page ID for which to store the event
 * @param event - Progress event data to store
 */
export async function storeActionProgressEvent(
  pageId: string, 
  event: ActionProgressEvent
): Promise<void> {
  const cacheKey = `progress:${pageId}`;
  const existingEvents = progressEventCache.get(cacheKey) || [];
  
  // Append new event to existing events
  const updatedEvents = [...existingEvents, event];
  progressEventCache.set(cacheKey, updatedEvents);
  
  console.log(`[storeActionProgressEvent] 📊 LRU CACHE - Stored event for page ${pageId}:`, event.status);
}

/**
 * Retrieves stored action progress events for a page
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
  const cacheKey = `progress:${pageId}`;
  const events = progressEventCache.get(cacheKey) || [];
  
  console.log(`[getActionProgressEvents] 📊 LRU CACHE - Retrieved ${events.length} events for page ${pageId}`);
  return events;
}

/**
 * Clears stored action progress events for a page
 * 
 * Explicitly removes events from the cache after generation completes.
 * This should be called when generation is finished to clean up resources.
 * 
 * @param pageId - Page ID for which to clear events
 */
export async function clearActionProgressEvents(
  pageId: string
): Promise<void> {
  const cacheKey = `progress:${pageId}`;
  progressEventCache.delete(cacheKey);
  
  console.log(`[clearActionProgressEvents] 📊 LRU CACHE - Cleared events for page ${pageId}`);
}
