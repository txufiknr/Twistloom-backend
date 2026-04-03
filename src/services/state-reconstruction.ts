/**
 * State Reconstruction Service
 * 
 * Provides enhanced state reconstruction dependencies for the Branch Traversal Algorithm.
 * This service integrates snapshot and delta functionality to enable optimal
 * hybrid reconstruction performance.
 * 
 * Key Features:
 * - Snapshot-based reconstruction for major checkpoints
 * - Delta-based reconstruction for incremental changes
 * - Fallback mechanisms for missing data
 * - Performance monitoring and optimization
 */

import { getPageFromDB } from "./book.js";
import { getStoryState } from "./story.js";
import { getStateSnapshot } from "./snapshots.js";
import { getStateDelta } from "./deltas.js";
import type { StateReconstructionDeps } from "../types/story.js";
import { getErrorMessage } from "../utils/error.js";

// ============================================================================
// ERROR CLASSIFICATION UTILITIES
// ============================================================================

/**
 * Classifies errors for appropriate recovery strategies
 */
function classifyError(error: unknown): 'transient' | 'critical' | 'data_corruption' {
  const message = getErrorMessage(error).toLowerCase();
  
  // Transient errors that can be retried
  if (message.includes('timeout') || 
      message.includes('connection') || 
      message.includes('network') ||
      message.includes('temporary') ||
      message.includes('rate limit')) {
    return 'transient';
  }
  
  // Data corruption issues
  if (message.includes('invalid') || 
      message.includes('corrupt') ||
      message.includes('parse') ||
      message.includes('malformed')) {
    return 'data_corruption';
  }
  
  // Critical errors that shouldn't be retried
  return 'critical';
}

/**
 * Implements exponential backoff retry logic
 */
async function retryOperation<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  let lastError: unknown;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const errorType = classifyError(error);
      
      // Don't retry critical or data corruption errors
      if (errorType === 'critical' || errorType === 'data_corruption') {
        console.error(`[retryOperation] ❌ ${errorType} error on attempt ${attempt}/${maxRetries}, not retrying:`, getErrorMessage(error));
        throw error;
      }
      
      if (attempt === maxRetries) {
        console.error(`[retryOperation] ❌ Max retries (${maxRetries}) exceeded for ${errorType} error:`, getErrorMessage(error));
        throw error;
      }
      
      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.warn(`[retryOperation] 🔄 Retrying ${errorType} error on attempt ${attempt}/${maxRetries} after ${delay}ms:`, getErrorMessage(error));
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError;
}

/**
 * Enhanced error logging with context
 */
function logErrorWithDetails(operation: string, error: unknown, context: Record<string, any>): void {
  const errorType = classifyError(error);
  const errorMessage = getErrorMessage(error);
  
  console.error(`[${operation}] ❌ ${errorType.toUpperCase()} ERROR:`, {
    message: errorMessage,
    context,
    timestamp: new Date().toISOString(),
    stack: error instanceof Error ? error.stack : undefined
  });
}

/**
 * Creates enhanced state reconstruction dependencies for a user
 * 
 * @param userId - User identifier for reconstruction operations
 * @returns StateReconstructionDeps object with all required functions
 */
export function createReconstructionDependencies(userId: string): StateReconstructionDeps {
  return {
    /**
     * Gets page data from database
     */
    getPageById: async (id: string) => {
      return await getPageFromDB(id);
    },

    /**
     * Gets state snapshot for a page
     */
    getSnapshot: async (id: string) => {
      try {
        const snapshot = await retryOperation(() => getStateSnapshot(userId, id));
        if (snapshot) {
          console.log(`[getSnapshot] 📸 Found snapshot for page ${id} (version ${snapshot.version}, ${snapshot.reason})`);
          return {
            pageId: snapshot.pageId,
            page: snapshot.page,
            state: snapshot.state,
            createdAt: snapshot.createdAt,
            version: snapshot.version,
            isMajorCheckpoint: snapshot.isMajorCheckpoint,
            reason: snapshot.reason
          };
        }
        return null;
      } catch (error) {
        logErrorWithDetails('getSnapshot', error, { userId, pageId: id });
        return null; // Only return null for critical errors after retries
      }
    },

    /**
     * Gets state delta for a page
     */
    getDelta: async (id: string) => {
      try {
        const delta = await retryOperation(() => getStateDelta(userId, id));
        if (delta) {
          console.log(`[getDelta] 🔄 Found delta for page ${id} (page ${delta.page})`);
        }
        return delta;
      } catch (error) {
        logErrorWithDetails('getDelta', error, { userId, pageId: id });
        return null; // Only return null for critical errors after retries
      }
    },

    /**
     * Gets complete story state for a page
     */
    getStoryState: async (id: string) => {
      try {
        const state = await retryOperation(() => getStoryState(userId, id));
        if (state) {
          console.log(`[getStoryState] 📋 Found complete state for page ${id}`);
        }
        return state;
      } catch (error) {
        logErrorWithDetails('getStoryState', error, { userId, pageId: id });
        return null; // Only return null for critical errors after retries
      }
    }
  };
}

