/**
 * Credits Service Module
 *
 * Centralized credit management: consumption, balance checks, refunds, awards,
 * and the atomic `executeWithCredits` wrapper used for book / page generation.
 *
 * @example
 * // Consume credits for story generation
 * await consumeCredits(userId, "STORY_GENERATION", {
 *   context: "book_creation",
 *   metadata: { bookId: "book123" }
 * });
 *
 * // Atomic: consume + operation in one transaction
 * const { result, correlationId } = await executeWithCredits(
 *   userId,
 *   "STORY_GENERATION",
 *   async (tx) => { ... },
 *   { context: "book_creation" }
 * );
 */

import { type DBTransaction, dbWrite, dbRead } from '../db/client.js';
import { users, transactions, userNotifications } from '../db/schema.js';
import { CREDIT_COSTS, type CreditCostKey } from '../config/credits.js';
import { generateId } from '../utils/uuid.js';
import { eq, and, sql } from 'drizzle-orm';
import { CREDIT_ERRORS } from '../config/errors.js';
import { logUserActivity } from './user.js';
import { retryWithBackoffOrNull } from '../utils/retry.js';
import type { ConsumeCreditsOptions, ConsumeCreditsResult, TransactionType } from '../types/credits.js';

// ---------------------------------------------------------------------------
// consumeCredits
// ---------------------------------------------------------------------------

/**
 * Deducts credits from a user's account and records the transaction.
 *
 * When called without an explicit `tx`, it opens its own transaction.
 * When a `tx` is provided (e.g., from `executeWithCredits`), the deduction
 * is part of the caller's transaction and is rolled back together with it if
 * the outer work fails — no separate refund is needed in that case.
 *
 * Activity logging happens **outside** the transaction so that an analytics
 * failure never rolls back a legitimate credit deduction.
 *
 * @param userId  - User to deduct credits from
 * @param costKey - Key into `CREDIT_COSTS` configuration
 * @param options - Transaction, context, metadata, and analytics request
 * @returns Remaining balance and transaction record ID
 * @throws Error with `CREDIT_ERRORS.INSUFFICIENT_CREDITS` prefix when balance is too low
 */
export async function consumeCredits(
  userId: string,
  costKey: CreditCostKey,
  options: ConsumeCreditsOptions = {}
): Promise<{ remainingCredits: number; transactionId: string }> {
  // Internal system user (cron jobs, etc.) is never charged
  if (userId === process.env.SYSTEM_USER_ID) {
    console.log(`[consumeCredits] ⏩ Skipping credit consumption for internal user: ${userId}`);
    return { remainingCredits: 0, transactionId: generateId() };
  }

  const cost = CREDIT_COSTS[costKey];
  if (cost <= 0) throw new Error(`Invalid credit cost: ${costKey} must be greater than 0`);

  const { context, correlationId, metadata, tx: trx, req } = options;

  // Log to ensure consume credits operation is truly safe
  if (!trx) {
    console.warn('[consumeCredits] ⚠️ Called without a database transaction:', {
      costKey,
      context,
      correlationId,
    });
  }

  const result = trx
    ? await consumeCreditsInTransaction(trx, userId, cost, options)
    : await dbWrite.transaction((tx) => consumeCreditsInTransaction(tx, userId, cost, options));

  // Activity logging is intentionally outside the transaction
  await logUserActivity(
    {
      userId,
      activityType: 'credits_consumed',
      targetType: context ? 'credit_action' : null,
      targetId: result.transactionId,
      metadata: {
        costKey,
        creditsConsumed: cost,
        context,
        transactionId: result.transactionId,
        userMetadata: metadata || {},
      },
    },
    { req }
  );

  return result;
}

/**
 * Row-level-locked credit deduction that must run inside an existing transaction.
 *
 * Uses `SELECT ... FOR UPDATE` to prevent concurrent over-spends, then
 * updates the balance and inserts a transaction record atomically.
 */
