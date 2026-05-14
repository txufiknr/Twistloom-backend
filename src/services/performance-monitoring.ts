/**
 * Performance Monitoring Service for Story State Delta & Snapshot System
 * 
 * Provides comprehensive metrics tracking, performance analysis, and
 * monitoring capabilities for delta/snapshot reconstruction system.
 */

import { getErrorMessage } from "../utils/error.js";

// ============================================================================
// TYPES AND INTERFACES
// ============================================================================

/** Performance metric entry structure */
export interface PerformanceMetric {
  type: string;                    // 'reconstruction', 'delta_creation', 'cleanup', etc.
  operation: string;                // 'snapshot_plus_deltas', 'direct', 'fallback', etc.
  userId: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  timestamp: Date;
  metadata: Record<string, unknown>;     // Additional context like deltasApplied, snapshotsUsed, etc.
}

/** Performance statistics for a metric type */
export interface PerformanceStats {
  type: string;
  timeRangeMs: number;
  totalOperations: number;
  averageDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  medianDurationMs: number;
  p95DurationMs: number;
  p99DurationMs: number;
  operationsWithinTarget: number;
  targetComplianceRate: number;
}

/** Comprehensive performance report */
export interface PerformanceReport {
  timeRangeMs: number;
  generatedAt: Date;
  metrics: Record<string, PerformanceStats>;
  summary: {
    totalOperations: number;
    averageComplianceRate: number;
    performanceGrade: string;
    compliantTypes: number;
  };
}

/** Health check result */
export interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'warning';
  issues: string[];
  recommendations: string[];
  timestamp: Date;
}

/** Performance measurement context */
export interface PerformanceMeasurement {
  type: string;
  operation: string;
  userId: string;
  startTime: number;
  metadata: Record<string, unknown>;
  end: (additionalMetadata?: Record<string, unknown>) => PerformanceMetric;
}

