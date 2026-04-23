/**
 * Account Lockout Utilities
 * 
 * Provides account-based lockout mechanism to prevent brute force attacks.
 * Implements exponential backoff for failed login attempts.
 * 
 * Lockout Thresholds:
 * - 5 failed attempts: 5-minute lockout
 * - 10 failed attempts: 15-minute lockout
 * - 15 failed attempts: 1-hour lockout
 * 
 * @example
 * ```typescript
 * import { checkAccountLockout, recordFailedLogin, resetFailedLoginAttempts } from '../utils/account-lockout.js';
 * 
 * // Check if account is locked before login
 * const lockoutStatus = await checkAccountLockout(userId);
 * if (lockoutStatus.isLocked) {
 *   return res.status(429).json({ error: `Account locked. Try again in ${lockoutStatus.remainingTime}ms` });
 * }
 * 
 * // Record failed login attempt
 * if (!isValidPassword) {
 *   await recordFailedLogin(userId);
 *   return res.status(401).json({ error: 'Invalid credentials' });
 * }
 * 
 * // Reset failed attempts on successful login
 * await resetFailedLoginAttempts(userId);
 * ```
 */

import { dbRead, dbWrite } from '../db/client.js';
import { userAuth } from '../db/schema.js';
import { eq } from 'drizzle-orm';

/**
 * Lockout status for an account
 */
export interface LockoutStatus {
  /** Whether the account is currently locked */
  isLocked: boolean;
  /** Remaining lockout time in milliseconds (if locked) */
  remainingTime?: number;
  /** Current number of failed login attempts */
  attempts: number;
}

/**
 * Lockout thresholds and durations
 */
const LOCKOUT_THRESHOLDS = [5, 10, 15]; // Failed attempts that trigger lockout
const LOCKOUT_DURATIONS = [5, 15, 60]; // Corresponding lockout durations in minutes

/**
 * Checks if an account is currently locked due to failed login attempts
 * 
 * @param userId - The user ID to check
 * @returns Lockout status with lock information
 * 
 * @example
 * ```typescript
 * const lockoutStatus = await checkAccountLockout('user-123');
 * if (lockoutStatus.isLocked) {
 *   const minutesRemaining = Math.ceil(lockoutStatus.remainingTime! / 60000);
 *   console.log(`Account locked. Try again in ${minutesRemaining} minutes`);
 * }
 * ```
 */
export async function checkAccountLockout(userId: string): Promise<LockoutStatus> {
  const auth = await dbRead
    .select({
      failedLoginAttempts: userAuth.failedLoginAttempts,
      lockUntil: userAuth.lockUntil,
    })
    .from(userAuth)
    .where(eq(userAuth.userId, userId))
    .limit(1);

  if (auth.length === 0) {
    return { isLocked: false, attempts: 0 };
  }

  const { failedLoginAttempts, lockUntil } = auth[0];

  // Check if lock has expired
  if (lockUntil && new Date(lockUntil) < new Date()) {
    // Reset lock
    await dbWrite
      .update(userAuth)
      .set({
        failedLoginAttempts: 0,
        lockUntil: null,
      })
      .where(eq(userAuth.userId, userId));

    return { isLocked: false, attempts: 0 };
  }

  // Check if account is currently locked
  if (lockUntil) {
    const remainingTime = new Date(lockUntil).getTime() - Date.now();
    return {
      isLocked: true,
      remainingTime,
      attempts: failedLoginAttempts || 0,
    };
  }

  return {
    isLocked: false,
    attempts: failedLoginAttempts || 0,
  };
}

/**
 * Records a failed login attempt and locks the account if threshold is reached
 * 
 * @param userId - The user ID to record the failed attempt for
 * 
 * @example
 * ```typescript
 * if (!isValidPassword) {
 *   await recordFailedLogin(userId);
 *   return res.status(401).json({ error: 'Invalid credentials' });
 * }
 * ```
 */
export async function recordFailedLogin(userId: string): Promise<void> {
  const auth = await dbRead
    .select({ failedLoginAttempts: userAuth.failedLoginAttempts })
    .from(userAuth)
    .where(eq(userAuth.userId, userId))
    .limit(1);

  if (auth.length === 0) return;

  const attempts = (auth[0].failedLoginAttempts || 0) + 1;
  let lockUntil: Date | null = null;

  // Check if we've reached a lockout threshold
  const thresholdIndex = LOCKOUT_THRESHOLDS.findIndex(threshold => attempts >= threshold);
  if (thresholdIndex !== -1) {
    const durationMinutes = LOCKOUT_DURATIONS[thresholdIndex];
    lockUntil = new Date(Date.now() + durationMinutes * 60 * 1000);
  }

  await dbWrite
    .update(userAuth)
    .set({
      failedLoginAttempts: attempts,
      lockUntil,
    })
    .where(eq(userAuth.userId, userId));
}

/**
 * Resets failed login attempts and clears account lockout
 * 
 * Call this on successful login or password change
 * 
 * @param userId - The user ID to reset
 * 
 * @example
 * ```typescript
 * // On successful login
 * if (isValidPassword) {
 *   await resetFailedLoginAttempts(userId);
 *   // Proceed with login
 * }
 * ```
 */
export async function resetFailedLoginAttempts(userId: string): Promise<void> {
  await dbWrite
    .update(userAuth)
    .set({
      failedLoginAttempts: 0,
      lockUntil: null,
    })
    .where(eq(userAuth.userId, userId));
}

/**
 * Gets the number of failed login attempts for an account
 * 
 * @param userId - The user ID to check
 * @returns Number of failed login attempts
 * 
 * @example
 * ```typescript
 * const attempts = await getFailedLoginAttempts('user-123');
 * console.log(`Failed attempts: ${attempts}`);
 * ```
 */
export async function getFailedLoginAttempts(userId: string): Promise<number> {
  const auth = await dbRead
    .select({ failedLoginAttempts: userAuth.failedLoginAttempts })
    .from(userAuth)
    .where(eq(userAuth.userId, userId))
    .limit(1);

  if (auth.length === 0) return 0;
  return auth[0].failedLoginAttempts || 0;
}

/**
 * Manually locks an account (for admin use)
 * 
 * @param userId - The user ID to lock
 * @param durationMinutes - Lock duration in minutes (default: 60)
 * 
 * @example
 * ```typescript
 * // Lock account for 1 hour
 * await lockAccount('user-123', 60);
 * ```
 */
export async function lockAccount(userId: string, durationMinutes: number = 60): Promise<void> {
  const lockUntil = new Date(Date.now() + durationMinutes * 60 * 1000);

  await dbWrite
    .update(userAuth)
    .set({
      lockUntil,
    })
    .where(eq(userAuth.userId, userId));
}

/**
 * Manually unlocks an account (for admin use)
 * 
 * @param userId - The user ID to unlock
 * 
 * @example
 * ```typescript
 * await unlockAccount('user-123');
 * ```
 */
export async function unlockAccount(userId: string): Promise<void> {
  await dbWrite
    .update(userAuth)
    .set({
      failedLoginAttempts: 0,
      lockUntil: null,
    })
    .where(eq(userAuth.userId, userId));
}