async function consumeCreditsInTransaction(
  tx: DBTransaction,
  userId: string,
  cost: number,
  options: ConsumeCreditsOptions
): Promise<{ remainingCredits: number; transactionId: string }> {
  // Get current user credits with row lock
  const [user] = await tx
    .select({ credits: users.credits })
    .from(users)
    .where(eq(users.userId, userId))
    .for('update')
    .limit(1);

  if (!user) throw new Error(`User not found: ${userId}`);

  // Check if user has sufficient credits
  const currentCredits = user.credits;
  if (currentCredits < cost) {
    throw new Error(
      `${CREDIT_ERRORS.INSUFFICIENT_CREDITS}: requires ${cost} credits, but only ${currentCredits} available`
    );
  }

  // Update user credits
  await tx
    .update(users)
    .set({ credits: sql`${users.credits} - ${cost}`, updatedAt: new Date() })
    .where(eq(users.userId, userId));

  // Record transaction with correlation ID if provided
  const transactionId = generateId();
  await tx.insert(transactions).values({
    id: transactionId,
    userId,
    type: 'usage',
    credits: -cost, // Negative for consumption
    amountUsd: null, // Usage transactions don't have USD amount
    context: options.context,
    metadata: options.metadata
      ? { ...options.metadata, correlationId: options.correlationId }
      : null,
    createdAt: new Date()
  });

  return { remainingCredits: currentCredits - cost, transactionId };
}

// ---------------------------------------------------------------------------
// hasSufficientCredits / getCreditCost
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the user's current balance covers `costKey`.
 *
 * Uses the read replica for low-latency pre-flight checks. The authoritative
 * balance check is the row-locked SELECT inside `consumeCreditsInTransaction`.
 *
 * @param userId  - User to check
 * @param costKey - Key into `CREDIT_COSTS` configuration
 */
export async function hasSufficientCredits(
  userId: string,
  costKey: CreditCostKey
): Promise<boolean> {
  const cost = CREDIT_COSTS[costKey];
  if (cost <= 0) throw new Error(`Invalid credit cost: ${costKey} must be greater than 0`);

  const [user] = await dbRead
    .select({ credits: users.credits })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1);

  return user ? user.credits >= cost : false;
}

/**
 * Returns the numeric credit cost for a given action key.
 *
 * @param costKey - Key into `CREDIT_COSTS` configuration
 */
export function getCreditCost(costKey: CreditCostKey): number {
  return CREDIT_COSTS[costKey];
}

// ---------------------------------------------------------------------------
// addCredits
// ---------------------------------------------------------------------------

/**
 * Adds credits to a user's account with a transaction record.
 *
 * Used for daily check-in bonuses, referral rewards, and manual adjustments.
 * When a `tx` is provided the addition is part of the caller's transaction and
 * activity logging is skipped (the caller is responsible for its own logging).
 *
 * @param userId  - Recipient
 * @param amount  - Credits to add (must be > 0)
 * @param options - Transaction, context, metadata, analytics request
 * @returns New balance after addition
 * @throws Error when `amount ≤ 0` or user is not found
 */
