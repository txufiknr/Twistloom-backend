/**
 * NextAuth user information
 *
 * Previously this file augmented Express's `Request` with `userId`, `user`,
 * `headerLanguage`, and `file`. With the migration to Hono those bindings now
 * live on {@link AppEnv} (see `src/hono/env.ts`); this module only keeps the
 * shared `AuthUser` type used by the auth middleware and route environment.
 */
export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  customerId?: string;
  sessionId?: string; // Session ID for device tracking and selective logout
}
