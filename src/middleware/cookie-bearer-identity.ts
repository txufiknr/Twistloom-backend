import type { Context, Next } from "hono";
import type { AppEnv } from "../hono/env.js";
import type { AuthUser } from "../types/express.js";

export type CookieUserResolver = (c: Context<AppEnv>) => Promise<AuthUser | null>;

/**
 * Resolves the existing Auth.js cookie path alongside bearer authentication.
 *
 * Bearer identity is already attached by `bearerAuthMiddleware`. When both a
 * bearer token and Auth.js cookie are present, both identities must agree.
 * With no bearer identity, the established cookie behavior is preserved.
 */
export function createCookieBearerIdentityMiddleware(
  resolveCookieUser: CookieUserResolver,
) {
  return async (c: Context<AppEnv>, next: Next): Promise<void | Response> => {
    const bearerUserId = c.get("userId");
    const hasAuthHeader = Boolean(c.req.header("authorization"));
    const hasSessionCookie = /(?:^|;\s*)(?:__Secure-)?authjs\.session-token=/.test(
      c.req.header("cookie") ?? "",
    );

    if (bearerUserId && hasAuthHeader && hasSessionCookie) {
      // Conflict detection (roadmap Step 5): both credentials present → verify
      // cookie too; different resolved identities must never silently prefer one.
      const cookieUser = await resolveCookieUser(c);
      if (cookieUser && cookieUser.id !== bearerUserId) {
        return c.json({ success: false, error: "Conflicting credentials" }, 401);
      }
      await next();
      return;
    }

    if (c.get("userId")) {
      await next();
      return;
    }

    const user = await resolveCookieUser(c);
    if (user) {
      c.set("user", user);
      c.set("userId", user.id);
    }
    await next();
  };
}