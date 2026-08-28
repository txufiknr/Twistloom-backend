/**
 * Performance Monitoring Service for Story State Delta & Snapshot System
 *
 * Provides lightweight, in-process timing for the delta/snapshot reconstruction
 * system. Each reconstruction is timed via `startPerformanceMeasurement` (wired
 * through `src/utils/reliability.ts`), and operations that exceed the
 * configured performance targets are surfaced as warnings.
 *
 * Metrics are intentionally process-local: they do NOT aggregate across
 * serverless instances, and there is no cross-instance reporting layer
 * (by design — see the project's monitoring strategy). The whole collector is
 * gated by `DISABLE_PERFORMANCE_MONITORING` so it can be disabled without code
 * edits.
 */

import { getErrorMessage } from "../utils/error.js";
import { PERFORMANCE_MONITORING_ENABLED } from "../config/performance-monitoring.js";

// ============================================================================
// TYPES AND INTERFACES
// ============================================================================

/** Performance metric entry structure */
export interface PerformanceMetric {
  type: string;                    // 'reconstruction', 'delta_creation', 'cleanup', etc.
  operation: string;               // 'snapshot_plus_deltas', 'direct', 'fallback', etc.
  userId: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  timestamp: Date;
  metadata: Record<string, unknown>;     // Additional context like deltasApplied, snapshotsUsed, etc.
}

/** Performance measurement context returned by `startPerformanceMeasurement` */
export interface PerformanceMeasurement {
  type: string;
  operation: string;
  userId: string;
  startTime: number;
  metadata: Record<string, unknown>;
  end: (additionalMetadata?: Record<string, unknown>) => PerformanceMetric;
}

/** Metrics configuration */
interface MetricsConfig {
  RETENTION_PERIOD: number;
  MAX_ENTRIES: number;
  PERFORMANCE_TARGETS: {
    RECONSTRUCTION_TIME_MS: number;
    DELTA_APPLICATION_TIME_MS: number;
    SNAPSHOT_SELECTION_TIME_MS: number;
    CACHE_HIT_RATE_TARGET: number;
    DATABASE_QUERY_TARGET: number;
  };
}

// ============================================================================
// PERFORMANCE METRICS STORAGE
// ============================================================================

/** In-memory metrics storage (process-local; not shared across serverless instances) */
const performanceMetrics = new Map<string, PerformanceMetric[]>();

/** Metrics configuration */
const METRICS_CONFIG: MetricsConfig = {
  // Retention period for metrics (in milliseconds)
  RETENTION_PERIOD: 24 * 60 * 60 * 1000, // 24 hours

  // Maximum number of metrics entries to keep per type
  MAX_ENTRIES: 10000,

  // Performance targets
  PERFORMANCE_TARGETS: {
    RECONSTRUCTION_TIME_MS: 20,    // 90% of requests should be < 20ms
    DELTA_APPLICATION_TIME_MS: 5,   // Individual delta application
    SNAPSHOT_SELECTION_TIME_MS: 10, // Snapshot selection algorithm
    CACHE_HIT_RATE_TARGET: 0.85,    // 85% cache hit rate
    DATABASE_QUERY_TARGET: 5        // Individual database queries
  }
};

// ============================================================================
// METRICS COLLECTION
// ============================================================================

/**
 * Starts performance measurement for an operation.
 *
 * @param type - Type of operation being measured
 * @param operation - Specific operation name
 * @param userId - User ID for operation
 * @param metadata - Additional context
 * @returns Performance measurement context whose `end()` records the metric
 *
 * @remarks When `DISABLE_PERFORMANCE_MONITORING` is enabled, `end()` is a
 * no-op that records nothing and emits no warnings.
 */
export function startPerformanceMeasurement(
  type: string,
  operation: string,
  userId: string,
  metadata: Record<string, unknown> = {}
): PerformanceMeasurement {
  const startTime = Date.now();

  return {
    type,
    operation,
    userId,
    startTime,
    metadata,

    /**
     * Ends the performance measurement and records the metric.
     * @param additionalMetadata - Additional metadata to add at completion
     * @returns PerformanceMetric object
     */
    end: (additionalMetadata: Record<string, unknown> = {}): PerformanceMetric => {
      const endTime = Date.now();
      const metric: PerformanceMetric = {
        type,
        operation,
        userId,
        startTime,
        endTime,
        durationMs: endTime - startTime,
        timestamp: new Date(startTime),
        metadata: { ...metadata, ...additionalMetadata }
      };

      if (PERFORMANCE_MONITORING_ENABLED) {
        recordMetric(metric);
      }
      return metric;
    }
  };
}

/**
 * Records a performance metric.
 *
 * @param metric - Performance metric to record
 */
