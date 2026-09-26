/**
 * VIP Entitlement Middleware
 *
 * Reusable entitlement gating for VIP-only features. Exports two complementary
 * primitives so routes can pick the failure mode their API contract requires:
 *
 * 1. `resolveVipStatus` — **soft resolver**: never rejects. Loads active-VIP
 *    status for the authenticated user into `c.set("isVip", ...)` so the handler
 *    can render a domain-specific "locked" payload (HTTP 200) instead of an
 *    error. Used by surfaces that upsell rather than fail (e.g. the Reader Mind
 *    Matrix `locked: true` response).
 * 2. `requireVip` — **hard gate**: rejects with 401 when unauthenticated and
 *    403 (`code: "vip.required"`) when the authenticated user is not an active
 *    VIP. Used by endpoints where a non-VIP caller must never reach the handler.
 *
 * Both resolve entitlement through the SSOT helpers in
 * `src/services/subscription.ts` (`hasActiveVipSubscription` →
 * `isUserVipActive`), so `tier === 'vip'` **and** unexpired `vipExpiresAt` are
 * always enforced together — never one without the other.
 *
 * VIP subject semantics:
 * - These middlewares gate the **authenticated caller** (`c.get("userId")`).
 * - Routes that gate a *resource owner* different from the viewer (e.g.
 *   `GET /api/users/:identifier/mind-matrix`, which uses `optionalAuth` and
 *   checks the profile owner's VIP) must call `hasActiveVipSubscription(ownerId)`
 *   in the handler instead — middleware cannot know the subject before the
 *   route resolves `:identifier`.
 *
 * @see docs/architecture/MIDDLEWARE_ARCHITECTURE.md §6
 */

import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../hono/env.js";
import { cApiError, cUnauthorizedError } from "../utils/error.js";
import { hasActiveVipSubscription } from "../services/subscription.js";

/**
 * Resolves active-VIP status for the authenticated user into the request context.
 *
 * Soft resolver: it **never rejects** — anonymous requests resolve to
 * `isVip = false` and the chain continues. Handlers branch on
 * `c.get("isVip")` to produce a domain-specific locked/upsell payload while
 * keeping HTTP 200 semantics.
 *
 * @remarks
 * Requires an auth middleware (`requireAuth` / `optionalAuth`) earlier in the
 * chain for `userId` to be populated; otherwise the result is always `false`.
 * A database failure propagates to the route's try/catch (fail-closed for
 * entitlement reads — never assume VIP on error).
 *
 * @returns Hono middleware that populates `c.set("isVip", boolean)`
 *
 * @example
 * ```typescript
 * router.get("/feature", requireAuth, resolveVipStatus, async (c) => {
 *   if (!c.get("isVip")) {
 *     return c.json({ success: true, data: null, locked: true });
 *   }
 *   // ... serve VIP content
 * });
 * ```
 */
export const resolveVipStatus = createMiddleware<AppEnv>(async (c, next) => {
  const userId = c.get("userId");
  c.set("isVip", userId ? await hasActiveVipSubscription(userId) : false);
  await next();
});

/**
 * Hard VIP gate: rejects non-VIP (or unauthenticated) callers before the handler runs.
 *
 * - No `userId` in context → **401** `Authentication required`.
 * - Authenticated but not an active VIP → **403** with
 *   `{ success: false, error, code: "vip.required" }`.
 * - Active VIP → sets `c.set("isVip", true)` and continues.
 *
 * @remarks
 * Standalone-safe (it performs its own authentication check), but the
 * conventional chain is `requireAuth, requireVip` so auth failures are decided
 * by the auth middleware first. Do **not** use this on endpoints whose contract
 * expects a soft `locked: true` 200 response — use {@link resolveVipStatus}.
 *
 * @returns Hono middleware that either rejects or sets `c.set("isVip", true)`
 *
 * @example
 * ```typescript
 * router.post("/vip-only-action", requireAuth, requireVip, async (c) => {
 *   // Reached only by authenticated, active-VIP users
 * });
 * ```
 */
export const requireVip = createMiddleware<AppEnv>(async (c, next) => {
  const userId = c.get("userId");
  if (!userId) {
    return cUnauthorizedError(c, "Authentication required");
  }

  const isVip = await hasActiveVipSubscription(userId);
  c.set("isVip", isVip);

  if (!isVip) {
    return cApiError(
      c,
      "This feature requires an active VIP subscription",
      undefined,
      403,
      "vip.required",
    );
  }

  await next();
});
