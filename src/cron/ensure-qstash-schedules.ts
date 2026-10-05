/**
 * @overview Idempotent Upstash QStash schedule registration
 *
 * Creates (or **upserts**) every schedule in {@link QSTASH_SCHEDULES} so a
 * deployment can re-run registration safely:
 *
 * - Key: the `Upstash-Schedule-Id` header. Per QStash docs, if a schedule with
 *   that ID already exists, its settings are updated in place — re-running
 *   never creates duplicates (the free tier only allows 10 schedules).
 * - Destination: `<BACKEND_URL><path>` (the explicit `VERCEL_URL` fallback is
 *   retained only as a rollback path for the Vercel deployment), called with
 *   `Upstash-Method` and, for protected endpoints, `CRON_SECRET` forwarded as
 *   `Upstash-Forward-Authorization` so the `CRON_SECRET` middleware
 *   (`src/routes/cron.ts`) accepts it.
 * - **Upsert only — removal is manual.** Deleting an entry from
 *   {@link QSTASH_SCHEDULES} and re-running leaves the live schedule firing;
 *   it must be removed through the QStash API/console
 *   (`DELETE /v2/schedules/{destination}`) or the retired endpoint keeps
 *   getting called forever.
 *
 * Why this exists instead of platform-native cron: hobby/free tiers cap cron
 * frequency (Vercel Hobby allows **one** run per day; Netlify Scheduled
 * Functions are plan-gated), so scheduled background work (e.g. the
 * credit-reservation leak sweeper) is triggered by QStash. See
 * `docs/architecture/PAYMENTS_ARCHITECTURE_BACKEND.md` §4.
 *
 * Why it is not part of `src/db/triggers.ts`: `db:triggers` / `db:reset` are a
 * database-only pipeline (fresh checkouts and CI may have no QStash token, and
 * a DB reset must never fire outbound HTTP). Registration is an explicit,
 * opt-in ops step instead.
 *
 * Usage:
 *   bun qstash:setup                              # .env.local destination
 *   bun qstash:setup:prod                         # .env.production destination
 *   bun --env-file=.env.production src/cron/ensure-qstash-schedules.ts --dry-run
 *
 * Required env: `QSTASH_TOKEN`, `CRON_SECRET`, and `BACKEND_URL` as the
 * destination base URL (`VERCEL_URL` remains an accepted legacy fallback for
 * the Vercel rollback path).
 */

import { getErrorMessage } from "../utils/error.js";

/** One QStash schedule definition — pure config, consumed by the registration run. */
export interface QStashSchedule {
  /** Stable ID used as the upsert key (`Upstash-Schedule-Id`) */
  id: string;
  /** Backend path the schedule invokes, e.g. `/api/cron/sweep-credit-reservations` */
  path: string;
  /** QStash cron expression, evaluated in UTC */
  cron: string;
  /** HTTP method the destination endpoint expects */
  method: "GET" | "POST";
  /** Forward `CRON_SECRET` to the destination (for `CRON_SECRET`-protected routes) */
  forwardCronSecret: boolean;
  /** QStash delivery retries before the message goes to the DLQ */
  retries: number;
}

/** QStash REST API base (https://upstash.com/docs/qstash) */
const QSTASH_API_BASE = "https://qstash.upstash.io/v2";

/**
 * All QStash schedules Twistloom depends on.
 *
 * Add a new entry here whenever a new `/api/cron/*` endpoint needs a scheduler;
 * re-running the script upserts it. Cadence is a latency knob — see the
 * architecture doc for the trade-off table.
 */
export const QSTASH_SCHEDULES: readonly QStashSchedule[] = [
  {
    id: "credit-reservation-sweep",
    path: "/api/cron/sweep-credit-reservations",
    cron: "*/10 * * * *",
    method: "POST",
    forwardCronSecret: true,
    retries: 3,
  },
  {
    // Audit R9: a custom action charges up front, so an orphaned row (on-demand
    // GitHub dispatch died / never started) must recover while its reader could
    // still care. The endpoint only detects + re-dispatches — it never generates
    // inline — so a 5-minute cadence costs a sub-second HTTP call, not a VM build.
    // Recovery floor is 3 minutes (CUSTOM_ACTION_GENERATION_STALE_MS), so anything
    // tighter than `*/2` would buy nothing.
    id: "custom-action-sweep",
    path: "/api/cron/sweep-custom-actions",
    cron: "*/5 * * * *",
    method: "POST",
    forwardCronSecret: true,
    retries: 3,
  },
];

/**
 * Resolves the destination base URL for scheduled calls.
 *
 * Prefers the explicit `BACKEND_URL`, falling back to `VERCEL_URL` (legacy
 * Vercel deployment / rollback path). Trailing slashes are stripped so path
 * concatenation is safe.
 *
 * @returns Base URL without a trailing slash, e.g. `https://twistloom-backend.netlify.app`
 * @throws When neither variable is set
 */
