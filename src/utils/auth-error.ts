import { HTTPException } from "hono/http-exception";

/**
 * Public authentication failure vocabulary, mirrored by the web client.
 *
 * These codes select client-side translations/recovery actions and may appear in
 * auth redirect URLs. Keep them stable and free of tokens, email addresses, or
 * provider/database details. They supplement the existing English `error` field.
 */
export const AUTH_ERROR_CODES = [
  "auth.invalidCredentials", "auth.socialLoginRequired", "auth.accountLocked",
  "auth.accountBanned", "auth.serviceUnavailable", "auth.sessionRevoked",
] as const;
/** Allowed public code; arbitrary exception messages are not valid auth codes. */
export type AuthErrorCode = typeof AUTH_ERROR_CODES[number];

/**
 * Carries a typed authentication policy rejection through Hono's error handler.
 *
 * `app.onError` preserves HTTP status and the English error field while adding
 * `code` for client translation. Unexpected service failures remain ordinary
 * errors; this class represents explicit 401/403 policy decisions only.
 */
export class AuthPolicyError extends HTTPException {
  /**
   * @param status - 401 for invalid/revoked identity or 403 for denied standing.
   * @param code - Stable, allowlisted public auth failure code.
   * @param message - Safe English fallback for the existing error envelope.
   */
  constructor(status: 401 | 403, public readonly code: AuthErrorCode, message: string) {
    super(status, { message });
  }
}
