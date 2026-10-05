/**
 * Primary-store authority for tracked Auth.js web sessions.
 *
 * Sign-in issues a session only after credential/provider verification; protected
 * requests look up that session and current account standing independently of
 * the middleware's immutable decoded-cookie cache.
 */
import { eq, and } from "drizzle-orm";
import { dbWrite } from "../db/client.js";
import { authSessions, users } from "../db/schema.js";
import { createSession } from "./session-manager.js";

/**
 * Loads a tracked session only when it belongs to the expected backend user.
 *
 * The join also rejects deleted users and returns their current ban status.
 * Use the primary connection (`dbWrite`) for this read: replica lag or positive
 * caching could otherwise accept a session after logout, deletion, or a ban.
 * Cookie decoding/expiry validation belongs to the caller; a non-null result
 * still requires checking `bannedAt` before granting access.
 *
 * @param sessionId - Canonical session UUID from verified Auth.js claims.
 * @param userId - Canonical owner UUID from the same verified claims.
 * @returns Current owner data/standing, or null if the session-owner pair is absent.
 * @throws Database failures, which callers must not turn into successful auth.
 */
export async function loadWebSession(sessionId: string, userId: string) {
  const [row] = await dbWrite.select({
    userId: users.userId, email: users.email, name: users.name, bannedAt: users.bannedAt,
  }).from(authSessions)
    .innerJoin(users, eq(users.userId, authSessions.userId))
    .where(and(eq(authSessions.id, sessionId), eq(authSessions.userId, userId)))
    .limit(1);
  return row ?? null;
}

/**
 * Atomically checks current account standing and creates a tracked web session.
 *
 * The primary-store user-row lock serializes issuance with concurrent updates
 * such as bans/deletion. The inserted session and returned identity come from
 * the same transaction, including canonical `isNewUser` onboarding state.
 * Device metadata is populated by later authenticated browser requests rather
 * than recording the frontend server's IP/user agent during the exchange.
 *
 * @remarks This function does not verify credentials. Callers must first verify
 *   the password or Google's signed identity. A successful result does not replace
 *   the fresh session/standing checks required on subsequent API requests.
 * @param userId - Canonical backend user UUID established by the sign-in handler.
 * @param verifiedPasswordHash - Exact hash successfully checked outside the tx;
 *   when supplied, a concurrent credential change denies issuance. OAuth omits it.
 * @returns A discriminated result: `ok: true` with user fields and sessionId,
 *   or `ok: false` with `missing`/`banned`/`credentials` and no newly issued session.
 * @throws Database failures; transaction rollback prevents a partial issuance.
 */
export async function issueWebSession(userId: string, verifiedPasswordHash?: string) {
  return dbWrite.transaction(async (tx) => {
    const [user] = await tx.select({
      userId: users.userId, email: users.email, name: users.name,
      username: users.username, imageUrl: users.imageUrl,
      isNewUser: users.isNewUser, bannedAt: users.bannedAt, passwordHash: users.passwordHash,
    }).from(users).where(eq(users.userId, userId)).limit(1).for("update");
    if (!user) return { ok: false, reason: "missing" } as const;
    if (user.bannedAt) return { ok: false, reason: "banned" } as const;
    // A password reset may commit while bcrypt runs outside this transaction.
    // Admit only the exact password hash that the caller actually verified.
    if (verifiedPasswordHash !== undefined && user.passwordHash !== verifiedPasswordHash) {
      return { ok: false, reason: "credentials" } as const;
    }
    const sessionId = await createSession(userId, tx);
    const { bannedAt: _bannedAt, passwordHash: _passwordHash, ...identity } = user;
    return { ok: true, user: { ...identity, sessionId } } as const;
  });
}
