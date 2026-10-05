/**
 * Mobile Login Issuance (SSOT)
 *
 * Single path that turns an authenticated `userId` into the native token pair
 * used by password, Google and Apple mobile sign-in routes. Keeps session
 * creation, access-JWT minting and refresh-family insert atomic (one
 * transaction) so password and OAuth exchanges cannot diverge.
 *
 * Like web issuance, native issuance locks the primary user row before checking
 * standing. No replica/profile cache can authorize a new token pair.
 */

import { dbWrite } from "../db/client.js";
import { users } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { createSession } from "./session-manager.js";
import { createRefreshFamily } from "./token-family.js";
import { issueAccessToken, getAccessTtlSeconds } from "./mobile-tokens.js";
import { resolveAdminAccess } from "../middleware/admin-auth.js";

/** Minimal user payload embedded in every mobile login response. */
export interface MobileLoginUserPayload {
  userId: string;
  email: string;
  name: string | null;
  username: string;
  imageUrl: string | null;
  isNewUser: boolean;
  isAdmin: boolean;
  sessionId: string;
  credits: number;
}

/** Response body shared by `/mobile/token`, `/mobile/google`, `/mobile/apple`. */
export interface MobileTokenPairResponse {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  tokenType: "Bearer";
  familyId: string;
  user: MobileLoginUserPayload;
}

export type MobileLoginFailureReason = "missing" | "banned" | "credentials";

export type IssueMobileLoginPairResult =
  | { ok: true; pair: MobileTokenPairResponse }
  | { ok: false; reason: MobileLoginFailureReason };

/**
 * Issues an access JWT + rotating refresh secret for [userId] and returns the
 * canonical mobile login response body.
 *
 * Fail closed when the user row is gone (`missing`) or banned (`banned`) —
 * never mint credentials for those states. Session + access token + refresh
 * family are created in one transaction so a partial failure cannot leave an
 * orphaned session without a family (or the reverse).
 *
 * @param userId - Authenticated user id (already credential-verified by caller)
 * @param verifiedPasswordHash - Exact verified password hash for password grant;
 *   rechecked under lock so a concurrent reset cannot admit the old proof.
 */
export async function issueMobileLoginPair(
  userId: string,
  verifiedPasswordHash?: string,
): Promise<IssueMobileLoginPairResult> {
  // Resolve optional display enrichment before committing credentials. Failure
  // here cannot strand a session/family that was never delivered to the client.
  const admin = await resolveAdminAccess(userId);
  const issued = await dbWrite.transaction(async (tx) => {
    const [userRow] = await tx
    .select({
      tokenVersion: users.tokenVersion,
      passwordHash: users.passwordHash,
      email: users.email,
      name: users.name,
      username: users.username,
      imageUrl: users.imageUrl,
      isNewUser: users.isNewUser,
      bannedAt: users.bannedAt,
      credits: users.credits,
    })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1).for("update");

    if (!userRow) return { ok: false, reason: "missing" } as const;
    if (userRow.bannedAt) return { ok: false, reason: "banned" } as const;
    if (verifiedPasswordHash !== undefined && userRow.passwordHash !== verifiedPasswordHash) {
      return { ok: false, reason: "credentials" } as const;
    }

    const sessionId = await createSession(userId, tx);
    const { token: accessToken } = await issueAccessToken(userId, sessionId, userRow.tokenVersion);
    const { refreshToken, familyId } = await createRefreshFamily(userId, sessionId, userRow.tokenVersion, tx);
    return { ok: true, userRow, sessionId, accessToken, refreshToken, familyId } as const;
  });
  if (!issued.ok) return issued;
  const { userRow, sessionId, accessToken, refreshToken, familyId } = issued;

  return {
    ok: true,
    pair: {
      accessToken,
      expiresIn: getAccessTtlSeconds(),
      refreshToken,
      tokenType: "Bearer",
      familyId,
      user: {
        userId,
        email: userRow.email,
        name: userRow.name,
        username: userRow.username,
        imageUrl: userRow.imageUrl,
        isNewUser: userRow.isNewUser,
        isAdmin: admin.isAdmin,
        sessionId,
        credits: userRow.credits,
      },
    },
  };
}