export async function addCredits(
  userId: string,
  amount: number,
  options: ConsumeCreditsOptions = {}
): Promise<number> {
  if (amount <= 0) throw new Error(`Invalid credit amount: ${amount} must be greater than 0`);
  const { context, metadata = {}, tx: trx, req } = options;

  // Important: Use the provided `tx` when available for atomic operations.
  const execute = async (tx: DBTransaction) => {
    const [user] = await tx
      .select({ credits: users.credits })
      .from(users)
      .where(eq(users.userId, userId))
      .for('update')
      .limit(1);

    if (!user) throw new Error(`User not found: ${userId}`);
    const currentCredits = user.credits;

    // Update user credits
    await tx
      .update(users)
      .set({ credits: sql`${users.credits} + ${amount}`, updatedAt: new Date() })
      .where(eq(users.userId, userId));

    // Pass metadata as a direct object — see note in consumeCreditsInTransaction.
    await tx.insert(transactions).values({
      userId,
      type: 'reward',
      credits: amount, // Positive for addition
      amountUsd: null, // Credit additions don't have USD amount
      context,
      metadata,
      createdAt: new Date()
    });

    return currentCredits + amount;
  };

  const result = trx ? await execute(trx) : await dbWrite.transaction(execute);

  // Only log when we own the transaction; external callers handle their own logging
  if (!trx) {
    await logUserActivity({
      userId,
      activityType: 'credits_added',
      targetType: context ? 'credit_action' : null,
      targetId: null,
      metadata: { amount, context, userMetadata: metadata },
    },
    { req });
  }

  return result;
}

// ---------------------------------------------------------------------------
// refundCredits / refundCreditsIdempotent
// ---------------------------------------------------------------------------

/**
 * Refunds credits for a failed operation with retry and idempotency guarantees.
 *
 * Wraps `refundCreditsIdempotent` with up to 3 exponential-backoff attempts.
 * Pass the `correlationId` from `executeWithCredits` to prevent double-refunds
 * if the caller's error handler is invoked more than once.
 *
 * **When NOT to call this:**
 * If the original credit consumption was inside an `executeWithCredits` call
 * that threw, the DB transaction was already rolled back — credits were never
 * actually deducted. No refund is necessary in that scenario.
 *
 * @param userId     - User to refund
 * @param costKey    - Key into `CREDIT_COSTS` (determines refund amount)
 * @param options    - Includes optional `correlationId` for idempotency
 * @returns New balance after refund
 * @throws Error after all 3 retry attempts are exhausted
 */
export async function refundCredits(
  userId: string,
  costKey: CreditCostKey,
  options: ConsumeCreditsOptions = {}
): Promise<number> {
  const amount = CREDIT_COSTS[costKey];
  if (amount <= 0) throw new Error(`Invalid credit cost: ${costKey} must be greater than 0`);

  // Generate correlation ID for this refund
  const correlationId = options.correlationId || generateId();

  // Use idempotent refund with retry logic
  const result = await retryWithBackoffOrNull(
    () => refundCreditsIdempotent(userId, costKey, correlationId, {
      ...options,
      correlationId
    }),
    {
      maxRetries: 3,
      baseDelayMs: 1000,
      onRetry: (attempt, error) => {
        console.error(`[refundCredits] ❌ Refund attempt ${attempt}/3 failed:`, error);
      }
    }
  );

  if (result === null) {
    throw new Error(
      `Failed to refund credits after 3 attempts for userId: ${userId}, costKey: ${costKey}`
    );
  }

  return result;
}

/**
 * Idempotent credit refund guarded by a `correlationId` lookup.
 *
 * Before issuing a refund, queries `transactions` for any row where:
 * - `userId` matches
 * - `context` matches (defaults to `'refund'`)
 * - `metadata` contains the `correlationId` string
 *
 * If a matching row already exists the refund is skipped and the current
 * balance is returned unchanged. This prevents duplicate credits from being
 * awarded when an error handler fires more than once.
 *
 * @param userId         - User to refund
 * @param costKey        - Key into `CREDIT_COSTS`
 * @param correlationId  - Idempotency key (from the original consumption record)
 * @param options        - Context, metadata, and transaction overrides
 * @returns New (or existing) balance after the refund
 */
