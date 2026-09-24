/**
 * Mobile Login Issuance (SSOT)
 *
 * Single path that turns an authenticated `userId` into the native token pair
 * used by password, Google and Apple mobile sign-in routes. Keeps session
 * creation, access-JWT minting and refresh-family insert atomic (one
 * transaction) so password and OAuth exchanges cannot diverge.
 *
 * Cookie (Auth.js) issuance is intentionally untouched — web continues to call
 * `createSession` directly from `handleGoogleAuth`.
 */

import { dbRead, dbWrite } from "../db/client.js";
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

export type MobileLoginFailureReason = "missing" | "banned";

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
 */
export async function issueMobileLoginPair(
  userId: string,
): Promise<IssueMobileLoginPairResult> {
  const [userRow] = await dbRead
    .select({
      tokenVersion: users.tokenVersion,
      email: users.email,
      name: users.name,
      username: users.username,
      imageUrl: users.imageUrl,
      isNewUser: users.isNewUser,
      bannedAt: users.bannedAt,
    })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1);

  if (!userRow) return { ok: false, reason: "missing" };
  if (userRow.bannedAt) return { ok: false, reason: "banned" };

  const { sessionId, accessToken, refreshToken, familyId } =
    await dbWrite.transaction(async (tx) => {
      const sid = await createSession(userId, tx);
      const [live] = await tx
        .select({ tokenVersion: users.tokenVersion })
        .from(users)
        .where(eq(users.userId, userId))
        .limit(1);
      if (!live) throw new Error("User disappeared during login");
      const access = await issueAccessToken(userId, sid, live.tokenVersion);
      const fam = await createRefreshFamily(
        userId,
        sid,
        live.tokenVersion,
        tx,
      );
      return {
        sessionId: sid,
        accessToken: access.token,
        refreshToken: fam.refreshToken,
        familyId: fam.familyId,
      };
    });

  const admin = await resolveAdminAccess(userId);

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
      },
    },
  };
}
