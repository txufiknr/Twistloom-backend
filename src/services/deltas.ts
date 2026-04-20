/**
 * Story State Deltas Service
 * 
 * Provides functionality for creating, retrieving, and managing story state deltas.
 * Deltas represent the changes between consecutive story states, enabling efficient
 * incremental reconstruction using the Branch Traversal Algorithm.
 * 
 * Key Features:
 * - Automatic delta creation between state changes
 * - Efficient delta application for state reconstruction
 * - Compressed storage of state differences
 * - Delta cleanup and optimization
 */

import { dbRead, dbWrite } from "../db/client.js";
import { storyStateDeltas } from "../db/schema.js";
import { eq, and, desc, inArray, sql } from "drizzle-orm";
import type { StateDelta, StoryState, Action } from "../types/story.js";
import type { CharacterMemory } from "../types/character.js";
import type { PlaceMemory } from "../types/places.js";
import type { StoryThread } from "../types/thread.js";
import { 
  createPsychologicalFlagsDelta,
  createPsychologicalProfileDelta,
  createHiddenStateDelta,
  createCharacterMemoryDelta,
  createPlaceMemoryDelta
} from "../utils/delta-helpers.js";
import { getErrorMessage } from "../utils/error.js";
import { deepEqualSimple } from "../utils/parser.js";
import { 
  GET_DELTA_CIRCUIT_THRESHOLD,
  GET_DELTA_CIRCUIT_TIMEOUT,
  CREATE_DELTA_CIRCUIT_THRESHOLD,
  CREATE_DELTA_CIRCUIT_TIMEOUT,
  GET_DELTA_KEY_PREFIX,
  CREATE_DELTA_KEY_PREFIX
} from "../config/branch-traversal.js";
import { retryOperation, withCircuitBreaker, createReliabilityMeasurement, completeReliabilityMeasurement } from "../utils/reliability.js";

// ============================================================================
// DELTA CREATION UTILITIES
// ============================================================================

/**
 * Creates a delta for context history changes
 * 
 * @param fromContext - Original context history
 * @param toContext - Updated context history
 * @returns Context history delta or null if no changes
 */
function createContextHistoryDelta(fromContext: string, toContext: string): {
  contextHistoryAddition?: string;
  fullContextHistory?: string;
} | null {
  if (toContext !== fromContext) {
    // Handle edge cases first
    if (!fromContext && toContext) {
      // From empty to non-empty - full context
      return { fullContextHistory: toContext };
    } else if (!toContext) {
      // To empty - full replacement (empty context)
      return { fullContextHistory: toContext };
    } else if (toContext.startsWith(fromContext)) {
      // If it's an addition, store only the addition for efficiency
      const addition = toContext.substring(fromContext.length);
      if (addition.trim()) {
        return { contextHistoryAddition: addition.trim() };
      }
    } else {
      // If the contexts are completely different, store the full new context
      return { fullContextHistory: toContext };
    }
  }
  return null;
}

/**
 * Efficiently compares two arrays of actions
 * 
 * @param actions1 - First actions array
 * @param actions2 - Second actions array
 * @returns True if arrays are different
 */
function areActionsDifferent(actions1: Action[], actions2: Action[]): boolean {
  // Quick length check first
  if (actions1.length !== actions2.length) {
    return true;
  }
  
  // Deep comparison of each action
  return !actions1.every((action, index) => 
    JSON.stringify(action) === JSON.stringify(actions2[index])
  );
}

/**
 * Efficiently compares two arrays of threads
 * 
 * @param threads1 - First threads array
 * @param threads2 - Second threads array
 * @returns True if arrays are different
 */
function areThreadsDifferent(threads1: StoryThread[], threads2: StoryThread[]): boolean {
  return !deepEqualSimple(threads1, threads2);
}

/**
 * Creates a delta for actions history changes
 * 
 * @param fromActions - Original actions history
 * @param toActions - Updated actions history
 * @returns Actions history delta or null if no changes
 */