export async function refundCreditsIdempotent(
  userId: string,
  costKey: CreditCostKey,
  correlationId: string,
  options: ConsumeCreditsOptions = {}
): Promise<number> {
  const amount = CREDIT_COSTS[costKey];
  if (amount <= 0) throw new Error(`Invalid credit cost: ${costKey} must be greater than 0`);

  // Check for an existing refund record with this correlation ID
  const existingRefund = await dbWrite
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.context, options.context || 'refund'),
        sql`${transactions.metadata}::text LIKE ${`%${correlationId}%`}`
      )
    )
    .limit(1);

  if (existingRefund.length > 0) {
    // Return current user credits instead of refunding again
    console.log(`[refundCreditsIdempotent] ℹ️ Refund already processed for correlationId: ${correlationId}`);
    const [userRow] = await dbWrite
      .select({ credits: users.credits })
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1);

    if (!userRow) throw new Error(`User not found: ${userId}`);
    return userRow.credits;
  }

  // No existing refund, proceed with refund
  return addCredits(userId, amount, {
    context: options.context || 'refund',
    metadata: { ...options.metadata, correlationId }
  });
}

// ---------------------------------------------------------------------------
// executeWithCredits
// ---------------------------------------------------------------------------

/**
 * Executes an arbitrary operation inside a single DB transaction that also
 * deducts credits — providing true atomicity between payment and work.
 *
 * **Transaction semantics (critical for callers to understand):**
 *
 * Everything — credit deduction, the `operation` callback, and the internal
 * in-catch "refund" — runs inside ONE Postgres transaction. If `operation`
 * throws the entire transaction is **rolled back by the database**, including
 * the credit deduction. The in-catch credit restoration code is therefore
 * technically redundant (it will be rolled back alongside the deduction), but
 * is kept as explicit documentation of intent and to maintain symmetry with
 * future ORMs that may require manual rollback.
 *
 * **Net result on failure:** user's balance is unchanged; no separate
 * `refundCredits` call is needed for errors that originate inside `operation`.
 *
 * **When a separate refund IS needed:**
 * If your code succeeds here (transaction commits, credits deducted) but then
 * fails in a subsequent step that runs OUTSIDE this function, use the returned
 * `correlationId` with `refundCredits` / `refundCreditsIdempotent`.
 *
 * **Atomicity requirement:**
 * All DB operations inside `operation` MUST use the provided `tx` parameter.
 * Operations that use a separate connection (e.g., cache writes, external API
 * calls) are NOT rolled back if the transaction fails, so keep those outside
 * or treat them as fire-and-forget side effects.
 *
 * @param userId    - User to charge
 * @param costKey   - Key into `CREDIT_COSTS` (or a raw numeric cost)
 * @param operation - Async callback receiving the open transaction; must use `tx` for all DB work
 * @param options   - Context, metadata, correlation ID
 * @returns `{ result, correlationId, transactionId }` on success
 * @throws The original error from `operation` (or from credit consumption) on failure
 *
 * @example
 * const { result, correlationId } = await executeWithCredits(
 *   "user123",
 *   "STORY_GENERATION",
 *   async (tx) => {
 *     const book = await insertBook(bookData, { client: tx });
 *     return book;
 *   },
 *   { context: "book_creation", metadata: { theme: "haunted mansion" } }
 * );
 *
 * // Only needed if something outside this call fails after commit:
 * // await refundCredits("user123", "STORY_GENERATION", { correlationId });
 */
