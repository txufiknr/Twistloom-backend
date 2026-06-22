import { eq, asc } from 'drizzle-orm';
import { dbRead } from '../db/client.js';
import { storyStates } from '../db/schema.js';
import type { LockedPathEvent } from '../types/story.js';
import type { PlaceMemory, PlaceAccessibility } from '../types/places.js';
import type { StoryThread } from '../types/story-thread.js';

const LOCKED_ACCESSIBILITIES: PlaceAccessibility[] = ['blocked', 'destroyed', 'restricted'];

/**
 * Scan all story states for a book and detect when places/connections/threads
 * become permanently locked or closed.
 *
 * Diffs adjacent page states to find the exact page where an accessibility
 * change or thread closure happened.
 *
 * @param bookId - The UUID of the book to scan
 * @returns Array of locked path events, sorted by page
 */
export async function getLockedPaths(bookId: string): Promise<LockedPathEvent[]> {
  const rows = await dbRead
    .select()
    .from(storyStates)
    .where(eq(storyStates.bookId, bookId))
    .orderBy(asc(storyStates.page));

  if (rows.length < 2) return [];

  const events: LockedPathEvent[] = [];
  const trackedAccessibilities = new Map<string, string>();
  const trackedThreadStatuses = new Map<string, string>();

  // Bootstrap from page 1
  const first = rows[0];
  if (first.places) {
    for (const [placeId, place] of Object.entries(first.places as Record<string, PlaceMemory>)) {
      if (place.knownConnections) {
        for (const conn of place.knownConnections) {
          if (conn.accessibility) {
            const key = `${placeId}:${conn.targetId}`;
            trackedAccessibilities.set(key, conn.accessibility);
          }
        }
      }
    }
  }
  if (first.threads) {
    for (const thread of first.threads as StoryThread[]) {
      trackedThreadStatuses.set(thread.threadId, thread.status);
    }
  }

  // Scan forward through states
  for (let i = 1; i < rows.length; i++) {
    const state = rows[i];
    const page = state.page;

    // Detect place/connection accessibility changes
    if (state.places) {
      const places = state.places as Record<string, PlaceMemory>;
      for (const [placeId, place] of Object.entries(places)) {
        if (!place.knownConnections) continue;

        for (const conn of place.knownConnections) {
          if (!conn.accessibility) continue;

          const key = `${placeId}:${conn.targetId}`;
          const prev = trackedAccessibilities.get(key);
          const current = conn.accessibility;

          if (prev && prev !== current && (LOCKED_ACCESSIBILITIES as readonly string[]).includes(current)) {
            events.push({
              kind: 'place_connection',
              label: `${place.knownName || placeId} → ${conn.targetId}`,
              restriction: `Route ${current}`,
              page,
              context: `The route between ${place.knownName || placeId} and ${conn.targetId} is now ${current}.`,
            });
          }

          trackedAccessibilities.set(key, current);
        }
      }
    }

    // Detect thread closures
    if (state.threads) {
      const threads = state.threads as StoryThread[];
      for (const thread of threads) {
        const prev = trackedThreadStatuses.get(thread.threadId);
        const current = thread.status;

        if (prev && prev !== current && current === 'closed') {
          events.push({
            kind: 'thread',
            label: thread.title,
            restriction: 'Closed',
            page,
            context: thread.resolution
              ? `${thread.title} was resolved: ${thread.resolution}`
              : `The thread "${thread.title}" is now closed.`,
          });
        }

        trackedThreadStatuses.set(thread.threadId, current);
      }
    }
  }

  return events;
}
