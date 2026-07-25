import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { eq } from "drizzle-orm";
import { dbRead } from "../db/client.js";
import { adminUsers } from "../db/schema.js";
import type { AppEnv } from "../hono/env.js";

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const userId = c.get("userId");
  if (!userId) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }
  const systemUserId = process.env.SYSTEM_USER_ID;
  if (systemUserId && userId === systemUserId) {
    await next();
    return;
  }
  const [admin] = await dbRead
    .select({ userId: adminUsers.userId })
    .from(adminUsers)
    .where(eq(adminUsers.userId, userId))
    .limit(1);
  if (!admin) {
    throw new HTTPException(403, { message: "Forbidden: admin access required" });
  }
  await next();
});

export const requireSuperAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const userId = c.get("userId");
  if (!userId) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }
  const systemUserId = process.env.SYSTEM_USER_ID;
  if (!systemUserId || userId !== systemUserId) {
    throw new HTTPException(403, { message: "Forbidden: super admin access required" });
  }
  await next();
});