/** User performance metrics */
export interface UserPerformanceMetrics {
  [type: string]: {
    totalOperations: number;
    averageDurationMs: number;
    minDurationMs: number;
    maxDurationMs: number;
    operations: PerformanceMetric[];
  };
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

/** In-memory metrics storage (in production, use Redis or similar) */
const performanceMetrics = new Map<string, PerformanceMetric[]>();

/** Metrics configuration */
const METRICS_CONFIG: MetricsConfig = {
  // Retention period for metrics (in milliseconds)
  RETENTION_PERIOD: 24 * 60 * 60 * 1000, // 24 hours
  
  // Maximum number of metrics entries to keep
  MAX_ENTRIES: 10000,
  
  // Performance targets
  PERFORMANCE_TARGETS: {
    RECONSTRUCTION_TIME_MS: 20,    // 90% of requests should be < 20ms
    DELTA_APPLICATION_TIME_MS: 5,   // Individual delta application
    SNAPSHOT_SELECTION_TIME_MS: 10, // Snapshot selection algorithm
    CACHE_HIT_RATE_TARGET: 0.85,   // 85% cache hit rate
    DATABASE_QUERY_TARGET: 5       // Individual database queries
  }
};

// ============================================================================
// METRICS COLLECTION
// ============================================================================

/**
 * Starts performance measurement for an operation
 * 
 * @param type - Type of operation being measured
 * @param operation - Specific operation name
 * @param userId - User ID for operation
 * @param metadata - Additional context
 * @returns Performance measurement context
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
     * Ends the performance measurement and records the metric
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
      
      recordMetric(metric);
      return metric;
    }
  };
}

/**
 * Records a performance metric
 * 
 * @param metric - Performance metric to record
 */
export function recordMetric(metric: PerformanceMetric): void {
  try {
    // Add to metrics storage
    if (!performanceMetrics.has(metric.type)) {
      performanceMetrics.set(metric.type, []);
    }
    
    const typeMetrics = performanceMetrics.get(metric.type)!;
    typeMetrics.push(metric);
    
    // Cleanup old metrics if needed
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
 * Checks if performance targets are met and logs warnings
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
// METRICS ANALYSIS
// ============================================================================

/**
 * Gets performance statistics for a specific metric type
 * 
 * @param type - Metric type to analyze
 * @param timeRangeMs - Time range in milliseconds (default: 1 hour)
 * @returns Performance statistics object
 */
export function getPerformanceStats(type: string, timeRangeMs: number = 60 * 60 * 1000): PerformanceStats | null {
  try {
    const metrics = performanceMetrics.get(type) || [];
    const cutoffTime = Date.now() - timeRangeMs;
    const recentMetrics = metrics.filter(m => m.timestamp.getTime() > cutoffTime);
    
    if (recentMetrics.length === 0) {
      return {
        type,
        timeRangeMs,
        totalOperations: 0,
        averageDurationMs: 0,
        minDurationMs: 0,
        maxDurationMs: 0,
        medianDurationMs: 0,
        p95DurationMs: 0,
        p99DurationMs: 0,
        operationsWithinTarget: 0,
        targetComplianceRate: 0
      };
    }
    
    const durations = recentMetrics.map(m => m.durationMs).sort((a, b) => a - b);
    const targetKey = `${type.toUpperCase()}_TIME_MS` as keyof typeof METRICS_CONFIG.PERFORMANCE_TARGETS;
    const target = METRICS_CONFIG.PERFORMANCE_TARGETS[targetKey] || METRICS_CONFIG.PERFORMANCE_TARGETS.RECONSTRUCTION_TIME_MS;
    
    const stats: PerformanceStats = {
      type,
      timeRangeMs,
      totalOperations: recentMetrics.length,
      averageDurationMs: durations.reduce((sum, d) => sum + d, 0) / durations.length,
      minDurationMs: durations[0],
      maxDurationMs: durations[durations.length - 1],
      medianDurationMs: durations[Math.floor(durations.length / 2)],
      p95DurationMs: durations[Math.floor(durations.length * 0.95)],
      p99DurationMs: durations[Math.floor(durations.length * 0.99)],
      operationsWithinTarget: durations.filter(d => d <= target).length,
      targetComplianceRate: durations.filter(d => d <= target).length / durations.length
    };
    
    return stats;
    
  } catch (error) {
    console.error(`[getPerformanceStats] ❌ Failed to get performance stats for type ${type}:`, getErrorMessage(error));
    return null;
  }
}

/**
 * Gets comprehensive performance report for all metric types
 * 
 * @param timeRangeMs - Time range in milliseconds (default: 1 hour)
 * @returns Comprehensive performance report
 */
export function getPerformanceReport(timeRangeMs: number = 60 * 60 * 1000): PerformanceReport {
  const report: PerformanceReport = {
    timeRangeMs,
    generatedAt: new Date(),
    metrics: {},
    summary: {
      totalOperations: 0,
      averageComplianceRate: 0,
      performanceGrade: 'A',
      compliantTypes: 0
    }
  };
  
  const metricTypes = ['reconstruction', 'delta_creation', 'snapshot_selection', 'cleanup'];
  let totalOperations = 0;
  let totalCompliance = 0;
  let compliantTypes = 0;
  
  for (const type of metricTypes) {
    const stats = getPerformanceStats(type, timeRangeMs);
    if (stats) {
      report.metrics[type] = stats;
      totalOperations += stats.totalOperations;
      totalCompliance += stats.targetComplianceRate;
      if (stats.targetComplianceRate >= 0.9) compliantTypes++;
    }
  }
  
  report.summary.totalOperations = totalOperations;
  report.summary.averageComplianceRate = metricTypes.length > 0 ? totalCompliance / metricTypes.length : 0;
  report.summary.compliantTypes = compliantTypes;
  
  // Calculate performance grade
  const complianceRate = report.summary.averageComplianceRate;
  if (complianceRate >= 0.95) report.summary.performanceGrade = 'A';
  else if (complianceRate >= 0.90) report.summary.performanceGrade = 'B';
  else if (complianceRate >= 0.80) report.summary.performanceGrade = 'C';
  else if (complianceRate >= 0.70) report.summary.performanceGrade = 'D';
  else report.summary.performanceGrade = 'F';
  
  return report;
}

/**
 * Gets performance metrics for a specific user
 * 
 * @param userId - User ID to get metrics for
 * @param timeRangeMs - Time range in milliseconds (default: 1 hour)
 * @returns User-specific performance metrics
 */
export function getUserPerformanceMetrics(
  userId: string, 
  timeRangeMs: number = 60 * 60 * 1000
): UserPerformanceMetrics {
  try {
    const cutoffTime = Date.now() - timeRangeMs;
    const userMetrics: UserPerformanceMetrics = {};
    
    for (const [type, metrics] of performanceMetrics.entries()) {
      const userSpecificMetrics = metrics.filter(m => 
        m.userId === userId && m.timestamp.getTime() > cutoffTime
      );
      
      if (userSpecificMetrics.length > 0) {
        const durations = userSpecificMetrics.map(m => m.durationMs);
        userMetrics[type] = {
          totalOperations: userSpecificMetrics.length,
          averageDurationMs: durations.reduce((sum, d) => sum + d, 0) / durations.length,
          minDurationMs: Math.min(...durations),
          maxDurationMs: Math.max(...durations),
          operations: userSpecificMetrics
        };
      }
    }
    
    return userMetrics;
    
  } catch (error) {
    console.error(`[getUserPerformanceMetrics] ❌ Failed to get user metrics for ${userId}:`, getErrorMessage(error));
    return {};
  }
}

// ============================================================================
// PERFORMANCE MONITORING DECORATORS
// ============================================================================

/**
 * Performance monitoring decorator for methods
 * 
 * @param type - Metric type
 * @param operation - Operation name
 * @returns Method decorator
 */
export function withPerformanceMonitoring(type: string, operation: string) {
  return function<T extends (...args: unknown[]) => Promise<unknown>>(
    target: unknown,
    propertyKey: string | symbol,
    descriptor: TypedPropertyDescriptor<T>
  ): TypedPropertyDescriptor<T> | void {
    const originalMethod = descriptor.value;
    
    if (typeof originalMethod === 'function') {
      descriptor.value = async function(this: unknown, ...args: unknown[]): Promise<unknown> {
        const userId = (args[0] as string) || 'anonymous';
        const measurement = startPerformanceMeasurement(type, operation, userId);
        
        try {
          const result = await originalMethod.apply(this, args);
          measurement.end({ success: true });
          return result;
        } catch (error) {
          measurement.end({ success: false, error: getErrorMessage(error) });
          throw error;
        }
      } as T;
    }
  };
}

/**
 * Performance monitoring wrapper for async functions
 * 
 * @param fn - Function to monitor
 * @param type - Metric type
 * @param operation - Operation name
 * @param userId - User ID
 * @returns Monitored function
 */
export function monitorAsyncFunction<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T,
  type: string,
  operation: string,
  userId: string
): T {
  return (async function(...args: unknown[]): Promise<unknown> {
    const measurement = startPerformanceMeasurement(type, operation, userId);
    
    try {
      const result = await fn(...args);
      measurement.end({ success: true, argsCount: args.length });
      return result;
    } catch (error) {
      measurement.end({ success: false, error: getErrorMessage(error) });
      throw error;
    }
  }) as T;
}

// ============================================================================
// HEALTH CHECKS
// ============================================================================

/**
 * Performs health check on performance metrics
 * 
 * @returns Health check results
 */
export function performHealthCheck(): HealthCheckResult {
  const report = getPerformanceReport(15 * 60 * 1000); // Last 15 minutes
  const health: HealthCheckResult = {
    status: 'healthy',
    issues: [],
    recommendations: [],
    timestamp: new Date()
  };
  
  // Check reconstruction performance
  const reconStats = report.metrics.reconstruction;
  if (reconStats && reconStats.targetComplianceRate < 0.8) {
    health.status = 'degraded';
    health.issues.push(`Low reconstruction performance: ${(reconStats.targetComplianceRate * 100).toFixed(1)}% compliance`);
    health.recommendations.push('Consider increasing snapshot frequency or optimizing delta application');
  }
  
  // Check delta creation performance
  const deltaStats = report.metrics.delta_creation;
  if (deltaStats && deltaStats.targetComplianceRate < 0.9) {
    health.status = 'degraded';
    health.issues.push(`Slow delta creation: ${(deltaStats.targetComplianceRate * 100).toFixed(1)}% compliance`);
    health.recommendations.push('Optimize state comparison algorithms');
  }
  
  // Check overall system health
  if (report.summary.totalOperations === 0) {
    health.status = 'warning';
    health.issues.push('No recent operations detected');
    health.recommendations.push('Verify system is actively processing requests');
  }
  
  return health;
}

// ============================================================================
// CLEANUP AND MAINTENANCE
// ============================================================================

/**
 * Cleans up old performance metrics
 * 
 * @param retentionMs - Retention period in milliseconds (default: 24 hours)
 * @returns Cleanup results
 */
export function cleanupMetrics(retentionMs: number = METRICS_CONFIG.RETENTION_PERIOD): { deleted: number; retentionMs: number } {
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

/**
 * Gets current memory usage of metrics storage
 * 
 * @returns Memory usage statistics
 */
export function getMetricsMemoryUsage(): {
  totalEntries: number;
  typeBreakdown: Record<string, number>;
  estimatedMemoryMB: number;
} {
  let totalEntries = 0;
  const typeBreakdown: Record<string, number> = {};
  
  for (const [type, metrics] of performanceMetrics.entries()) {
    totalEntries += metrics.length;
    typeBreakdown[type] = metrics.length;
  }
  
  return {
    totalEntries,
    typeBreakdown,
    estimatedMemoryMB: (totalEntries * 500) / (1024 * 1024) // Rough estimate
  };
}

// ============================================================================
// EXPORTS AND INITIALIZATION
// ============================================================================

/**
 * Initializes performance monitoring system
 * 
 * @param config - Configuration options
 */
export function initializePerformanceMonitoring(config: Partial<MetricsConfig> = {}): void {
  Object.assign(METRICS_CONFIG, config);
  
  // Set up periodic cleanup
  setInterval(() => {
    cleanupMetrics();
  }, 60 * 60 * 1000); // Cleanup every hour
  
  console.log('[PerformanceMonitoring] ✅ Performance monitoring system initialized');
  console.log(`[PerformanceMonitoring] 📊 Targets: Reconstruction < ${METRICS_CONFIG.PERFORMANCE_TARGETS.RECONSTRUCTION_TIME_MS}ms, Cache hit rate > ${(METRICS_CONFIG.PERFORMANCE_TARGETS.CACHE_HIT_RATE_TARGET * 100)}%`);
}

// Auto-initialize if this module is imported
if (typeof global !== 'undefined' && !(global as Record<string, unknown>).performanceMonitoringInitialized) {
  initializePerformanceMonitoring();
  (global as Record<string, unknown>).performanceMonitoringInitialized = true;
}

console.log('[PerformanceMonitoring] 🚀 Performance monitoring service loaded');