function createActionsHistoryDelta(fromActions: Action[], toActions: Action[]): {
  addedActions?: Action[];
  fullActionsHistory?: Action[];
} | null {
  if (areActionsDifferent(toActions, fromActions)) {
    // Handle edge cases first
    if (fromActions.length === 0 && toActions.length > 0) {
      // From empty to non-empty - all actions are additions
      return { addedActions: toActions };
    } else if (toActions.length === 0) {
      // To empty - full replacement
      return { fullActionsHistory: toActions };
    } else if (toActions.length > fromActions.length) {
      // Check if it's just additions (most common case)
      const baseActions = toActions.slice(0, fromActions.length);
      const baseMatches = !areActionsDifferent(baseActions, fromActions);
      
      if (baseMatches) {
        // Actions were appended (most efficient case)
        const addedActions = toActions.slice(fromActions.length);
        if (addedActions.length > 0) {
          return { addedActions };
        }
      } else {
        // Actions are completely different - store full replacement
        return { fullActionsHistory: toActions };
      }
    } else {
      // Length changed but not just additions - full replacement
      return { fullActionsHistory: toActions };
    }
  }
  return null;
}

/**
 * Creates a delta for threads changes
 * 
 * @param fromThreads - Original threads array
 * @param toThreads - Updated threads array
 * @returns Threads delta or null if no changes
 */
function createThreadsDelta(fromThreads: StoryThread[], toThreads: StoryThread[]): {
  addedThreads?: StoryThread[];
  updatedThreads?: Array<{ id: string; updates: Partial<StoryThread> }>;
  removedThreads?: string[];
  fullThreads?: StoryThread[];
} | null {
  if (areThreadsDifferent(toThreads, fromThreads)) {
    // Handle edge cases first
    if (fromThreads.length === 0 && toThreads.length > 0) {
      // From empty to non-empty - all threads are additions
      return { addedThreads: toThreads };
    } else if (toThreads.length === 0) {
      // To empty - full replacement
      return { fullThreads: toThreads };
    }
    
    // Track thread IDs for comparison
    const fromThreadIds = new Set(fromThreads.map(t => t.id));
    const toThreadIds = new Set(toThreads.map(t => t.id));
    
    // Find added threads
    const addedThreads = toThreads.filter(t => !fromThreadIds.has(t.id));
    
    // Find removed threads
    const removedThreads = fromThreads.filter(t => !toThreadIds.has(t.id)).map(t => t.id);
    
    // Find updated threads (same ID but different content)
    const updatedThreads: Array<{ id: string; updates: Partial<StoryThread> }> = [];
    for (const toThread of toThreads) {
      if (fromThreadIds.has(toThread.id)) {
        const fromThread = fromThreads.find(t => t.id === toThread.id);
        if (fromThread && areThreadsDifferent([fromThread], [toThread])) {
          // Find the specific fields that changed
          const updates: Record<string, unknown> = {};
          for (const key of Object.keys(toThread) as Array<keyof StoryThread>) {
            if (key !== 'id' && JSON.stringify(toThread[key]) !== JSON.stringify(fromThread[key])) {
              updates[key] = toThread[key];
            }
          }
          if (Object.keys(updates).length > 0) {
            updatedThreads.push({ id: toThread.id, updates });
          }
        }
      }
    }
    
    // Determine the most efficient delta format
    if (addedThreads.length > 0 || removedThreads.length > 0 || updatedThreads.length > 0) {
      const result: {
        addedThreads?: StoryThread[];
        updatedThreads?: Array<{ id: string; updates: Partial<StoryThread> }>;
        removedThreads?: string[];
      } = {};
      if (addedThreads.length > 0) result.addedThreads = addedThreads;
      if (updatedThreads.length > 0) result.updatedThreads = updatedThreads;
      if (removedThreads.length > 0) result.removedThreads = removedThreads;
      return result;
    } else {
      // Threads are completely different - store full replacement
      return { fullThreads: toThreads };
    }
  }
  return null;
}

/**
 * Creates a state delta between two story states
 * 
 * @param fromState - Previous story state
 * @param toState - New story state
 * @param pageId - Page identifier for the delta
 * @returns StateDelta object representing the changes
 */