/**
 * Creates reconstruction dependencies with enhanced logging
 * 
 * @param userId - User identifier
 * @param options - Additional options for reconstruction
 * @returns Enhanced StateReconstructionDeps with detailed logging
 */
export function createEnhancedReconstructionDependencies(
  userId: string,
  options: {
    enableDetailedLogging?: boolean;
    performanceTracking?: boolean;
  } = {}
): StateReconstructionDeps {
  const { enableDetailedLogging = false, performanceTracking = false } = options;
  
  return {
    getPageById: async (id: string) => {
      const startTime = performanceTracking ? Date.now() : 0;
      const result = await getPageFromDB(id);
      
      if (enableDetailedLogging) {
        const duration = performanceTracking ? Date.now() - startTime : 0;
        console.log(`[getPageById] 📄 Retrieved page ${id} in ${duration}ms`);
      }
      
      return result;
    },

    getSnapshot: async (id: string) => {
      const startTime = performanceTracking ? Date.now() : 0;
      const snapshot = await getStateSnapshot(userId, id);
      
      if (snapshot) {
        const duration = performanceTracking ? Date.now() - startTime : 0;
        console.log(`[getSnapshot] 📸 Found snapshot for page ${id} (${snapshot.reason}, v${snapshot.version}) in ${duration}ms`);
        return {
          pageId: snapshot.pageId,
          page: snapshot.page,
          state: snapshot.state,
          createdAt: snapshot.createdAt,
          version: snapshot.version,
          isMajorCheckpoint: snapshot.isMajorCheckpoint,
          reason: snapshot.reason
        };
      }
      
      if (enableDetailedLogging) {
        const duration = performanceTracking ? Date.now() - startTime : 0;
        console.log(`[getSnapshot] ❌ No snapshot found for page ${id} (${duration}ms)`);
      }
      
      return null;
    },

    getDelta: async (id: string) => {
      const startTime = performanceTracking ? Date.now() : 0;
      const delta = await getStateDelta(userId, id);
      
      if (delta) {
        const duration = performanceTracking ? Date.now() - startTime : 0;
        console.log(`[getDelta] 🔄 Found delta for page ${id} (page ${delta.page}) in ${duration}ms`);
      } else if (enableDetailedLogging) {
        const duration = performanceTracking ? Date.now() - startTime : 0;
        console.log(`[getDelta] ❌ No delta found for page ${id} (${duration}ms)`);
      }
      
      return delta;
    },

    getStoryState: async (id: string) => {
      const startTime = performanceTracking ? Date.now() : 0;
      const state = await getStoryState(userId, id);
      
      if (state) {
        const duration = performanceTracking ? Date.now() - startTime : 0;
        console.log(`[getStoryState] 📋 Found complete state for page ${id} in ${duration}ms`);
      } else if (enableDetailedLogging) {
        const duration = performanceTracking ? Date.now() - startTime : 0;
        console.log(`[getStoryState] ❌ No complete state found for page ${id} (${duration}ms)`);
      }
      
      return state;
    }
  };
}

/**
 * Creates reconstruction dependencies with caching
 * 
 * @param userId - User identifier
 * @param cacheOptions - Cache configuration options
 * @returns StateReconstructionDeps with caching support
 */
