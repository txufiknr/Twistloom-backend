/**
 * Reliability Utilities Module
 * 
 * Centralized reliability patterns for retry logic, circuit breakers,
 * error classification, and performance monitoring across all services.
 * 
 * Design Rationale
 * - Graceful degradation: App continues working even if monitoring fails
 * - Data integrity: Prevents false performance metrics
 * - Clear signaling: Zero duration + failure flags indicate system issues
 * - API consistency: Same interface whether monitoring works or fails
 * 
 * Architecture Benefits
 * - Consistency: All services use the same retry/circuit patterns
 * - Observability: Built-in performance monitoring and error tracking
 * - Resilience: Automatic recovery from transient failures
 * - Maintainability: Centralized reliability logic reduces duplication
 * - Debugging: Standardized error classification and logging
 * 
 * Features
 * - Error Classification: Smart retry decisions based on error type
 * - Exponential Backoff: Configurable retry with jitter for distributed systems
 * - Circuit Breaker: Prevent cascade failures with automatic recovery
 * - Performance Monitoring: Integrated metrics collection and analysis
 * - Consistent Logging: Unified error reporting across all services
 * - Type Safety: Full TypeScript support with proper interfaces
 * - Graceful Degradation: Fallback behavior when monitoring systems fail
 * 
 * @example
 * ```typescript
 * // Retry with exponential backoff
 * const result = await retryOperation(
 *   () => apiCall(),
 *   { maxRetries: 3, retryDelay: 1000 }
 * );
 * 
 * // Circuit breaker protection
 * await withCircuitBreaker(
 *   () => databaseQuery(),
 *   'db-connection',
 *   5, // threshold
 *   30000 // timeout
 * );
 * 
 * // Performance monitoring
 * const measurement = createReliabilityMeasurement(
 *   'reconstructStoryState',
 *   'story-reconstruction',
 *   userId
 * );
 * // ... operation ...
 * completeReliabilityMeasurement(measurement, true, { deltasApplied: 5 });
 * ```
 */

import { getErrorMessage } from "./error.js";
import type { PerformanceMeasurement, PerformanceMetric } from "../services/performance-monitoring.js";
import { startPerformanceMeasurement } from "../services/performance-monitoring.js";
import { 
  DEFAULT_MAX_RETRIES,
  DEFAULT_BASE_DELAY,
  DEFAULT_CIRCUIT_THRESHOLD,
  DEFAULT_CIRCUIT_TIMEOUT
} from "../config/branch-traversal.js";

// ============================================================================
// ERROR CLASSIFICATION
// ============================================================================

/** Error classification types for retry decisions */
export type ErrorType = 'transient' | 'critical' | 'data_corruption';

/**
 * Error classification for retry logic
 * 
 * @param error - Error that occurred
 * @returns Error classification type
 */
export function classifyError(error: unknown): ErrorType {
  const message = getErrorMessage(error).toLowerCase();
  
  // Transient errors that can be retried
  if (message.includes('timeout') || 
      message.includes('connection') || 
      message.includes('network') ||
      message.includes('temporary') ||
      message.includes('rate limit') ||
      message.includes('service unavailable') ||
      message.includes('database busy') ||
      message.includes('pool exhausted')) {
    return 'transient';
  }
  
  // Data corruption errors that should not be retried
  if (message.includes('invalid') || 
      message.includes('corrupt') ||
      message.includes('parse') ||
      message.includes('malformed') ||
      message.includes('schema violation') ||
      message.includes('invalid data')) {
    return 'data_corruption';
  }
  
  // Critical errors that should not be retried
  return 'critical';
}

// ============================================================================
// RETRY LOGIC
// ============================================================================

/**
 * Retry operation with exponential backoff
 * 
 * @param operation - Async operation to retry
 * @param maxRetries - Maximum number of retry attempts
 * @param baseDelay - Base delay in milliseconds
 * @returns Promise resolving to operation result
 */
export async function retryOperation<T>(
  operation: () => Promise<T>,
  maxRetries: number = DEFAULT_MAX_RETRIES,
  baseDelay: number = DEFAULT_BASE_DELAY
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
        console.error(`[Retry] ❌ ${errorType.toUpperCase()} error - not retrying:`, getErrorMessage(error));
        throw error;
      }
      
      // If this is the last attempt, throw the error
      if (attempt === maxRetries) {
        console.error(`[Retry] ❌ Max retries (${maxRetries}) exceeded for transient error:`, getErrorMessage(error));
        throw error;
      }
      
      // Calculate exponential backoff delay
      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.warn(`[Retry] ⚠️ Attempt ${attempt}/${maxRetries} failed, retrying in ${delay}ms:`, getErrorMessage(error));
      
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError;
}

