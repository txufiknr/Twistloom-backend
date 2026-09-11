/** Master rollback switch for the Wall API. Enabled unless explicitly disabled. */
export const WALL_ENABLED = process.env.FEATURE_WALL_ENABLED !== 'false';

/** Sample rate for privacy-safe Wall request telemetry (0..1, failures are always logged). */
export const WALL_OBSERVABILITY_SAMPLE_RATE = parseSampleRate(
  process.env.WALL_OBSERVABILITY_SAMPLE_RATE,
  0.05,
);

function parseSampleRate(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : fallback;
}
