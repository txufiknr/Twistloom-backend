/**
 * @overview 📣 Megaphone / Global Broadcast Routes
 *
 * Public + authenticated endpoints for the global broadcast banner.
 *
 * Endpoints:
 * - GET  /api/broadcasts/current  — the single live broadcast (public, polled by clients)
 * - GET  /api/broadcasts/stream   — SSE stream of live-broadcast changes (public)
 * - GET /api/broadcasts/me       — composer state: Megaphone count + cooldown (auth)
 * - POST /api/broadcasts/preview  — validate + AI-moderate without spending (auth)
 * - POST /api/broadcasts          — submit a broadcast (consumes a Megaphone) (auth)
 * - POST /api/broadcasts/:id/report — one-tap abuse report (auth)
 *
 * Design: a broadcast is a scarce, heavily-rate-limited, globally-visible
 * message. It passes a deterministic gate + AI moderation before a 📣 Megaphone
 * is spent, and is scheduled into a single-live-slot FIFO queue. Banned users
 * can never broadcast; rejected messages never consume the item.
 *
 * @see src/services/broadcast.ts
 * @see src/config/broadcast.ts
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../hono/env.js";
import { streamSSE } from "hono/streaming";
import { requireAuth } from "../middleware/nextauth.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { getClientIp } from "../hono/express-shim.js";
import {
  cApiError,
  cValidationError,
  cNotFoundError,
} from "../utils/error.js";
import {
  getCurrentBroadcast,
  getOwnerBroadcastState,
  previewBroadcast,
  submitBroadcast,
  reportBroadcast,
  BroadcastSubmitError,
} from "../services/broadcast.js";
import {
  BROADCAST_PREVIEW_RATE_LIMIT,
  BROADCAST_SUBMIT_RATE_LIMIT,
} from "../config/ai-rate-limits.js";
import { BROADCAST_DISPLAY_SECONDS } from "../config/broadcast.js";

const router = new Hono<AppEnv>();

/**
 * GET /api/broadcasts/current
 *
 * Returns the currently-live broadcast (or `{ broadcast: null }` when none is
 * showing). Safe to call unauthenticated; intended for the global banner poll.
 *
 * @route GET /api/broadcasts/current
 */
router.get("/current", async (c) => {
  try {
    const broadcast = await getCurrentBroadcast();
    return c.json({ broadcast });
  } catch (error) {
    console.error("[GET /api/broadcasts/current] ❌ Error:", error);
    return cApiError(c, "Failed to load broadcast", error);
  }
});

/**
 * GET /api/broadcasts/stream
 *
 * SSE stream of the live broadcast. Emits a `broadcast` event whenever the
 * current message changes (or `null` when the banner is empty). The client can
 * use this instead of polling `GET /current`. Public.
 *
 * @route GET /api/broadcasts/stream
 */
router.get("/stream", async (c) => {
  return streamSSE(c, async (stream) => {
    let lastId: string | null = "__init__";
    const pollMs = Math.max(2000, (BROADCAST_DISPLAY_SECONDS * 1000) / 2);
    try {
      while (true) {
        if (stream.aborted) break;
        const broadcast = await getCurrentBroadcast();
        const id = broadcast?.id ?? null;
        if (id !== lastId) {
          lastId = id;
          await stream.writeSSE({
            event: "broadcast",
            data: JSON.stringify({ broadcast }),
          });
        }
        await stream.sleep(pollMs);
      }
    } catch (error) {
      console.error("[GET /api/broadcasts/stream] ❌ Stream error:", error);
    }
  });
});

/**
 * GET /api/broadcasts/me
 *
 * Composer state for the authenticated user: remaining Megaphones, seconds left
 * on the per-user cooldown, and whether the global queue is full.
 *
 * @route GET /api/broadcasts/me
 * @auth Required
 */
router.get("/me", requireAuth, async (c) => {
  try {
    const userId = c.get("userId")!;
    const state = await getOwnerBroadcastState(userId);
    return c.json(state);
  } catch (error) {
    console.error("[GET /api/broadcasts/me] ❌ Error:", error);
    return cApiError(c, "Failed to load broadcast state", error);
  }
});

/**
 * POST /api/broadcasts/preview
 *
 * Validates + AI-moderates a draft message WITHOUT spending a Megaphone.
 * Returns the outcome so the composer can warn the user before they commit.
 *
 * @route POST /api/broadcasts/preview
 * @auth Required
 * @body {string} message - Draft broadcast text
 * @returns `{ outcome: "approve" | "reject", message?, preview? }`
 */
