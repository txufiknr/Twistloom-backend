/**
 * Email Verification Utilities
 * 
 * Provides email verification functionality with secure token generation and verification.
 * Tokens expire after 24 hours for security.
 * 
 * @example
 * ```typescript
 * import { createEmailVerificationToken, verifyEmailToken, isEmailVerified } from '../utils/email-verification.js';
 * 
 * // Create verification token and send email
 * const token = await createEmailVerificationToken('user-123');
 * await sendVerificationEmail('user@example.com', `https://app.com/verify-email?token=${token}`);
 * 
 * // Verify token and mark email as verified
 * const userId = await verifyEmailToken(token);
 * if (userId) {
 *   console.log('Email verified for user:', userId);
 * }
 * 
 * // Check if email is verified
 * const verified = await isEmailVerified('user-123');
 * ```
 */

import { dbRead, dbWrite } from '../db/client.js';
import { userAuth } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { generateId } from '../utils/uuid.js';

/**
 * Creates an email verification token for a user
 * 
 * @param userId - User ID
 * @returns Verification token
 * 
 * @example
 * ```typescript
 * const token = await createEmailVerificationToken('user-123');
 * await sendVerificationEmail('user@example.com', `https://app.com/verify-email?token=${token}`);
 * ```
 */
export async function createEmailVerificationToken(userId: string): Promise<string> {
  const token = generateId();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours expiry

  // Create or update user_auth record
  await dbWrite
    .insert(userAuth)
    .values({
      userId,
      emailVerificationToken: token,
      emailVerificationExpires: expiresAt,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: userAuth.userId,
      set: {
        emailVerificationToken: token,
        emailVerificationExpires: expiresAt,
        updatedAt: new Date(),
      },
    });

  return token;
}

/**
 * Verifies an email verification token and marks email as verified
 * 
 * @param token - Email verification token
 * @returns User ID if token is valid and not expired, null otherwise
 * 
 * @example
 * ```typescript
 * const userId = await verifyEmailToken('valid-token');
 * if (userId) {
 *   console.log('Email verified for user:', userId);
 * }
 * ```
 */
export async function verifyEmailToken(token: string): Promise<string | null> {
  // Check if token exists and is not expired first
  const auth = await dbRead
    .select({ 
      userId: userAuth.userId,
      emailVerificationExpires: userAuth.emailVerificationExpires,
    })
    .from(userAuth)
    .where(eq(userAuth.emailVerificationToken, token))
    .limit(1);

  if (auth.length === 0) return null;

  // Check if token has expired
  if (auth[0].emailVerificationExpires && new Date(auth[0].emailVerificationExpires) < new Date()) {
    return null;
  }

  // Atomic update: only mark as verified if token is still set (prevents race condition)
  const result = await dbWrite
    .update(userAuth)
    .set({
      emailVerified: new Date(),
      emailVerificationToken: null,
      emailVerificationExpires: null,
    })
    .where(
      and(
        eq(userAuth.userId, auth[0].userId),
        eq(userAuth.emailVerificationToken, token)
      )
    );

  // If no rows were updated, the token was already used by another request
  if (result.rowCount === 0) {
    return null;
  }

  return auth[0].userId;
}

/**
 * Checks if a user's email is verified
 * 
 * @param userId - User ID
 * @returns True if email is verified, false otherwise
 * 
 * @example
 * ```typescript
 * const verified = await isEmailVerified('user-123');
 * if (!verified) {
 *   console.log('Please verify your email');
 * }
 * ```
 */
export async function isEmailVerified(userId: string): Promise<boolean> {
  const auth = await dbRead
    .select({ emailVerified: userAuth.emailVerified })
    .from(userAuth)
    .where(eq(userAuth.userId, userId))
    .limit(1);

  if (auth.length === 0) return false;
  return auth[0].emailVerified !== null;
}

/**
 * Checks if a user has a pending email verification token
 * 
 * @param userId - User ID
 * @returns True if verification token exists, false otherwise
 * 
 * @example
 * ```typescript
 * const hasToken = await hasEmailVerificationToken('user-123');
 * if (hasToken) {
 *   console.log('Verification email already sent');
 * }
 * ```
 */
export async function hasEmailVerificationToken(userId: string): Promise<boolean> {
  const auth = await dbRead
    .select({ emailVerificationToken: userAuth.emailVerificationToken })
    .from(userAuth)
    .where(eq(userAuth.userId, userId))
    .limit(1);

  if (auth.length === 0) return false;
  return auth[0].emailVerificationToken !== null;
}

/**
 * Manually marks a user's email as verified (for admin use)
 * 
 * @param userId - User ID
 * 
 * @example
 * ```typescript
 * await markEmailAsVerified('user-123');
 * ```
 */
export async function markEmailAsVerified(userId: string): Promise<void> {
  await dbWrite
    .update(userAuth)
    .set({
      emailVerified: new Date(),
      emailVerificationToken: null,
    })
    .where(eq(userAuth.userId, userId));
}

/**
 * Revokes an email verification token
 * 
 * Call this when user changes email or needs a new verification token
 * 
 * @param userId - User ID
 * 
 * @example
 * ```typescript
 * await revokeEmailVerificationToken('user-123');
 * ```
 */
export async function revokeEmailVerificationToken(userId: string): Promise<void> {
  await dbWrite
    .update(userAuth)
    .set({
      emailVerificationToken: null,
    })
    .where(eq(userAuth.userId, userId));
}