// ============================================================================
// CIRCUIT BREAKER
// ============================================================================

/** Circuit breaker state interface */
export interface CircuitBreakerState {
  failureCount: number;
  lastFailureTime: number;
  isOpen: boolean;
  nextAttemptTime?: number;
}

/** Circuit breaker registry */
const circuitBreakers = new Map<string, CircuitBreakerState>();

/**
 * Circuit breaker wrapper for operations that can fail repeatedly
 * 
 * @param operation - Async operation to protect
 * @param key - Circuit breaker key for tracking
 * @param threshold - Failure threshold before opening circuit
 * @param timeoutMs - Time to keep circuit open
 * @returns Promise resolving to operation result
 */
export async function withCircuitBreaker<T>(
  operation: () => Promise<T>,
  key: string,
  threshold: number = DEFAULT_CIRCUIT_THRESHOLD,
  timeoutMs: number = DEFAULT_CIRCUIT_TIMEOUT
): Promise<T> {
  const state = circuitBreakers.get(key) || {
    failureCount: 0,
    lastFailureTime: 0,
    isOpen: false
  };
  
  // Check if circuit is open and should remain closed
  if (state.isOpen) {
    const now = Date.now();
    if (now < (state.nextAttemptTime || 0)) {
      throw new Error(`Circuit breaker open for ${key} - try again after ${new Date(state.nextAttemptTime!).toISOString()}`);
    } else {
      // Circuit timeout expired, try to close it
      state.isOpen = false;
      state.failureCount = 0;
      console.log(`[CircuitBreaker] 🔒 Circuit closed for ${key} after timeout`);
    }
  }
  
  try {
    const result = await operation();
    
    // Reset on success
    if (state.failureCount > 0) {
      console.log(`[CircuitBreaker] 🔄 Circuit reset for ${key} after success`);
      state.failureCount = 0;
    }
    
    return result;
  } catch (error) {
    state.failureCount++;
    state.lastFailureTime = Date.now();
    
    if (state.failureCount >= threshold) {
      state.isOpen = true;
      state.nextAttemptTime = Date.now() + timeoutMs;
      console.warn(`[CircuitBreaker] 🔓 Circuit opened for ${key} after ${state.failureCount} failures`);
    }
    
    throw error;
  }
}

// ============================================================================
// PERFORMANCE MONITORING HELPERS
// ============================================================================

/**
 * Enhanced performance measurement with error handling
 * 
 * @param operation - Operation name for measurement
 * @param category - Category for grouping metrics
 * @param userId - User identifier for context
 * @param context - Additional context information
 * @returns Performance measurement instance
 */
export function createReliabilityMeasurement(
  operation: string,
  category: string,
  userId: string,
  context: Record<string, unknown> = {}
): PerformanceMeasurement {
  try {
    return startPerformanceMeasurement(operation, category, userId, context);
  } catch (error) {
    console.error(`[Performance] ⚠️ Failed to start measurement for ${operation}:`, getErrorMessage(error));
    // Return a no-op measurement if performance monitoring fails
    return {
      type: category,
      operation,
      userId,
      startTime: Date.now(),
      metadata: context,
      end: (): PerformanceMetric => {
        console.warn(`[Performance] ⚠️ Measurement ended for ${operation} (startup failed)`);
        return {
          type: category,
          operation,
          userId,
          startTime: Date.now(),
          endTime: Date.now(),
          durationMs: 0, // Indicates measurement system failed, not actual performance
          timestamp: new Date(),
          metadata: {
            ...context,
            measurementFailed: true, // Explicit flag for monitoring failure
            error: "Performance monitoring system failed to initialize"
          }
        };
      }
    };
  }
}

/**
 * Ends performance measurement with standardized metadata
 * 
 * @param measurement - Performance measurement instance
 * @param success - Whether operation succeeded
 * @param additionalContext - Additional metadata to include
 */
export function completeReliabilityMeasurement(
  measurement: PerformanceMeasurement,
  success: boolean,
  additionalContext: Record<string, unknown> = {}
) {
  try {
    measurement.end({
      success,
      cached: false,
      ...additionalContext
    });
  } catch (error) {
    console.error(`[Performance] ⚠️ Failed to end measurement:`, getErrorMessage(error));
  }
}
