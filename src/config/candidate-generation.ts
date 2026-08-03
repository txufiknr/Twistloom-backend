import type { SSEPollingConfig } from "../utils/sse.js";

/** Maximum generation duration before considering it stuck */
export const MAX_GENERATION_DURATION_MS = 30 * 60 * 1000; // 30 minutes
export const MAX_GENERATION_PARALLEL_DURATION_MS = 780_000; // 13 minutes for cron jobs (20s buffer)

/** Limit to prevent too many exponential pre-generation */
export const DEFAULT_CANDIDATE_PAGE_PER_ACTION = 2;
export const MAX_CANDIDATE_PAGE_PER_ACTION = 3;

// Don't apply for novel book mode (only interactive branching story with multiple actions)
export const ALLOW_DEEPER_LEVEL_UNTIL_PAGE = 3;

// SSE polling configuration
const SSE_POLL_INTERVAL_MS = 2000; // 2s
const SSE_MAX_ATTEMPTS = 150; // 5 minutes / 2s
const SSE_PROGRESS_INTERVAL = 5; // every 5 polls => 10s

// SSE polling config object for reuse
export const SSE_POLLING_CONFIG: SSEPollingConfig = {
  pollIntervalMs: SSE_POLL_INTERVAL_MS,
  maxAttempts: SSE_MAX_ATTEMPTS,
  progressInterval: SSE_PROGRESS_INTERVAL,
};