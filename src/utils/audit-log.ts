/**
 * Lightweight audit logging for security-sensitive mutations.
 *
 * Writes to the existing `user_activity_logs` table using `security_*` activity
 * types. Each record captures: actor identity, action, target, source IP, and
 * user agent — sufficient for detection and forensics without a separate schema.
 *
 * Usage:
 *   await logAuditEvent(c, 'security_password_changed', 'auth');
 *   await logAuditEvent(c, 'security_account_deleted', 'user', userId);
 */

import type { Context } from "hono";
import type { AppEnv } from "../hono/env.js";
import { dbWrite } from "../db/client.js";
import { userActivityLogs } from "../db/schema.js";
import type { UserActivityType } from "../types/user.js";

type AuditContext = Context<AppEnv>;

/**
 * Append an audit event to `user_activity_logs`.
 *
 * @param c        Hono request context (must have `userId` set by requireAuth)
 * @param action   Security event type (must start with `security_`)
 * @param targetType  Entity type affected (e.g. "auth", "user", "credits", "subscription")
 * @param targetId    Optional ID of the specific entity affected
 */
export async function logAuditEvent(
  c: AuditContext,
  action: UserActivityType,
  targetType: string,
  targetId?: string,
): Promise<void> {
  try {
    const userId = c.get("userId");
    if (!userId) return;

    await dbWrite.insert(userActivityLogs).values({
      userId,
      activityType: action,
      targetType,
      targetId: targetId ?? null,
      ipAddress:
        c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
        c.req.header("x-real-ip") ??
        null,
      userAgent: c.req.header("user-agent") ?? null,
    });
  } catch {
    // Audit logging must never break the request path.
    // Failures are logged via the existing error middleware if needed.
  }
}
