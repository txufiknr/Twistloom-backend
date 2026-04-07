/**
 * TypeScript declarations for performance monitoring service
 */

export interface PerformanceMetric {
  type: string;
  operation: string;
  userId: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  timestamp: Date;
  metadata: Record<string, any>;
}

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

export interface PerformanceReport {
  timeRangeMs: number;
  generatedAt: Date;
  metrics: Record<string, PerformanceStats>;
  summary: {
    totalOperations: number;
    averageComplianceRate: number;
    performanceGrade: string;
  };
}

export interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'warning';
  issues: string[];
  recommendations: string[];
  timestamp: Date;
}

export interface PerformanceMeasurement {
  type: string;
  operation: string;
  userId: string;
  startTime: number;
  metadata: Record<string, any>;
  end: (additionalMetadata?: Record<string, any>) => PerformanceMetric;
}

export function startPerformanceMeasurement(
  type: string,
  operation: string,
  userId: string,
  metadata?: Record<string, any>
): PerformanceMeasurement;

export function recordMetric(metric: PerformanceMetric): void;

export function getPerformanceStats(type: string, timeRangeMs?: number): PerformanceStats | null;

export function getPerformanceReport(timeRangeMs?: number): PerformanceReport;

export function getUserPerformanceMetrics(userId: string, timeRangeMs?: number): Record<string, any>;

export function performHealthCheck(): HealthCheckResult;

export function cleanupMetrics(retentionMs?: number): { deleted: number; retentionMs: number };

export function getMetricsMemoryUsage(): {
  totalEntries: number;
  typeBreakdown: Record<string, number>;
  estimatedMemoryMB: number;
};

export function initializePerformanceMonitoring(config?: Record<string, any>): void;

export function withPerformanceMonitoring(type: string, operation: string): any;

export function monitorAsyncFunction<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  type: string,
  operation: string,
  userId: string
): T;