export function createStateDelta(
  fromState: StoryState,
  toState: StoryState,
  pageId: string
): StateDelta {
  const delta: StateDelta = {
    pageId,
    page: toState.page
  };
  
  // Track flag changes
  const flagsDelta = createPsychologicalFlagsDelta(fromState.flags, toState.flags);
  if (Object.keys(flagsDelta).length > 0) {
    delta.flagsDelta = flagsDelta;
  }
  
  // Track trauma tag changes
  const addedTraumaTags = toState.traumaTags.filter(tag => !fromState.traumaTags.includes(tag));
  if (addedTraumaTags.length > 0) {
    delta.addedTraumaTags = addedTraumaTags;
  }
  
  const removedTraumaTags = fromState.traumaTags.filter(tag => !toState.traumaTags.includes(tag));
  if (removedTraumaTags.length > 0) {
    delta.removedTraumaTags = removedTraumaTags;
  }
  
  // Track psychological profile changes
  const profileDelta = createPsychologicalProfileDelta(fromState.psychologicalProfile, toState.psychologicalProfile);
  if (Object.keys(profileDelta).length > 0) {
    delta.profileDelta = profileDelta;
  }
  
  // Track hidden state changes
  const hiddenStateDelta = createHiddenStateDelta(fromState.hiddenState, toState.hiddenState);
  if (Object.keys(hiddenStateDelta).length > 0) {
    delta.hiddenStateDelta = hiddenStateDelta;
  }
  
  // Track memory integrity changes
  if (fromState.memoryIntegrity !== toState.memoryIntegrity) {
    delta.memoryIntegrity = toState.memoryIntegrity;
  }
  
  // Track difficulty changes
  if (fromState.difficulty !== toState.difficulty) {
    delta.difficulty = toState.difficulty;
  }
  
  // Track viable ending changes
  if (!deepEqualSimple(fromState.viableEnding, toState.viableEnding)) {
    delta.viableEnding = toState.viableEnding;
  }
  
  // Track character changes
  const fromCharIds = new Set(Object.keys(fromState.characters));
  const toCharIds = new Set(Object.keys(toState.characters));
  
  // Added characters
  const addedCharacters: Record<string, CharacterMemory> = {};
  for (const charId of toCharIds) {
    if (!fromCharIds.has(charId)) {
      addedCharacters[charId] = toState.characters[charId];
    }
  }
  if (Object.keys(addedCharacters).length > 0) {
    delta.addedCharacters = addedCharacters;
  }
  
  // Removed characters
  const removedCharacters: string[] = [];
  for (const charId of fromCharIds) {
    if (!toCharIds.has(charId)) {
      removedCharacters.push(charId);
    }
  }
  if (removedCharacters.length > 0) {
    delta.removedCharacters = removedCharacters;
  }
  
  // Updated characters
  const updatedCharacters: Record<string, Partial<CharacterMemory>> = {};
  for (const charId of fromCharIds) {
    if (toCharIds.has(charId)) {
      const fromChar = fromState.characters[charId];
      const toChar = toState.characters[charId];
      
      // Find differences
      const updates = createCharacterMemoryDelta(fromChar, toChar);
      
      if (Object.keys(updates).length > 0) {
        updatedCharacters[charId] = updates;
      }
    }
  }
  if (Object.keys(updatedCharacters).length > 0) {
    delta.updatedCharacters = updatedCharacters;
  }
  
  // Track place changes (similar logic to characters)
  const fromPlaceIds = new Set(Object.keys(fromState.places));
  const toPlaceIds = new Set(Object.keys(toState.places));
  
  const addedPlaces: Record<string, PlaceMemory> = {};
  for (const placeId of toPlaceIds) {
    if (!fromPlaceIds.has(placeId)) {
      addedPlaces[placeId] = toState.places[placeId];
    }
  }
  if (Object.keys(addedPlaces).length > 0) {
    delta.addedPlaces = addedPlaces;
  }
  
  const removedPlaces: string[] = [];
  for (const placeId of fromPlaceIds) {
    if (!toPlaceIds.has(placeId)) {
      removedPlaces.push(placeId);
    }
  }
  if (removedPlaces.length > 0) {
    delta.removedPlaces = removedPlaces;
  }
  
  const updatedPlaces: Record<string, Partial<PlaceMemory>> = {};
  for (const placeId of fromPlaceIds) {
    if (toPlaceIds.has(placeId)) {
      const fromPlace = fromState.places[placeId];
      const toPlace = toState.places[placeId];
      
      const updates = createPlaceMemoryDelta(fromPlace, toPlace);
      
      if (Object.keys(updates).length > 0) {
        updatedPlaces[placeId] = updates;
      }
    }
  }
  if (Object.keys(updatedPlaces).length > 0) {
    delta.updatedPlaces = updatedPlaces;
  }
  
  // Track context history changes
  const contextDelta = createContextHistoryDelta(fromState.contextHistory, toState.contextHistory);
  if (contextDelta) {
    Object.assign(delta, contextDelta);
  }

  // Track actions history changes
  const actionsDelta = createActionsHistoryDelta(fromState.actionsHistory, toState.actionsHistory);
  if (actionsDelta) {
    Object.assign(delta, actionsDelta);
  }

  // Track threads changes
  const threadsDelta = createThreadsDelta(fromState.threads, toState.threads);
  if (threadsDelta) {
    Object.assign(delta, threadsDelta);
  }

  return delta;
}

