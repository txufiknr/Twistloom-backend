/**
 * Password Reset Utilities
 * 
 * Provides password reset functionality with secure token generation and verification.
 * Tokens expire after 1 hour for security.
 * 
 * @example
 * ```typescript
 * import { createPasswordResetToken, verifyPasswordResetToken, resetPassword } from '../utils/password-reset.js';
 * 
 * // Create reset token and send email
 * const token = await createPasswordResetToken('user@example.com');
 * await sendPasswordResetEmail('user@example.com', `https://app.com/reset-password?token=${token}`);
 * 
 * // Verify token and reset password
 * const userId = await verifyPasswordResetToken(token);
 * if (userId) {
 *   await resetPassword(token, 'NewSecurePassword123!');
 * }
 * ```
 */

import { dbRead, dbWrite } from '../db/client.js';
import { users, userAuth } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { generateId } from '../utils/uuid.js';
import { hashPassword } from './password.js';

/**
 * Creates a password reset token for a user
 * 
 * @param email - User email address
 * @returns Reset token if user exists, null otherwise
 * 
 * @example
 * ```typescript
 * const token = await createPasswordResetToken('user@example.com');
 * if (token) {
 *   console.log('Token created, send email');
 * } else {
 *   console.log('User not found');
 * }
 * ```
 */
export async function createPasswordResetToken(email: string): Promise<string | null> {
  const user = await dbRead
    .select({ userId: users.userId })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (user.length === 0) return null;

  const token = generateId();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour expiry

  // Create or update user_auth record
  await dbWrite
    .insert(userAuth)
    .values({
      userId: user[0].userId,
      passwordResetToken: token,
      passwordResetExpires: expiresAt,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: userAuth.userId,
      set: {
        passwordResetToken: token,
        passwordResetExpires: expiresAt,
        updatedAt: new Date(),
      },
    });

  return token;
}

/**
 * Verifies a password reset token
 * 
 * @param token - Password reset token
 * @returns User ID if token is valid and not expired, null otherwise
 * 
 * @example
 * ```typescript
 * const userId = await verifyPasswordResetToken('valid-token');
 * if (userId) {
 *   console.log('Token is valid for user:', userId);
 * }
 * ```
 */
export async function verifyPasswordResetToken(token: string): Promise<string | null> {
  const auth = await dbRead
    .select({
      userId: userAuth.userId,
      passwordResetExpires: userAuth.passwordResetExpires,
    })
    .from(userAuth)
    .where(eq(userAuth.passwordResetToken, token))
    .limit(1);

  if (auth.length === 0) return null;

  // Check if token has expired
  if (auth[0].passwordResetExpires && new Date(auth[0].passwordResetExpires) < new Date()) {
    return null;
  }

  return auth[0].userId;
}

/**
 * Resets user password using a valid reset token
 * 
 * Also revokes the token and resets failed login attempts
 * 
 * @param token - Password reset token
 * @param newPassword - New password to set
 * @returns True if password reset successful, false otherwise
 * 
 * @example
 * ```typescript
 * const success = await resetPassword('valid-token', 'NewSecurePassword123!');
 * if (success) {
 *   console.log('Password reset successful');
 * }
 * ```
 */
export async function resetPassword(token: string, newPassword: string): Promise<boolean> {
  // Verify token first (fresh read — the transaction below locks the row)
  const auth = await dbRead
    .select({
      userId: userAuth.userId,
      passwordResetExpires: userAuth.passwordResetExpires,
    })
    .from(userAuth)
    .where(eq(userAuth.passwordResetToken, token))
    .limit(1);

  if (auth.length === 0) return false;

  // Check if token has expired
  if (auth[0].passwordResetExpires && new Date(auth[0].passwordResetExpires) < new Date()) {
    return false;
  }

  const userId = auth[0].userId;
  const passwordHash = await hashPassword(newPassword);

  // Update password and clear token in a single transaction for atomicity.
  // If either update fails, everything rolls back — no partial state.
  const result = await dbWrite.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash })
      .where(eq(users.userId, userId));

    return tx
      .update(userAuth)
      .set({
        passwordResetToken: null,
        passwordResetExpires: null,
        failedLoginAttempts: 0,
        lockUntil: null,
      })
      .where(
        and(
          eq(userAuth.userId, userId),
          eq(userAuth.passwordResetToken, token)
        )
      );
  });

  // If no rows were updated, the token was already used by another request
  return result.rowCount !== null && result.rowCount > 0;
}

/**
 * Checks if a password reset token exists for a user
 * 
 * @param email - User email address
 * @returns True if a valid reset token exists, false otherwise
 * 
 * @example
 * ```typescript
 * const hasToken = await hasPasswordResetToken('user@example.com');
 * if (hasToken) {
 *   console.log('User already has a reset token');
 * }
 * ```
 */
export async function hasPasswordResetToken(email: string): Promise<boolean> {
  const user = await dbRead
    .select({ userId: users.userId })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (user.length === 0) return false;

  const auth = await dbRead
    .select({ passwordResetToken: userAuth.passwordResetToken, passwordResetExpires: userAuth.passwordResetExpires })
    .from(userAuth)
    .where(eq(userAuth.userId, user[0].userId))
    .limit(1);

  if (auth.length === 0) return false;

  const { passwordResetToken, passwordResetExpires } = auth[0];

  if (!passwordResetToken) return false;

  // Check if token has expired
  if (passwordResetExpires && new Date(passwordResetExpires) < new Date()) {
    return false;
  }

  return true;
}

/**
 * Revokes all password reset tokens for a user
 * 
 * Call this when user successfully logs in or changes password through other means
 * 
 * @param userId - User ID
 * 
 * @example
 * ```typescript
 * await revokePasswordResetTokens('user-123');
 * ```
 */
export async function revokePasswordResetTokens(userId: string): Promise<void> {
  await dbWrite
    .update(userAuth)
    .set({
      passwordResetToken: null,
      passwordResetExpires: null,
    })
    .where(eq(userAuth.userId, userId));
}
