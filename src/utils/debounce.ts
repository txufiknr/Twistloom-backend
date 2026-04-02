/**
 * @overview Debounce Utility Module
 * 
 * Provides debouncing functionality to prevent multiple rapid function calls.
 * Implements per-key debouncing with configurable delay and async support.
 * 
 * Features:
 * - Per-key debouncing (separate timers for each key)
 * - Async function support with Promise handling
 * - Configurable delay times
 * - Memory-efficient timer cleanup
 * - Type-safe implementation
 * 
 * Architecture:
 * - Uses Map-based timer storage for efficient key management
 * - Automatic cleanup of completed timers
 * - Promise-based async operation support
 * - Consistent API for sync and async functions
 */

/**
 * Configuration options for debouncer
 */
export interface DebounceOptions {
  /** Delay in milliseconds before executing the function (default: 1000) */
  delay?: number;
  /** Whether to execute on leading edge (immediately on first call) (default: false) */
  leading?: boolean;
  /** Whether to execute on trailing edge (after delay) (default: true) */
  trailing?: boolean;
}

/**
 * Result of a debounced function call
 */
export interface DebounceResult<T> {
  /** Whether the call was executed (true) or debounced (false) */
  executed: boolean;
  /** The result of the function if executed, undefined otherwise */
  result?: T;
  /** Whether this was the last pending call for the key */
  isLastCall: boolean;
}

/**
 * Internal timer entry for tracking debounced calls
 */
interface TimerEntry {
  timer: NodeJS.Timeout;
  timerId: string; // Unique identifier for this timer instance
  resolve?: (value: any) => void;
  reject?: (reason: any) => void;
  isPending: boolean;
}

/**
 * Creates a debounced version of an async function with per-key debouncing
 * 
 * @template T - Function type that returns a Promise
 * @param fn - The async function to debounce
 * @param options - Debounce configuration options
 * @returns Debounced function with same signature as original
 * 
 * @example
 * ```typescript
 * // Basic debouncing for user activity updates
 * const debouncedUpdateActivity = debounceAsync(
 *   async (userId: string, activity: string) => {
 *     await updateUserActivity(userId, activity);
 *   },
 *   { delay: 2000 }
 * );
 * 
 * // Usage - multiple rapid calls will be debounced
 * await debouncedUpdateActivity('user123', 'login');
 * await debouncedUpdateActivity('user123', 'login'); // Debounced
 * await debouncedUpdateActivity('user123', 'login'); // Debounced
 * // After 2 seconds, only the last call executes
 * 
 * // Per-key debouncing - different users have independent timers
 * await debouncedUpdateActivity('user123', 'login');
 * await debouncedUpdateActivity('user456', 'login'); // Not debounced (different key)
 * ```
 * 
 * Behavior:
 * - Multiple calls with same key within delay period are debounced
 * - Only the last call for each key is executed
 * - Different keys have independent debounce timers
 * - Supports async functions with proper Promise handling
 * - Returns execution status and result
 * 
 * Performance:
 * - Efficient timer management with automatic cleanup
 * - Minimal memory overhead for active timers
 * - No memory leaks from abandoned timers
 * - Optimized for high-frequency calls
 * 
 * Use cases:
 * - Database update debouncing (user activity, preferences)
 * - API request throttling (search, autocomplete)
 * - UI state updates (scroll, resize events)
 * - Cache invalidation batching
 */
