/**
 * Neon project consumption/usage reporting.
 *
 * Queries the Neon console **control-plane** API for the current project's
 * consumption metrics (compute time, active time, storage, data transfer) and
 * the start of the current billing/consumption period. This is distinct from
 * the DB liveness probe (`/health/db`): it returns billing/usage telemetry, not
 * connectivity status.
 *
 * Important:
 * - The Neon API key is a control-plane credential. It is NEVER returned by this
 *   service — only the consumption metrics are surfaced, and only behind admin
 *   authorization in the route layer.
 * - The Neon API is rate-limited and the consumption fields only meaningfully
 *   change per billing period, so the response is cached (Redis via `withCache`)
 *   for a short TTL to avoid hammering the control plane.
 */

import { withCache, CACHE_TTL } from "./cache.js";

const NEON_API_BASE = "https://console.neon.tech/api/v2";
const NEON_USAGE_CACHE_KEY = "neon:project:usage";
const NEON_USAGE_TTL = CACHE_TTL.FIVE_MINUTES;

/** Normalized Neon project consumption metrics. */
export interface NeonProjectUsage {
  projectId: string;
  /** ISO timestamp marking the start of the current consumption/billing period. */
  consumptionPeriodStart: string | null;
  /** Total compute time (seconds) consumed in the current period. */
  computeTimeSeconds: number | null;
  /** Total active time (seconds) — when an endpoint was not idle — in the period. */
  activeTimeSeconds: number | null;
  /** Current data storage, measured in byte-hours in the period. */
  dataStorageBytesHour: number | null;
  /** Data transfer (egress) in bytes for the period. */
  dataTransferBytes: number | null;
  /** When this snapshot was fetched (useful to confirm cache freshness). */
  fetchedAt: string;
}

/** Raised when the Neon API request fails or required env vars are missing. */
export class NeonApiError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "NeonApiError";
    this.status = status;
  }
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function fetchNeonProjectUsage(): Promise<NeonProjectUsage> {
  const apiKey = process.env.NEON_API_KEY;
  const projectId = process.env.NEON_PROJECT_ID;
  if (!apiKey) throw new NeonApiError("NEON_API_KEY is not configured");
  if (!projectId) throw new NeonApiError("NEON_PROJECT_ID is not configured");

  const res = await fetch(`${NEON_API_BASE}/projects/${projectId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new NeonApiError(
      `Neon API request failed (${res.status} ${res.statusText}): ${body.slice(0, 500)}`,
      res.status,
    );
  }

  const data = (await res.json()) as Record<string, unknown>;

  return {
    projectId,
    consumptionPeriodStart:
      typeof data.consumption_period_start === "string"
        ? data.consumption_period_start
        : null,
    computeTimeSeconds: toNumberOrNull(data.compute_time_seconds),
    activeTimeSeconds: toNumberOrNull(data.active_time_seconds),
    dataStorageBytesHour: toNumberOrNull(data.data_storage_bytes_hour),
    dataTransferBytes: toNumberOrNull(data.data_transfer_bytes),
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Returns the current Neon project's consumption metrics, cached for 5 minutes
 * to respect Neon API rate limits.
 *
 * @throws {NeonApiError} if the API key/project id is missing or the API request fails.
 */
export function getNeonProjectUsage(): Promise<NeonProjectUsage> {
  return withCache(NEON_USAGE_CACHE_KEY, fetchNeonProjectUsage, NEON_USAGE_TTL);
}