export function recordMetric(metric: PerformanceMetric): void {
  if (!PERFORMANCE_MONITORING_ENABLED) return;

  try {
    // Add to metrics storage
    if (!performanceMetrics.has(metric.type)) {
      performanceMetrics.set(metric.type, []);
    }

    const typeMetrics = performanceMetrics.get(metric.type)!;
    typeMetrics.push(metric);

    // Trim old metrics once the per-type cap is exceeded.
    if (typeMetrics.length > METRICS_CONFIG.MAX_ENTRIES) {
      const cutoffTime = Date.now() - METRICS_CONFIG.RETENTION_PERIOD;
      const firstValidIndex = typeMetrics.findIndex(m => m.timestamp.getTime() > cutoffTime);
      if (firstValidIndex > 0) {
        typeMetrics.splice(0, firstValidIndex);
      }
    }

    // Log performance warnings if targets are not met
    checkPerformanceTargets(metric);

  } catch (error) {
    console.error(`[recordMetric] ❌ Failed to record metric:`, getErrorMessage(error));
  }
}

/**
 * Checks if performance targets are met and logs warnings.
 *
 * @param metric - Performance metric to check
 */
function checkPerformanceTargets(metric: PerformanceMetric): void {
  const targets = METRICS_CONFIG.PERFORMANCE_TARGETS;

  switch (metric.type) {
    case 'reconstruction':
      if (metric.durationMs > targets.RECONSTRUCTION_TIME_MS) {
        console.warn(`[Performance] ⚠️ Slow reconstruction: ${metric.durationMs}ms (target: ${targets.RECONSTRUCTION_TIME_MS}ms) for user ${metric.userId}, operation: ${metric.operation}`);
      }
      break;

    case 'delta_creation':
      if (metric.durationMs > targets.DELTA_APPLICATION_TIME_MS) {
        console.warn(`[Performance] ⚠️ Slow delta creation: ${metric.durationMs}ms (target: ${targets.DELTA_APPLICATION_TIME_MS}ms) for user ${metric.userId}`);
      }
      break;

    case 'snapshot_selection':
      if (metric.durationMs > targets.SNAPSHOT_SELECTION_TIME_MS) {
        console.warn(`[Performance] ⚠️ Slow snapshot selection: ${metric.durationMs}ms (target: ${targets.SNAPSHOT_SELECTION_TIME_MS}ms) for user ${metric.userId}`);
      }
      break;
  }
}

// ============================================================================
// CLEANUP AND MAINTENANCE
// ============================================================================

/**
 * Cleans up old performance metrics beyond the retention window.
 *
 * @param retentionMs - Retention period in milliseconds (default: 24 hours)
 * @returns Cleanup results
 */
function cleanupMetrics(retentionMs: number = METRICS_CONFIG.RETENTION_PERIOD): { deleted: number; retentionMs: number } {
  try {
    const cutoffTime = Date.now() - retentionMs;
    let totalDeleted = 0;

    for (const [type, metrics] of performanceMetrics.entries()) {
      const originalLength = metrics.length;
      const filteredMetrics = metrics.filter(m => m.timestamp.getTime() > cutoffTime);
      performanceMetrics.set(type, filteredMetrics);
      totalDeleted += originalLength - filteredMetrics.length;
    }

    console.log(`[cleanupMetrics] 🧹 Cleaned up ${totalDeleted} old performance metrics`);
    return { deleted: totalDeleted, retentionMs };

  } catch (error) {
    console.error(`[cleanupMetrics] ❌ Failed to cleanup metrics:`, getErrorMessage(error));
    return { deleted: 0, retentionMs };
  }
}

// ============================================================================
// EXPORTS AND INITIALIZATION
// ============================================================================

/**
 * Initializes performance monitoring system.
 *
 * @param config - Configuration options
 */
export function initializePerformanceMonitoring(config: Partial<MetricsConfig> = {}): void {
  Object.assign(METRICS_CONFIG, config);

  // Set up periodic cleanup (only when monitoring is active; a lingering
  // interval keeps the event loop alive on Vercel serverless and prevents
  // freeze/teardown).
  if (PERFORMANCE_MONITORING_ENABLED) {
    setInterval(() => {
      cleanupMetrics();
    }, 60 * 60 * 1000); // Cleanup every hour
  }

  console.log('[PerformanceMonitoring] ✅ Performance monitoring system initialized');
  console.log(`[PerformanceMonitoring] 📊 Targets: Reconstruction < ${METRICS_CONFIG.PERFORMANCE_TARGETS.RECONSTRUCTION_TIME_MS}ms, Cache hit rate > ${(METRICS_CONFIG.PERFORMANCE_TARGETS.CACHE_HIT_RATE_TARGET * 100)}%`);
}

// Auto-initialize if this module is imported
if (typeof global !== 'undefined' && !(global as Record<string, unknown>).performanceMonitoringInitialized) {
  initializePerformanceMonitoring();
  (global as Record<string, unknown>).performanceMonitoringInitialized = true;
}

if (PERFORMANCE_MONITORING_ENABLED) {
  console.log('[PerformanceMonitoring] 🚀 Performance monitoring service loaded');
} else {
  console.log('[PerformanceMonitoring] ⏸️ Performance monitoring disabled (DISABLE_PERFORMANCE_MONITORING)');
}