export async function executeWithCredits<T>(
  userId: string,
  costKey: CreditCostKey | number,
  operation: (tx: DBTransaction) => Promise<T>,
  options: ConsumeCreditsOptions = {}
): Promise<ConsumeCreditsResult<T>> {
  const cost = typeof costKey === 'number' ? costKey : CREDIT_COSTS[costKey];
  if (cost <= 0) throw new Error(`Invalid credit cost: ${costKey} must be greater than 0`);

  const correlationId = options.correlationId || generateId();

  // Execute everything in a single transaction for atomicity
  return dbWrite.transaction(async (tx) => {
    // ── 1. Deduct credits (row-locked) ────────────────────────────────────
    const { transactionId } = await consumeCreditsInTransaction(tx, userId, cost, {
      ...options,
      correlationId
    });

    try {
      // ── 2. Execute the caller's work ────────────────────────────────────
      const result = await operation(tx);
      return { result, correlationId, transactionId };
    } catch (operationError) {
      // ── 3. Restore credits inside the SAME transaction ──────────────────
      //
      // NOTE: These writes are included for clarity and auditability but will
      // be rolled back along with the credit deduction when this transaction
      // fails. The user's balance is preserved by the automatic ROLLBACK, not
      // by these explicit updates. No external refund call is required.
      console.error('[executeWithCredits] ❌ Operation failed — rolling back credit deduction:', operationError);

      // Refund credits (add back the consumed amount)
      await tx
        .update(users)
        .set({ credits: sql`${users.credits} + ${cost}`, updatedAt: new Date() })
        .where(eq(users.userId, userId));

      // Record refund transaction
        await tx.insert(transactions).values({
        id: generateId(),
        userId,
        type: 'refund',
        credits: cost, // Positive for refund
        amountUsd: null,
        context: options.context ? `${options.context}_failed` : 'refund',
        metadata: options.metadata
          ? {
              ...options.metadata,
              correlationId,
              reason: 'operation_failed',
              originalTransactionId: transactionId
            }
          : null,
        createdAt: new Date()
      });

      // Re-throw the operation error
      throw operationError;
    }
  });
}

// ---------------------------------------------------------------------------
// awardCredits
// ---------------------------------------------------------------------------

/**
 * Options specific to crediting a user as part of an award (purchase, referral, etc.)
 */
interface AwardCreditsOptions {
  /** Transaction type recorded in the `transactions` table */
  type: TransactionType;
  /** Notification type identifier */
  notificationType: string;
  /** Notification title shown to the user */
  notificationTitle: string;
  /** Notification body shown to the user */
  notificationMessage: string;
  /** Additional payload stored in the notification's `data` column */
  notificationData?: Record<string, unknown>;
  /** Metadata for the transaction record */
  metadata?: Record<string, unknown>;
  /** USD amount for purchase transactions (null for usage/reward) */
  amountUsd?: number | null;
  /** Human-readable context label for the transaction */
  context?: string;
  /** Existing DB transaction to join */
  tx?: DBTransaction;
}

/**
 * Awards credits with a transaction record and an in-app notification.
 *
 * Used for Stripe purchases, referral bonuses, achievement rewards, etc.
 * Wraps in its own transaction when `tx` is not provided.
 *
 * @param userId        - Recipient
 * @param creditsAmount - Credits to award (must be > 0)
 * @param options       - Type, notification text, metadata, and optional `tx`
 * @returns New balance after award
 */
export async function awardCredits(
  userId: string,
  creditsAmount: number,
  options: AwardCreditsOptions
): Promise<number> {
  const {
    type,
    notificationType,
    notificationTitle,
    notificationMessage,
    notificationData = {},
    metadata = {},
    amountUsd = null,
    context,
    tx: trx
  } = options;

  // Use provided transaction or create a new one
  const executeAward = async (tx: DBTransaction) => {
    // Update user credits
    const updateResult = await tx
      .update(users)
      .set({ credits: sql`${users.credits} + ${creditsAmount}` })
      .where(eq(users.userId, userId))
      .returning({ credits: users.credits });

    if (!updateResult?.length) throw new Error('User not found');

    const newBalance = updateResult[0].credits;

    // Create transaction record
    await tx.insert(transactions).values({
      userId,
      type,
      credits: creditsAmount,
      amountUsd,
      context: context ?? notificationType,
      metadata: Object.keys(metadata).length > 0 ? metadata : null,
      createdAt: new Date()
    });

    // Create user notification
    await tx.insert(userNotifications).values({
      userId,
      type: notificationType,
      title: notificationTitle,
      message: notificationMessage,
      data: { credits: creditsAmount, ...notificationData },
      read: false,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    return newBalance;
  };

  return trx ? executeAward(trx) : dbWrite.transaction(executeAward);
}