/**
 * Applies a state delta to a base state
 * 
 * @param baseState - Base story state to apply delta to
 * @param delta - State delta to apply
 * @returns Updated story state
 */
export function applyStateDelta(baseState: StoryState, delta: StateDelta): StoryState {
  const newState = structuredClone(baseState);
  
  // Characters management
  if (delta.addedCharacters) {
    newState.characters = { ...newState.characters, ...delta.addedCharacters };
  }
  
  if (delta.updatedCharacters) {
    for (const [charId, updates] of Object.entries(delta.updatedCharacters)) {
      if (newState.characters[charId]) {
        newState.characters[charId] = { ...newState.characters[charId], ...updates };
      }
    }
  }
  
  if (delta.removedCharacters) {
    for (const charId of delta.removedCharacters) {
      delete newState.characters[charId];
    }
  }
  
  // Places management
  if (delta.addedPlaces) {
    newState.places = { ...newState.places, ...delta.addedPlaces };
  }
  
  if (delta.updatedPlaces) {
    for (const [placeId, updates] of Object.entries(delta.updatedPlaces)) {
      if (newState.places[placeId]) {
        newState.places[placeId] = { ...newState.places[placeId], ...updates };
      }
    }
  }
  
  if (delta.removedPlaces) {
    for (const placeId of delta.removedPlaces) {
      delete newState.places[placeId];
    }
  }
  
  // Trauma tags management
  if (delta.addedTraumaTags) {
    newState.traumaTags = [...newState.traumaTags, ...delta.addedTraumaTags];
  }
  
  if (delta.removedTraumaTags) {
    newState.traumaTags = newState.traumaTags.filter(tag => !delta.removedTraumaTags!.includes(tag));
  }
  
  // Psychological flags
  if (delta.flagsDelta) {
    newState.flags = { ...newState.flags, ...delta.flagsDelta };
  }
  
  // Psychological profile
  if (delta.profileDelta) {
    newState.psychologicalProfile = { ...newState.psychologicalProfile, ...delta.profileDelta };
  }
  
  // Hidden state
  if (delta.hiddenStateDelta) {
    newState.hiddenState = { ...newState.hiddenState, ...delta.hiddenStateDelta };
  }
  
  // Memory integrity
  if (delta.memoryIntegrity) {
    newState.memoryIntegrity = delta.memoryIntegrity;
  }
  
  // Difficulty
  if (delta.difficulty) {
    newState.difficulty = delta.difficulty;
  }
  
  // Ending archetype
  if (delta.viableEnding) {
    newState.viableEnding = delta.viableEnding;
  }
  
  // Context history
  if (delta.fullContextHistory) {
    // Full context replacement (when context is completely different)
    newState.contextHistory = delta.fullContextHistory;
  } else if (delta.contextHistoryAddition) {
    // Incremental addition (when context grows by appending)
    newState.contextHistory = newState.contextHistory + '\n' + delta.contextHistoryAddition;
  }
  
  // Actions history
  if (delta.fullActionsHistory) {
    // Full actions replacement (when actions are completely different)
    newState.actionsHistory = delta.fullActionsHistory;
  } else if (delta.addedActions) {
    // Incremental additions (most common case)
    newState.actionsHistory = [...newState.actionsHistory, ...delta.addedActions];
  }

  // Threads management
  if (delta.fullThreads) {
    // Full threads replacement (when threads are completely different)
    newState.threads = delta.fullThreads;
  } else {
    // Apply incremental thread changes
    if (delta.addedThreads) {
      // Add new threads
      newState.threads = [...newState.threads, ...delta.addedThreads];
    }

    if (delta.removedThreads) {
      // Remove threads by ID
      newState.threads = newState.threads.filter(thread => !delta.removedThreads!.includes(thread.id));
    }

    if (delta.updatedThreads) {
      // Update existing threads
      for (const { id, updates } of delta.updatedThreads) {
        const threadIndex = newState.threads.findIndex(t => t.id === id);
        if (threadIndex !== -1) {
          newState.threads[threadIndex] = { ...newState.threads[threadIndex], ...updates };
        }
      }
    }
  }

  // Update page information
  newState.pageId = delta.pageId;
  newState.page = delta.page;

  return newState;
}