router.post("/preview", requireAuth, rateLimit(BROADCAST_PREVIEW_RATE_LIMIT), async (c) => {
  try {
    const userId = c.get("userId")!;
    const { message } = c.get("body") as { message?: unknown };
    const meta = { ip: getClientIp(c), userAgent: c.req.header("user-agent") };

    const result = await previewBroadcast(userId, message, meta);
    return c.json(result);
  } catch (error) {
    if (error instanceof BroadcastSubmitError) {
      return mapSubmitError(c, error);
    }
    console.error("[POST /api/broadcasts/preview] ❌ Error:", error);
    return cApiError(c, "Failed to preview broadcast", error);
  }
});

/**
 * POST /api/broadcasts
 *
 * Submits a broadcast. Runs Gate 1 (deterministic) + ban check + Gate 2 (AI
 * moderation); only on approval is a 📣 Megaphone consumed and the message
 * scheduled into the global queue. A rejected message costs the user nothing.
 *
 * @route POST /api/broadcasts
 * @auth Required
 * @body {string} message - Broadcast text (≤140 chars)
 * @body {boolean} [containsSpoiler] - user-declared spoiler flag
 * @returns {@link BroadcastSubmitResponse} on success (201)
 */
router.post("/", requireAuth, rateLimit(BROADCAST_SUBMIT_RATE_LIMIT), async (c) => {
  try {
    const userId = c.get("userId")!;
    const { message, containsSpoiler } = c.get("body") as {
      message?: unknown;
      containsSpoiler?: boolean;
    };
    const meta = { ip: getClientIp(c), userAgent: c.req.header("user-agent") };

    const result = await submitBroadcast(userId, message, Boolean(containsSpoiler), meta);
    c.status(201);
    return c.json(result);
  } catch (error) {
    if (error instanceof BroadcastSubmitError) {
      return mapSubmitError(c, error);
    }
    console.error("[POST /api/broadcasts] ❌ Error:", error);
    return cApiError(c, "Failed to submit broadcast", error);
  }
});

/**
 * POST /api/broadcasts/:id/report
 *
 * One-tap abuse report for a broadcast. Idempotent per (broadcast, reporter).
 *
 * @route POST /api/broadcasts/:id/report
 * @auth Required
 * @body {string} reason - Short reason (bounded server-side)
 * @returns `{ reported: boolean }`
 */
router.post("/:id/report", requireAuth, async (c) => {
  try {
    const userId = c.get("userId")!;
    const broadcastId = c.req.param("id");
    const { reason } = c.get("body") as { reason?: unknown };

    if (typeof reason !== "string" || !reason.trim()) {
      return cValidationError(c, "reason is required");
    }

    const reported = await reportBroadcast(broadcastId, userId, reason);
    return c.json({ reported });
  } catch (error) {
    if (error instanceof BroadcastSubmitError && error.code === "notFound") {
      return cNotFoundError(c, "Broadcast not found");
    }
    console.error("[POST /api/broadcasts/:id/report] ❌ Error:", error);
    return cApiError(c, "Failed to report broadcast", error);
  }
});

/**
 * Maps a {@link BroadcastSubmitError} to the appropriate HTTP response.
 *
 * The body is code-driven: the client translates `code`/`rejectionReason` via
 * next-intl and echoes `matches` (the offending token(s)) so the user can
 * correct their message. The English `error` field is a non-authoritative
 * fallback only.
 */
function mapSubmitError(c: Context<AppEnv>, error: BroadcastSubmitError) {
  // The error `code` is exactly the i18n key suffix the client resolves under
  // `broadcast.errors`, so `code` alone is sufficient to render. The structured
  // `rejectionReason` is kept for telemetry/audit and the English `error` field
  // is a dev-facing / last-resort fallback only.
  const body: Record<string, unknown> = {
    error: error.message,
    code: error.code,
    matches: error.matches ?? [],
  };
  if (error.rejectionReason) {
    body.rejectionReason = error.rejectionReason;
  }
  let status: 400 | 403 | 404 | 429 = 400;
  if (error.code === "forbidden") status = 403;
  else if (error.code === "cooldown") {
    const seconds = error.retryAfterSeconds ?? BROADCAST_DISPLAY_SECONDS;
    c.header("Retry-After", String(seconds));
    status = 429;
  } else if (error.code === "queueFull") status = 429;
  else if (error.code === "notFound") status = 404;
  return c.json(body, status);
}

export default router;