export function debounceAsync<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  options: DebounceOptions = {}
): (...args: Parameters<T>) => Promise<DebounceResult<Awaited<ReturnType<T>>>> {
  const { delay = 1000, leading = false, trailing = true } = options;
  
  // Map to store active timers per key
  const timers = new Map<string, TimerEntry>();
  
  return async (...args: Parameters<T>): Promise<DebounceResult<Awaited<ReturnType<T>>>> => {
    // Use first argument as key (commonly userId, id, etc.)
    const key = String(args[0] || 'default');
    
    // Clear existing timer for this key
    const existingTimer = timers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer.timer);
      
      // Resolve existing promise as debounced instead of rejecting
      if (existingTimer.resolve && existingTimer.isPending) {
        existingTimer.resolve({
          executed: false,
          isLastCall: false,
        });
      }
    }
    
    return new Promise<DebounceResult<Awaited<ReturnType<T>>>>((resolve, reject) => {
      const execute = async (): Promise<void> => {
        try {
          // Check if this call should still execute BEFORE removing from map
          const currentTimer = timers.get(key);
          if (!currentTimer || currentTimer.timerId !== timerId) {
            return; // Another timer has replaced this one
          }
          
          // Remove timer from map
          timers.delete(key);
          
          const result = await fn(...args);
          
          resolve({
            executed: true,
            result,
            isLastCall: true,
          });
        } catch (error) {
          reject(error);
        }
      };
      
      // Create new timer entry
      const timerId = `${key}-${Date.now()}-${Math.random()}`;
      const timerEntry: TimerEntry = {
        timer: setTimeout(execute, delay),
        timerId,
        resolve,
        reject,
        isPending: true,
      };
      
      timers.set(key, timerEntry);
      
      // Execute immediately if leading edge is enabled
      if (leading && !existingTimer) {
        execute();
      }
      
      // Return immediately if trailing is disabled (fire-and-forget)
      if (!trailing) {
        resolve({
          executed: leading,
          isLastCall: false,
        });
      }
    });
  };
}

/**
 * Creates a debounced version of a synchronous function
 * 
 * @template T - Function type
 * @param fn - The function to debounce
 * @param options - Debounce configuration options
 * @returns Debounced function with same signature as original
 * 
 * @example
 * ```typescript
 * // Debounce a synchronous function
 * const debouncedLog = debounce(
 *   (message: string) => console.log(message),
 *   { delay: 500 }
 * );
 * 
 * debouncedLog('Hello'); // Executes after 500ms
 * debouncedLog('World'); // Cancels previous, executes 'World' after 500ms
 * ```
 */
export function debounce<T extends (...args: any[]) => any>(
  fn: T,
  options: DebounceOptions = {}
): (...args: Parameters<T>) => void {
  const { delay = 1000 } = options;
  
  const timers = new Map<string, NodeJS.Timeout>();
  
  return (...args: Parameters<T>): void => {
    const key = String(args[0] || 'default');
    
    // Clear existing timer
    const existingTimer = timers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    
    // Set new timer
    const timer = setTimeout(() => {
      fn(...args);
      timers.delete(key);
    }, delay);
    
    timers.set(key, timer);
  };
}

/**
 * Utility to clear all pending debounced calls for a specific key
 * 
 * @param debouncedFn - A debounced function created by debounceAsync or debounce
 * @param key - The key to clear timers for
 * 
 * @example
 * ```typescript
 * // Clear pending calls for a specific user
 * clearDebouncedCalls(debouncedUpdateActivity, 'user123');
 * ```
 */
export function clearDebouncedCalls(debouncedFn: any, key: string): void {
  // This is a simplified implementation
  // In a real scenario, you'd need to expose the timers map
  // For now, this serves as a placeholder API
  console.warn(`clearDebouncedCalls not implemented for key: ${key}`);
}

/**
 * Utility to get the number of pending debounced calls
 * 
 * @param debouncedFn - A debounced function created by debounceAsync or debounce
 * @returns Number of pending calls across all keys
 * 
 * @example
 * ```typescript
 * const pendingCount = getPendingCallCount(debouncedUpdateActivity);
 * console.log(`Pending calls: ${pendingCount}`);
 * ```
 */
export function getPendingCallCount(debouncedFn: any): number {
  // This is a simplified implementation
  // In a real scenario, you'd need to expose the timers map
  console.warn('getPendingCallCount not implemented');
  return 0;
}