// ============================================================================
// DELTA RETRIEVAL
// ============================================================================

/**
 * Gets state delta for a specific page
 * 
 * @param userId - User identifier
 * @param pageId - Page identifier
 * @returns Promise resolving to delta or null if not found
 */
export async function getStateDelta(
  userId: string, 
  pageId: string
): Promise<StateDelta | null> {
  const measurement = createReliabilityMeasurement('delta_retrieval', 'delta_service', userId, {
    userId,
    pageId,
    operation: 'getStateDelta'
  });

  try {
    const delta = await withCircuitBreaker(
      () => retryOperation(async () => {
        const result = await dbRead
          .select()
          .from(storyStateDeltas)
          .where(and(
            eq(storyStateDeltas.userId, userId),
            eq(storyStateDeltas.pageId, pageId)
          ))
          .limit(1);
          
        return result[0]?.delta || null;
      }),
      `${GET_DELTA_KEY_PREFIX}:${userId}`,
      GET_DELTA_CIRCUIT_THRESHOLD,
      GET_DELTA_CIRCUIT_TIMEOUT
    );

    completeReliabilityMeasurement(measurement, true, {
      cached: false,
      deltaFound: delta !== null
    });

    return delta;
  } catch (error) {
    console.error(`[getStateDelta] ❌ Failed to get delta for user ${userId}, page ${pageId}:`, getErrorMessage(error));
    
    completeReliabilityMeasurement(measurement, false, {
      error: getErrorMessage(error),
      cached: false,
      deltaFound: false
    });

    throw new Error(`Unable to retrieve state delta: ${getErrorMessage(error)}`, { cause: error });
  }
}

/**
 * Gets all deltas for a user's book
 * 
 * @param userId - User identifier
 * @param bookId - Book identifier
 * @param limit - Maximum number of deltas to retrieve (default: 100)
 * @returns Promise resolving to array of deltas ordered by creation date
 */
export async function getUserBookDeltas(
  userId: string,
  bookId: string,
  limit: number = 100
): Promise<StateDelta[]> {
  try {
    const deltas = await dbRead
      .select()
      .from(storyStateDeltas)
      .where(and(
        eq(storyStateDeltas.userId, userId),
        eq(storyStateDeltas.bookId, bookId)
      ))
      .orderBy(desc(storyStateDeltas.createdAt))
      .limit(limit);
      
    return deltas.map(d => d.delta);
  } catch (error) {
    console.error(`[getUserBookDeltas] ❌ Failed to get deltas for user ${userId}, book ${bookId}:`, getErrorMessage(error));
    throw new Error(`Unable to retrieve user deltas: ${getErrorMessage(error)}`, { cause: error });
  }
}

