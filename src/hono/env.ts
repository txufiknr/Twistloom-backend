/**
 * Shared Hono application environment bindings.
 *
 * Defines the variables attached to every Hono `Context` via `c.set` / `c.get`.
 * These replace the previous Express `Request` augmentation (`src/types/express.d.ts`)
 * that declared `userId`, `user`, `headerLanguage`, and `file` on the Express request.
 *
 * By declaring them here once, every route and middleware shares the same typed
 * `Context` without Express-specific type augmentation.
 */

import type { AuthUser } from "../types/express.js";
import type { UploadedFile } from "../types/hono.js";

/**
 * Variables available on the Hono context for the Twistloom backend.
 *
 * - `userId`   : resolved authenticated user id (set by the auth middleware)
 * - `user`     : resolved {@link AuthUser} (set by the auth middleware)
 * - `headerLanguage` : parsed Accept-Language code (set by the locale middleware)
 * - `file`     : parsed multipart file (set by the upload middleware)
 */
export interface AppVariables {
  userId?: string;
  user?: AuthUser;
  headerLanguage?: string | null;
  file?: UploadedFile;
  /**
   * Parsed JSON request body (set by the global JSON body middleware).
   *
   * Typed as `any` intentionally: handlers read arbitrary, route-specific shapes
   * from the body and cast locally (`c.get("body") as {...}`). A stricter type
   * would force casts at every access site across the migrated routes.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body?: any;
}

/**
 * The shared Hono application environment type.
 * Use `AppEnv["Bindings"]` / `AppEnv["Variables"]` and `new Hono<AppEnv>()`.
 */
export interface AppEnv {
  Variables: AppVariables;
}
