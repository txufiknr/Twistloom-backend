/**
 * Admin authorization middleware.
 *
 * - requireAdmin: SYSTEM_USER_ID or row in admin_users
 * - requireSuperAdmin: SYSTEM_USER_ID only
 * - requirePermission(...keys): super OR admin with any of the given capability keys
 *
 * Authorization is enforced here / on routes — never rely on UI alone.
 */
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { eq } from "drizzle-orm";
import { dbRead } from "../db/client.js";
import { adminUsers } from "../db/schema.js";
import type { AppEnv } from "../hono/env.js";

/** Canonical capability keys stored in admin_users.permissions (text[]). */
export const ADMIN_PERMISSIONS = [
  "blog",
  "social_mentions",
  "testimonials",
  "feedbacks",
  "books",
  "users",
  "usage",
  "analytics",
  "announcements",
  "vouchers",
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

export function isAdminPermission(value: unknown): value is AdminPermission {
  return typeof value === "string" && (ADMIN_PERMISSIONS as readonly string[]).includes(value);
}

export function normalizePermissions(raw: unknown): AdminPermission[] {
  if (!Array.isArray(raw)) return [];
  const out: AdminPermission[] = [];
  for (const item of raw) {
    if (isAdminPermission(item) && !out.includes(item)) out.push(item);
  }
  return out;
}

export function isSuperAdminUserId(userId: string | undefined): boolean {
  const systemUserId = process.env.SYSTEM_USER_ID;
  return Boolean(systemUserId && userId && userId === systemUserId);
}

type AdminRow = {
  userId: string;
  permissions: string[] | null;
};

async function loadAdminRow(userId: string): Promise<AdminRow | null> {
  const [admin] = await dbRead
    .select({
      userId: adminUsers.userId,
      permissions: adminUsers.permissions,
    })
    .from(adminUsers)
    .where(eq(adminUsers.userId, userId))
    .limit(1);
  return admin ?? null;
}

/**
 * Resolve admin context for the current request (for /admin/me and permission checks).
 */
export async function resolveAdminAccess(userId: string): Promise<{
  isAdmin: boolean;
  isSuperAdmin: boolean;
  permissions: AdminPermission[];
}> {
  if (isSuperAdminUserId(userId)) {
    return {
      isAdmin: true,
      isSuperAdmin: true,
      permissions: [...ADMIN_PERMISSIONS],
    };
  }
  const row = await loadAdminRow(userId);
  if (!row) {
    return { isAdmin: false, isSuperAdmin: false, permissions: [] };
  }
  return {
    isAdmin: true,
    isSuperAdmin: false,
    permissions: normalizePermissions(row.permissions),
  };
}

export function adminHasPermission(
  access: { isSuperAdmin: boolean; permissions: AdminPermission[] },
  ...keys: AdminPermission[]
): boolean {
  if (access.isSuperAdmin) return true;
  if (keys.length === 0) return true;
  return keys.some((k) => access.permissions.includes(k));
}

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const userId = c.get("userId");
  if (!userId) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }
  if (isSuperAdminUserId(userId)) {
    await next();
    return;
  }
  const row = await loadAdminRow(userId);
  if (!row) {
    throw new HTTPException(403, { message: "Forbidden: admin access required" });
  }
  await next();
});

export const requireSuperAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const userId = c.get("userId");
  if (!userId) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }
  if (!isSuperAdminUserId(userId)) {
    throw new HTTPException(403, { message: "Forbidden: super admin access required" });
  }
  await next();
});

/**
 * Require admin membership and at least one of the given permission keys.
 * Super admin always passes.
 */
export function requirePermission(...keys: AdminPermission[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const userId = c.get("userId");
    if (!userId) {
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    const access = await resolveAdminAccess(userId);
    if (!access.isAdmin) {
      throw new HTTPException(403, { message: "Forbidden: admin access required" });
    }
    if (!adminHasPermission(access, ...keys)) {
      throw new HTTPException(403, {
        message: `Forbidden: requires permission (${keys.join(" | ")})`,
      });
    }
    await next();
  });
}