export function createCachedReconstructionDependencies(
  userId: string,
  cacheOptions: {
    snapshotCache?: Map<string, any>;
    deltaCache?: Map<string, any>;
    stateCache?: Map<string, any>;
    maxCacheSize?: number;
  } = {}
): StateReconstructionDeps {
  const {
    snapshotCache = new Map(),
    deltaCache = new Map(),
    stateCache = new Map(),
    maxCacheSize = 100
  } = cacheOptions;

  const manageCacheSize = (cache: Map<string, any>) => {
    if (cache.size > maxCacheSize) {
      const keysToDelete = Array.from(cache.keys()).slice(0, cache.size - maxCacheSize);
      keysToDelete.forEach(key => cache.delete(key));
    }
  };

  return {
    getPageById: async (id: string) => {
      return await getPageFromDB(id);
    },

    getSnapshot: async (id: string) => {
      const cacheKey = `snapshot:${userId}:${id}`;
      
      // Check cache first
      if (snapshotCache.has(cacheKey)) {
        console.log(`[getSnapshot] 🎯 Cache hit for snapshot ${id}`);
        return snapshotCache.get(cacheKey);
      }

      // Fetch from database
      const snapshot = await getStateSnapshot(userId, id);
      
      if (snapshot) {
        const result = {
          pageId: snapshot.pageId,
          page: snapshot.page,
          state: snapshot.state,
          createdAt: snapshot.createdAt,
          version: snapshot.version,
          isMajorCheckpoint: snapshot.isMajorCheckpoint,
          reason: snapshot.reason
        };

        // Cache the result
        manageCacheSize(snapshotCache);
        snapshotCache.set(cacheKey, result);
        console.log(`[getSnapshot] 📸 Cached snapshot for page ${id}`);
        return result;
      }

      return null;
    },

    getDelta: async (id: string) => {
      const cacheKey = `delta:${userId}:${id}`;
      
      // Check cache first
      if (deltaCache.has(cacheKey)) {
        console.log(`[getDelta] 🎯 Cache hit for delta ${id}`);
        return deltaCache.get(cacheKey);
      }

      // Fetch from database
      const delta = await getStateDelta(userId, id);
      
      if (delta) {
        // Cache the result
        manageCacheSize(deltaCache);
        deltaCache.set(cacheKey, delta);
        console.log(`[getDelta] 🔄 Cached delta for page ${id}`);
      }

      return delta;
    },

    getStoryState: async (id: string) => {
      const cacheKey = `state:${userId}:${id}`;
      
      // Check cache first
      if (stateCache.has(cacheKey)) {
        console.log(`[getStoryState] 🎯 Cache hit for state ${id}`);
        return stateCache.get(cacheKey);
      }

      // Fetch from database
      const state = await getStoryState(userId, id);
      
      if (state) {
        // Cache the result
        manageCacheSize(stateCache);
        stateCache.set(cacheKey, state);
        console.log(`[getStoryState] 📋 Cached state for page ${id}`);
      }

      return state;
    }
  };
}

/**
 * Utility function to clear reconstruction caches
 * 
 * @param caches - Cache objects to clear
 */
export function clearReconstructionCaches(caches: {
  snapshotCache?: Map<string, any>;
  deltaCache?: Map<string, any>;
  stateCache?: Map<string, any>;
}): void {
  if (caches.snapshotCache) {
    caches.snapshotCache.clear();
    console.log('[clearReconstructionCaches] 🧹 Cleared snapshot cache');
  }
  
  if (caches.deltaCache) {
    caches.deltaCache.clear();
    console.log('[clearReconstructionCaches] 🧹 Cleared delta cache');
  }
  
  if (caches.stateCache) {
    caches.stateCache.clear();
    console.log('[clearReconstructionCaches] 🧹 Cleared state cache');
  }
}

/**
 * Utility function to get cache statistics
 * 
 * @param caches - Cache objects to analyze
 * @returns Cache statistics object
 */
export function getCacheStatistics(caches: {
  snapshotCache?: Map<string, any>;
  deltaCache?: Map<string, any>;
  stateCache?: Map<string, any>;
}): {
  snapshots: { size: number; keys: string[] };
  deltas: { size: number; keys: string[] };
  states: { size: number; keys: string[] };
  total: number;
} {
  const stats = {
    snapshots: {
      size: caches.snapshotCache?.size || 0,
      keys: Array.from(caches.snapshotCache?.keys() || [])
    },
    deltas: {
      size: caches.deltaCache?.size || 0,
      keys: Array.from(caches.deltaCache?.keys() || [])
    },
    states: {
      size: caches.stateCache?.size || 0,
      keys: Array.from(caches.stateCache?.keys() || [])
    },
    total: 0
  };

  stats.total = stats.snapshots.size + stats.deltas.size + stats.states.size;

  return stats;
}

/**
 * Factory function to create the appropriate reconstruction dependencies
 * 
 * @param userId - User identifier
 * @param options - Configuration options
 * @returns Optimized StateReconstructionDeps
 */
export function createOptimalReconstructionDependencies(
  userId: string,
  options: {
    enableCaching?: boolean;
    enableDetailedLogging?: boolean;
    enablePerformanceTracking?: boolean;
    maxCacheSize?: number;
  } = {}
): StateReconstructionDeps {
  const {
    enableCaching = true,
    enableDetailedLogging = false,
    enablePerformanceTracking = false,
    maxCacheSize = 100
  } = options;

  // Create base dependencies
  let deps: StateReconstructionDeps;

  if (enableCaching) {
    // Use cached dependencies for better performance
    deps = createCachedReconstructionDependencies(userId, { maxCacheSize });
  } else if (enableDetailedLogging || enablePerformanceTracking) {
    // Use enhanced dependencies with logging
    deps = createEnhancedReconstructionDependencies(userId, {
      enableDetailedLogging,
      performanceTracking: enablePerformanceTracking
    });
  } else {
    // Use basic dependencies
    deps = createReconstructionDependencies(userId);
  }

  return deps;
}