/**
 * Gets deltas for a range of pages
 * 
 * @param userId - User identifier
 * @param bookId - Book identifier
 * @param fromPage - Starting page number (inclusive)
 * @param toPage - Ending page number (inclusive)
 * @returns Promise resolving to array of deltas in page order
 */
export async function getPageRangeDeltas(
  userId: string,
  bookId: string,
  fromPage: number,
  toPage: number
): Promise<StateDelta[]> {
  try {
    // Use the new compound index for efficient page range queries
    // This leverages the story_state_deltas_page_range_idx index on (bookId, page)
    const deltas = await dbRead
      .select()
      .from(storyStateDeltas)
      .where(and(
        eq(storyStateDeltas.userId, userId),
        eq(storyStateDeltas.bookId, bookId),
        // Use raw SQL for page range query to utilize the JSON path index
        sql`(delta->>'page')::int >= ${fromPage}`,
        sql`(delta->>'page')::int <= ${toPage}`
      ))
      .orderBy(sql`(delta->>'page')::int`);
    
    return deltas.map(row => row.delta);
  } catch (error) {
    console.error(`[getPageRangeDeltas] ❌ Failed to get range deltas for user ${userId}, book ${bookId}:`, getErrorMessage(error));
    throw new Error(`Unable to retrieve range deltas: ${getErrorMessage(error)}`, { cause: error });
  }
}

// ============================================================================
// DELTA CREATION
// ============================================================================

/**
 * Creates a state delta between two states
 * 
 * @param userId - User identifier
 * @param bookId - Book identifier
 * @param pageId - Page identifier
 * @param fromState - Previous story state
 * @param toState - New story state
 * @returns Promise resolving when delta is created
 */
export async function createStateDeltaRecord(
  userId: string,
  bookId: string, 
  pageId: string, 
  fromState: StoryState, 
  toState: StoryState
): Promise<void> {
  const measurement = createReliabilityMeasurement('delta_creation', 'delta_service', userId, {
    userId,
    bookId,
    pageId,
    operation: 'createStateDeltaRecord'
  });

  try {
    console.log(`[createStateDeltaRecord] 🔄 Creating delta for user ${userId}, page ${pageId}`);
    
    const delta = createStateDelta(fromState, toState, pageId);
    
    await withCircuitBreaker(
      () => retryOperation(async () => {
        await dbWrite
          .insert(storyStateDeltas)
          .values({
            userId,
            bookId,
            pageId,
            delta,
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [storyStateDeltas.userId, storyStateDeltas.bookId, storyStateDeltas.pageId],
            set: {
              delta,
              createdAt: new Date(),
              updatedAt: new Date(),
            }
          });
      }),
      `${CREATE_DELTA_KEY_PREFIX}:${userId}`,
      CREATE_DELTA_CIRCUIT_THRESHOLD,
      CREATE_DELTA_CIRCUIT_TIMEOUT
    );
      
    completeReliabilityMeasurement(measurement, true, {
      cached: false,
      deltaSize: JSON.stringify(delta).length
    });
    
    console.log(`[createStateDeltaRecord] ✅ Delta created for page ${pageId}`);
  } catch (error) {
    console.error(`[createStateDeltaRecord] ❌ Failed to create delta for user ${userId}, page ${pageId}:`, getErrorMessage(error));
    
    completeReliabilityMeasurement(measurement, false, {
      error: getErrorMessage(error),
      cached: false,
      deltaSize: 0
    });

    throw new Error(`Unable to create state delta: ${getErrorMessage(error)}`, { cause: error });
  }
}

// ============================================================================
// DELTA MANAGEMENT
// ============================================================================

/**
 * Cleans up old deltas to maintain storage efficiency
 * 
 * @param userId - User identifier
 * @param bookId - Book identifier
 * @param keepPages - Number of recent pages to keep deltas for (default: 50)
 * @returns Promise resolving to cleanup results
 */
