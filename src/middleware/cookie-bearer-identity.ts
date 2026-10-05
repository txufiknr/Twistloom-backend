import type { Context, Next } from "hono";
import type { AppEnv } from "../hono/env.js";
import type { AuthUser } from "../types/express.js";

/** Resolves a cookie identity; null means absent auth, while policy failures may throw. */
export type CookieUserResolver = (c: Context<AppEnv>) => Promise<AuthUser | null>;

/**
 * Resolves the existing Auth.js cookie path alongside bearer authentication.
 *
 * Bearer identity is already attached by `bearerAuthMiddleware`. When both a
 * bearer token and Auth.js cookie are present, both identities must agree.
 * With no bearer identity, the established cookie behavior is preserved.
 *
 * Credential/Google sign-in exchanges without an Authorization header bypass
 * cookie resolution so an expired or revoked browser cookie cannot prevent
 * reauthentication. Those handlers independently verify the submitted identity;
 * requests with an auth header retain the normal bearer/conflict checks.
 *
 * @param resolveCookieUser - Cookie verifier with fresh session/standing checks.
 * @returns Middleware that attaches cookie user/userId when bearer auth did not.
 * @throws Resolver failures; invalid cookie auth is not silently downgraded to guest.
 */
export function createCookieBearerIdentityMiddleware(
  resolveCookieUser: CookieUserResolver,
) {
  return async (c: Context<AppEnv>, next: Next): Promise<void | Response> => {
    const bearerUserId = c.get("userId");
    const hasAuthHeader = Boolean(c.req.header("authorization"));
    // These exchanges prove identity independently. A revoked/legacy browser
    // cookie must not prevent the user from signing in again.
    if (!hasAuthHeader && [
      "/api/auth/verify-credentials", "/api/auth/google-oauth", "/api/auth/google-one-tap",
    ].includes(c.req.path)) {
      await next();
      return;
    }
    const hasSessionCookie = /(?:^|;\s*)(?:__Secure-)?authjs\.session-token(?:\.\d+)?=/.test(
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
