/**
 * Trust & Safety Capability Gating Middleware (Progressive Discipline)
 *
 * Implements granular capability checks (moderation mutes, generation throttles,
 * account suspensions) without blocking safe-haven reading, status checks, or GDPR data export.
 *
 * Performance Architecture:
 * - Employs an in-memory LRU cache (`userCapabilitiesCache`, 2m TTL) to eliminate
 *   database roundtrips on high-frequency routes for healthy users.
 * - Cache is immediately invalidated upon admin enforcement actions or appeal resolutions.
 *
 * @see docs/roadmap/TRUST_AND_SAFETY_ROADMAP.md §TS.3
 */

import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../hono/env.js";
import type { UserEnforcementStatus } from "../types/trust-safety.js";
import {
  getOrFetchUserEnforcementStatus,
  invalidateUserEnforcementCache,
  getTodayGenerationCount,
} from "../services/trust-safety.js";

export { invalidateUserEnforcementCache, getOrFetchUserEnforcementStatus };
export type { UserEnforcementStatus };

// ---------------------------------------------------------------------------
// Middleware: Require Not Suspended / Banned
// ---------------------------------------------------------------------------
/**
 * Blocks write / authoring / generation actions if the user account is suspended or banned.
 * Safe-haven read routes (reading books, viewing profile, GDPR export) should NOT use this.
 */
export const requireNotSuspended = createMiddleware<AppEnv>(async (c, next) => {
  const userId = c.get("userId");
  if (!userId) {
    return await next();
  }

  const status = await getOrFetchUserEnforcementStatus(userId);
  if (status.isBanned || status.isSuspended) {
    return c.json(
      {
        error: "account_suspended",
        message: "Your account is temporarily suspended or restricted from performing this action.",
        activeActions: status.activeActions,
      },
      403
    );
  }

  await next();
});

// ---------------------------------------------------------------------------
// Middleware: Require Not Community Muted
// ---------------------------------------------------------------------------
/**
 * Blocks public community interactions (reader comments, public testimonials, follows)
 * if the user has an active community mute or suspension.
 */
export const requireNotMuted = createMiddleware<AppEnv>(async (c, next) => {
  const userId = c.get("userId");
  if (!userId) {
    return await next();
  }

  const status = await getOrFetchUserEnforcementStatus(userId);
  if (status.isBanned || status.isSuspended) {
    return c.json(
      {
        error: "account_suspended",
        message: "Your account is temporarily suspended or restricted from performing this action.",
        activeActions: status.activeActions,
      },
      403
    );
  }

  if (status.isMuted) {
    return c.json(
      {
        error: "community_muted",
        message: "Your community interaction privileges are temporarily restricted due to policy violations.",
        activeActions: status.activeActions.filter((a) => a.action === "mute_community"),
      },
      403
    );
  }

  await next();
});

// ---------------------------------------------------------------------------
// Middleware: Require Generation Quota
// ---------------------------------------------------------------------------
/**
 * Enforces probation generation caps on AI authoring & story generation routes.
 * If a user is under probation / throttle, caps daily generations to `dailyGenerationLimit` (e.g. 5/day).
 */
export const requireGenerationQuota = createMiddleware<AppEnv>(async (c, next) => {
  const userId = c.get("userId");
  if (!userId) {
    return await next();
  }

  const status = await getOrFetchUserEnforcementStatus(userId);
  if (status.isBanned || status.isSuspended) {
    return c.json(
      {
        error: "account_suspended",
        message: "Your account is temporarily suspended or restricted from generating content.",
        activeActions: status.activeActions,
      },
      403
    );
  }

  if (status.isThrottled && status.dailyGenerationLimit != null && status.dailyGenerationLimit > 0) {
    const todayCount = await getTodayGenerationCount(userId);
    if (todayCount >= status.dailyGenerationLimit) {
      return c.json(
        {
          error: "generation_quota_exceeded",
          message: `You have reached your daily generation limit (${status.dailyGenerationLimit}) under active account probation. Please try again tomorrow.`,
          dailyLimit: status.dailyGenerationLimit,
          usedToday: todayCount,
          activeActions: status.activeActions.filter(
            (a) => a.action === "limit_generation" || a.action === "limit_daily_usage"
          ),
        },
        429
      );
    }
  }

  await next();
});