export async function cleanupOldDeltas(
  userId: string,
  bookId: string,
  keepPages: number = 50
): Promise<{ deleted: number; kept: number }> {
  try {
    console.log(`[cleanupOldDeltas] 🧹 Cleaning up deltas for user ${userId}, book ${bookId} (keep: ${keepPages})`);
    
    const deltas = await dbRead
      .select()
      .from(storyStateDeltas)
      .where(and(
        eq(storyStateDeltas.userId, userId),
        eq(storyStateDeltas.bookId, bookId)
      ))
      .orderBy(desc(storyStateDeltas.createdAt));
    
    if (deltas.length <= keepPages) {
      console.log(`[cleanupOldDeltas] ✅ No cleanup needed (${deltas.length} <= ${keepPages})`);
      return { deleted: 0, kept: deltas.length };
    }
    
    const toDelete = deltas.slice(keepPages);
    
    if (toDelete.length > 0) {
      await dbWrite
        .delete(storyStateDeltas)
        .where(
          inArray(
            storyStateDeltas.id, 
            toDelete.map(d => d.id)
          )
        );
      
      console.log(`[cleanupOldDeltas] 🗑️ Deleted ${toDelete.length} old deltas`);
    }
    
    const result = { 
      deleted: toDelete.length, 
      kept: deltas.length - toDelete.length 
    };
    
    console.log(`[cleanupOldDeltas] ✅ Cleanup complete: ${result.kept} kept, ${result.deleted} deleted`);
    return result;
  } catch (error) {
    console.error(`[cleanupOldDeltas] ❌ Failed to cleanup deltas for user ${userId}, book ${bookId}:`, getErrorMessage(error));
    throw new Error(`Unable to cleanup deltas: ${getErrorMessage(error)}`, { cause: error });
  }
}

/**
 * Deletes all deltas for a user's book
 * 
 * @param userId - User identifier
 * @param bookId - Book identifier
 * @returns Promise resolving when deltas are deleted
 */
export async function deleteAllDeltas(
  userId: string,
  bookId: string
): Promise<void> {
  try {
    console.log(`[deleteAllDeltas] 🗑️ Deleting all deltas for user ${userId}, book ${bookId}`);
    
    await dbWrite
      .delete(storyStateDeltas)
      .where(and(
        eq(storyStateDeltas.userId, userId),
        eq(storyStateDeltas.bookId, bookId)
      ));
      
    console.log(`[deleteAllDeltas] ✅ All deltas deleted`);
  } catch (error) {
    console.error(`[deleteAllDeltas] ❌ Failed to delete deltas for user ${userId}, book ${bookId}:`, getErrorMessage(error));
    throw new Error(`Unable to delete deltas: ${getErrorMessage(error)}`, { cause: error });
  }
}

/**
 * Gets delta statistics for a user's book
 * 
 * @param userId - User identifier
 * @param bookId - Book identifier
 * @returns Promise resolving to delta statistics
 */
export async function getDeltaStatistics(
  userId: string,
  bookId: string
): Promise<{
  total: number;
  averageSize: number;
  oldest?: Date;
  newest?: Date;
  pagesCovered: number;
}> {
  try {
    const deltas = await dbRead
      .select({
        delta: storyStateDeltas.delta,
        createdAt: storyStateDeltas.createdAt
      })
      .from(storyStateDeltas)
      .where(and(
        eq(storyStateDeltas.userId, userId),
        eq(storyStateDeltas.bookId, bookId)
      ));
    
    if (deltas.length === 0) {
      return {
        total: 0,
        averageSize: 0,
        pagesCovered: 0
      };
    }
    
    const sizes = deltas.map(d => JSON.stringify(d.delta).length);
    const averageSize = sizes.reduce((sum, size) => sum + size, 0) / sizes.length;
    const pagesCovered = new Set(deltas.map(d => d.delta.pageId)).size;
    
    return {
      total: deltas.length,
      averageSize: Math.round(averageSize),
      oldest: new Date(Math.min(...deltas.map(d => d.createdAt.getTime()))),
      newest: new Date(Math.max(...deltas.map(d => d.createdAt.getTime()))),
      pagesCovered
    };
  } catch (error) {
    console.error(`[getDeltaStatistics] ❌ Failed to get statistics for user ${userId}, book ${bookId}:`, getErrorMessage(error));
    throw new Error(`Unable to get delta statistics: ${getErrorMessage(error)}`, { cause: error });
  }
}