function resolveBaseUrl(): string {
  const base =
    process.env["BACKEND_URL"]?.trim() || process.env["VERCEL_URL"]?.trim();
  if (!base) {
    throw new Error(
      "BACKEND_URL (or VERCEL_URL) must be set — it is the QStash destination host"
    );
  }
  return base.replace(/\/+$/, "");
}

/**
 * Builds the request headers for one schedule upsert.
 *
 * @param schedule - Schedule definition from {@link QSTASH_SCHEDULES}
 * @param token - QStash API token (`QSTASH_TOKEN`)
 * @param cronSecret - Secret forwarded to protected cron endpoints
 * @returns Headers ready to pass to `fetch`
 */
function buildHeaders(
  schedule: QStashSchedule,
  token: string,
  cronSecret: string | undefined
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Upstash-Cron": schedule.cron,
    "Upstash-Method": schedule.method,
    "Upstash-Retries": String(schedule.retries),
    "Upstash-Schedule-Id": schedule.id,
  };
  if (schedule.forwardCronSecret) {
    if (!cronSecret) {
      throw new Error(
        `CRON_SECRET is required for schedule "${schedule.id}" (it forwards it to a protected endpoint)`
      );
    }
    headers["Upstash-Forward-Authorization"] = `Bearer ${cronSecret}`;
  }
  return headers;
}

/**
 * Creates or updates a single schedule via `POST /v2/schedules/{destination}`.
 *
 * Idempotent: the `Upstash-Schedule-Id` header makes the call an upsert, so a
 * second run with the same ID updates the existing schedule instead of
 * creating a duplicate.
 *
 * @param schedule - Schedule definition to register
 * @param baseUrl - Destination base URL
 * @param token - QStash API token
 * @param cronSecret - Secret forwarded to protected cron endpoints
 * @param dryRun - Print the request instead of sending it
 * @throws On non-2xx responses from the QStash API
 */
async function ensureSchedule(
  schedule: QStashSchedule,
  baseUrl: string,
  token: string,
  cronSecret: string | undefined,
  dryRun: boolean
): Promise<void> {
  const destination = `${baseUrl}${schedule.path}`;
  const url = `${QSTASH_API_BASE}/schedules/${destination}`;
  const headers = buildHeaders(schedule, token, cronSecret);

  if (dryRun) {
    const safeHeaders = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [
        key,
        key === "Authorization" || key === "Upstash-Forward-Authorization"
          ? `${value.slice(0, 12)}…<redacted>`
          : value,
      ])
    );
    console.log(`\n[DRY-RUN] POST ${url}`);
    console.log(JSON.stringify(safeHeaders, null, 2));
    return;
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: "{}",
  });

  if (!res.ok) {
    const body = (await res.text()).slice(0, 500);
    throw new Error(
      `QStash ${res.status} for schedule "${schedule.id}": ${body}`
    );
  }

  const payload = (await res.json()) as { scheduleId?: string };
  console.log(
    `✅ Upserted schedule "${schedule.id}" (scheduleId: ${payload.scheduleId ?? "n/a"}) → ${schedule.method} ${destination} @ ${schedule.cron}`
  );
}

/**
 * Registers every schedule in {@link QSTASH_SCHEDULES}.
 *
 * @param options.dryRun - Print requests without sending them
 * @throws When required env is missing or QStash rejects a request
 */
async function ensureQstashSchedules(options: {
  dryRun: boolean;
}): Promise<void> {
  const token = process.env["QSTASH_TOKEN"]?.trim();
  if (!token) {
    throw new Error(
      "QSTASH_TOKEN is not set — add it to this env file (see .env.example) or the Vercel dashboard"
    );
  }
  const cronSecret = process.env["CRON_SECRET"]?.trim();
  const baseUrl = resolveBaseUrl();

  if (/^(https?:\/\/)?(localhost|127\.0\.0\.1)/i.test(baseUrl)) {
    console.warn(
      `⚠️ Destination "${baseUrl}" is loopback — QStash's cloud workers cannot reach it (use a tunnel, or run against the deployed host).`
    );
  }

  console.log(
    `🗓️ Ensuring ${QSTASH_SCHEDULES.length} QStash schedule(s) → ${baseUrl}${
      options.dryRun ? " (dry run)" : ""
    }`
  );

  for (const schedule of QSTASH_SCHEDULES) {
    await ensureSchedule(schedule, baseUrl, token, cronSecret, options.dryRun);
  }

  if (!options.dryRun) {
    console.log("\n✅ All QStash schedules ensured (re-run any time — upsert only).");
  }
}

// Run only when executed directly (not when imported)
// (Bun sets import.meta.main true only for the entry module)
if (import.meta.main) {
  const dryRun = process.argv.includes("--dry-run");
  ensureQstashSchedules({ dryRun }).catch((error) => {
    console.error(
      `[qstash:setup] ❌ ${getErrorMessage(error)}`
    );
    process.exit(1);
  });
}
