/**
 * Credits Service Module
 *
 * Provides centralized credit management functionality including consumption,
 * balance checking, and transaction recording.
 *
 * @example
 * ```typescript
 * // Consume credits for story generation
 * await consumeCredits(userId, "STORY_GENERATION", {
 *   context: "book_creation",
 *   metadata: { bookId: "book123" }
 * });
 *
 * // Check if user has enough credits
 * const hasCredits = await hasSufficientCredits(userId, "STORY_GENERATION");
 * ```
 */

import { type DBTransaction, dbWrite, dbRead } from "../db/client.js";
import { users, transactions, userNotifications } from "../db/schema.js";
import { CREDIT_COSTS, type CreditCostKey } from "../config/credits.js";
import { generateId } from "../utils/uuid.js";
import { eq, and, sql } from "drizzle-orm";
import { CREDIT_ERRORS } from "../config/errors.js";
import { logUserActivity } from "./user.js";
import { retryWithBackoffOrNull } from "../utils/retry.js";
import type { TransactionType } from "../types/credits.js";

/**
 * Credit consumption options
 */
interface ConsumeCreditsOptions {
  /** Additional context for the transaction */
  context?: string;
  /** Optional metadata for the transaction */
  metadata?: Record<string, unknown>;
  /** Optional transaction to use instead of creating a new one */
  tx?: DBTransaction;
  /** Optional correlation ID to link this transaction with refunds */
  correlationId?: string;
}

/**
 * Result of a credit consumption operation
 */
interface ConsumeCreditsResult<T> {
  /** The result of the credit-consuming operation */
  result: T;
  /** Correlation ID for linking this transaction with idempotent refunds */
  correlationId: string;
  /** Database transaction ID for the credit consumption record */
  transactionId: string;
}

/**
 * Consumes credits from a user's account
 *
 * @param userId - User ID to consume credits from
 * @param costKey - Credit cost key from CREDIT_COSTS
 * @param options - Additional options for the transaction
 * @returns Updated user credit balance and transaction ID
 *
 * @throws Error if user has insufficient credits
 *
 * @example
 * ```typescript
 * const { remainingCredits, transactionId } = await consumeCredits("user123", "STORY_GENERATION", {
 *   context: "book_creation",
 *   metadata: { bookId: "book456" }
 * });
 * ```
 */
export async function consumeCredits(
  userId: string,
  costKey: CreditCostKey,
  options: ConsumeCreditsOptions = {}
): Promise<{ remainingCredits: number; transactionId: string }> {
  const isInternal = userId === process.env.SYSTEM_USER_ID;

  // Skip credit consumption for internal system user (cron jobs, etc.)
  if (isInternal) {
    console.log(`[consumeCredits] ⏩ Skipping credit consumption for internal user: ${userId}`);
    // Return dummy transaction ID for consistency
    return {
      remainingCredits: 0,
      transactionId: generateId(),
    };
  }

  const cost = CREDIT_COSTS[costKey];
  if (cost <= 0) throw new Error(`Invalid credit cost: ${costKey} must be greater than 0`);

  const { context, correlationId, metadata, tx: trx } = options;

  // Log to ensure consume credits operation is truly safe
  if (!trx) console.warn(`[consumeCredits] ⚠️ Called without database transaction provided:`, { costKey, context, correlationId });

  // Use provided transaction or create a new one
  const result = trx
    ? await consumeCreditsInTransaction(trx, userId, cost, options)
    : await dbWrite.transaction(async (tx) => consumeCreditsInTransaction(tx, userId, cost, options));

  // Log user activity for analytics and security monitoring
  // Note: This happens outside of transaction to avoid breaking credit consumption if logging fails
  // It has internal error handling, ensuring failures don't affect main flow
  await logUserActivity({
    userId,
    activityType: 'credits_consumed',
    targetType: context ? 'credit_action' : null,
    targetId: result.transactionId, // Include transaction ID for correlation
    metadata: {
      costKey,
      creditsConsumed: cost,
      context,
      transactionId: result.transactionId, // Also include in metadata
      userMetadata: metadata || {} // Separate user metadata to prevent overwrites
    }
  });

  return result;
}

/**
 * Core credit consumption logic that can be used within an existing transaction
 *
 * @param tx - Transaction object to use
 * @param userId - User ID to consume credits from
 * @param cost - Credit cost to consume
 * @param options - Additional options for the transaction
 * @returns Updated user credit balance and transaction ID
 */
async function consumeCreditsInTransaction(
  tx: DBTransaction,
  userId: string,
  cost: number,
  options: ConsumeCreditsOptions
): Promise<{ remainingCredits: number; transactionId: string }> {
  // Get current user credits with row lock
  const userResult = await tx
    .select({ credits: users.credits })
    .from(users)
    .where(eq(users.userId, userId))
    .for('update')
    .limit(1);

  if (!userResult.length) {
    throw new Error(`User not found: ${userId}`);
  }

  const currentCredits = userResult[0].credits;

  // Check if user has sufficient credits
  if (currentCredits < cost) {
    throw new Error(`${CREDIT_ERRORS.INSUFFICIENT_CREDITS}: requires ${cost} credits, but only ${currentCredits} available`);
  }

  // Update user credits
  await tx
    .update(users)
    .set({
      credits: sql`${users.credits} - ${cost}`,
      updatedAt: new Date()
    })
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

/**
 * Checks if a user has sufficient credits for a specific action
 *
 * @param userId - User ID to check
 * @param costKey - Credit cost key from CREDIT_COSTS
 * @returns Whether user has sufficient credits
 *
 * @example
 * ```typescript
 * const canCreateStory = await hasSufficientCredits("user123", "STORY_GENERATION");
 * if (!canCreateStory) {
 *   throw new Error("Insufficient credits for story generation");
 * }
 * ```
 */
export async function hasSufficientCredits(
  userId: string,
  costKey: CreditCostKey
): Promise<boolean> {
  const cost = CREDIT_COSTS[costKey];

  if (cost <= 0) {
    throw new Error(`Invalid credit cost: ${costKey} must be greater than 0`);
  }

  const [user] = await dbRead
    .select({ credits: users.credits })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1);

  if (user) return user.credits >= cost;
  return false;
}

/**
 * Gets the credit cost for a specific action
 *
 * @param costKey - Credit cost key from CREDIT_COSTS
 * @returns Credit cost in credits
 *
 * @example
 * ```typescript
 * const storyCost = getCreditCost("STORY_GENERATION"); // Returns 5
 * ```
 */
export function getCreditCost(costKey: CreditCostKey): number {
  return CREDIT_COSTS[costKey];
}

/**
 * Adds credits to a user's account (daily check-in bonus, etc.)
 *
 * @param userId - User ID to add credits to
 * @param amount - Number of credits to add (must be positive)
 * @param options - Additional options for the transaction
 * @returns Updated user credit balance
 *
 * @throws Error if amount is not positive or user not found
 *
 * @example
 * ```typescript
 * const newBalance = await addCredits("user123", 30, {
 *   context: "daily_checkin",
 *   metadata: { checkInDate: "2026-05-04" }
 * });
 * ```
 */
export async function addCredits(
  userId: string,
  amount: number,
  options: ConsumeCreditsOptions = {}
): Promise<number> {
  if (amount <= 0) throw new Error(`Invalid credit amount: ${amount} must be greater than 0`);

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
      .set({
        credits: sql`${users.credits} + ${amount}`,
        updatedAt: new Date()
      })
      .where(eq(users.userId, userId));

    // Pass metadata as a direct object — see note in consumeCreditsInTransaction.
    await tx.insert(transactions).values({
      userId,
      type: 'reward',
      credits: amount, // Positive for addition
      amountUsd: null, // Credit additions don't have USD amount
      context: options.context,
      metadata: options.metadata ?? null,
      createdAt: new Date()
    });

    return currentCredits + amount;
  };

  const result = options.tx
    ? await execute(options.tx)
    : await dbWrite.transaction(execute);

  // Only log activity when we own the transaction. When called from within an
  // external transaction (options.tx provided), the caller is responsible for
  // any post-commit side effects to avoid polluting the outer transaction scope.
  if (!options.tx) {
    await logUserActivity({
      userId,
      activityType: 'credits_added',
      targetType: options.context ? 'credit_action' : null,
      targetId: null,
      metadata: {
        amount,
        context: options.context,
        userMetadata: options.metadata || {}
      }
    });
  }

  return result;
}

/**
 * Refunds credits to a user's account (for failed operations)
 *
 * This is a wrapper around refundCreditsIdempotent that generates a correlation ID
 * automatically and includes retry logic with exponential backoff.
 *
 * @param userId - User ID to refund credits to
 * @param costKey - Credit cost key from CREDIT_COSTS to refund
 * @param options - Additional options for the transaction
 * @returns Updated user credit balance
 *
 * @throws Error if user not found
 *
 * @example
 * ```typescript
 * const newBalance = await refundCredits("user123", "STORY_GENERATION", {
 *   context: "book_creation_failed",
 *   metadata: { bookId: "book456" }
 * });
 * ```
 */
export async function refundCredits(
  userId: string,
  costKey: CreditCostKey,
  options: ConsumeCreditsOptions = {}
): Promise<number> {
  const amount = CREDIT_COSTS[costKey];

  if (amount <= 0) {
    throw new Error(`Invalid credit cost: ${costKey} must be greater than 0`);
  }

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
        console.error(`[refundCredits] ❌ Failed to refund credits (attempt ${attempt}/3):`, error);
      }
    }
  );

  if (result === null) {
    throw new Error(`Failed to refund credits after 3 attempts for userId: ${userId}, costKey: ${costKey}`);
  }

  return result;
}

/**
 * Idempotently refunds credits for a specific transaction
 *
 * Checks if a refund was already processed for the given correlation ID
 * to prevent duplicate refunds. If a refund exists, returns the existing
 * transaction instead of creating a new one.
 *
 * @param userId - User ID to refund credits to
 * @param costKey - Credit cost key from CREDIT_COSTS to refund
 * @param correlationId - Unique ID linking this refund to the original transaction
 * @param options - Additional options for the transaction
 * @returns Updated user credit balance
 *
 * @throws Error if user not found
 *
 * @example
 * ```typescript
 * const newBalance = await refundCreditsIdempotent(
 *   "user123",
 *   "STORY_GENERATION",
 *   "txn_abc123",
 *   {
 *     context: "book_creation_failed",
 *     metadata: { bookId: "book456" }
 *   }
 * );
 * ```
 */
export async function refundCreditsIdempotent(
  userId: string,
  costKey: CreditCostKey,
  correlationId: string,
  options: ConsumeCreditsOptions = {}
): Promise<number> {
  const amount = CREDIT_COSTS[costKey];

  if (amount <= 0) {
    throw new Error(`Invalid credit cost: ${costKey} must be greater than 0`);
  }

  // Check if a refund was already processed for this correlation ID
  const existingRefund = await dbWrite
    .select()
    .from(transactions)
    .where(and(
      eq(transactions.userId, userId),
      eq(transactions.context, options.context || 'refund'),
      sql`${transactions.metadata}::text LIKE ${`%${correlationId}%`}`
    ))
    .limit(1);

  if (existingRefund.length > 0) {
    console.log(`[refundCreditsIdempotent] ℹ️ Refund already processed for correlation ID: ${correlationId}`);
    // Return current user credits instead of refunding again
    const userResult = await dbWrite
      .select({ credits: users.credits })
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1);

    if (!userResult.length) {
      throw new Error(`User not found: ${userId}`);
    }

    return userResult[0].credits;
  }

  // No existing refund, proceed with refund
  return addCredits(userId, amount, {
    context: options.context || 'refund',
    metadata: { ...options.metadata, correlationId }
  });
}

/**
 * Executes an operation with credit consumption in a single transaction
 *
 * This function provides a unified flow for:
 * 1. Consuming credits atomically
 * 2. Executing the provided operation
 * 3. Returning a correlation ID for idempotent refunds
 *
 * If the operation fails, credits are automatically refunded within the same transaction.
 *
 * @param userId - User ID to consume credits from
 * @param costKey - Credit cost key from CREDIT_COSTS
 * @param operation - Async function to execute after credit consumption. Receives transaction object `tx`.
 * @param options - Additional options for the transaction
 * @returns Result from the operation and correlation ID for potential refunds
 *
 * @throws Error if credit consumption fails or operation fails
 *
 * @example
 * ```typescript
 * const { result, correlationId } = await executeWithCredits(
 *   "user123",
 *   "STORY_GENERATION",
 *   async (tx) => {
 *     // Use tx for database operations within the transaction
 *     await tx.insert(books).values(bookData);
 *     return { bookId };
 *   },
 *   {
 *     context: "book_creation",
 *     metadata: { theme: "haunted mansion" }
 *   }
 * );
 * 
 * // Later, if operation fails, refund idempotently:
 * await refundCreditsIdempotent("user123", "STORY_GENERATION", correlationId, {
 *   context: "book_creation_failed",
 *   metadata: { bookId }
 * });
 * ```
 *
 * @remarks
 * **IMPORTANT:** For full atomicity, the operation function MUST use the provided `tx` parameter
 * for all database operations.
 */
export async function executeWithCredits<T>(
  userId: string,
  costKey: CreditCostKey | number,
  operation: (tx: DBTransaction) => Promise<T>,
  options: ConsumeCreditsOptions = {}
): Promise<ConsumeCreditsResult<T>> {
  const cost = typeof costKey === 'number' ? costKey : CREDIT_COSTS[costKey];
  const correlationId = options.correlationId || generateId();

  // Validate item cost
  if (cost <= 0) {
    throw new Error(`Invalid credit cost: ${costKey} must be greater than 0`);
  }

  // Execute everything in a single transaction for atomicity
  return dbWrite.transaction(async (tx) => {
    // Consume credits with correlation ID
    const { transactionId } = await consumeCreditsInTransaction(tx, userId, cost, {
      ...options,
      correlationId
    });

    try {
      // Execute the provided operation
      const result = await operation(tx);

      return { result, correlationId, transactionId };
    } catch (operationError) {
      // Operation failed, refund credits within the same transaction
      console.error(`[executeWithCredits] ❌ Operation failed, refunding credits:`, operationError);

      // Refund credits (add back the consumed amount)
      await tx
        .update(users)
        .set({
          credits: sql`${users.credits} + ${cost}`,
          updatedAt: new Date()
        })
        .where(eq(users.userId, userId));

      // Record refund transaction
      const refundTransactionId = generateId();
      await tx.insert(transactions).values({
        id: refundTransactionId,
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

/**
 * Award credits options
 */
interface AwardCreditsOptions {
  /** Transaction type (purchase, reward, etc.) */
  type: TransactionType;
  /** Notification type for user notification */
  notificationType: string;
  /** Notification title */
  notificationTitle: string;
  /** Notification message */
  notificationMessage: string;
  /** Additional data for notification */
  notificationData?: Record<string, unknown>;
  /** Optional metadata for the transaction */
  metadata?: Record<string, unknown>;
  /** Optional transaction to use instead of creating a new one */
  tx?: DBTransaction;
}

/**
 * Awards credits to a user's account with transaction record and notification
 *
 * @param userId - User ID to award credits to
 * @param creditsAmount - Number of credits to award
 * @param options - Additional options for the transaction and notification
 * @returns Updated user credit balance
 *
 * @example
 * ```typescript
 * const newBalance = await awardCredits("user123", 10, {
 *   type: "reward",
 *   notificationType: "referral_bonus",
 *   notificationTitle: "Referral Bonus",
 *   notificationMessage: "You received 10 credits for referring a friend",
 *   metadata: { referrerId: "user456" }
 * });
 * ```
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
    tx: trx
  } = options;

  // Use provided transaction or create a new one
  const executeAward = async (tx: DBTransaction) => {
    // Update user credits
    const updateResult = await tx
      .update(users)
      .set({
        credits: sql`${users.credits} + ${creditsAmount}`
      })
      .where(eq(users.userId, userId))
      .returning({ credits: users.credits });

    if (!updateResult || updateResult.length === 0) {
      throw new Error("User not found");
    }

    const newBalance = updateResult[0].credits;

    // Create transaction record
    await tx.insert(transactions).values({
      userId,
      type,
      credits: creditsAmount,
      amountUsd: null,
      context: notificationType,
      metadata: Object.keys(metadata).length > 0 ? metadata : null,
      createdAt: new Date()
    });

    // Create user notification
    await tx.insert(userNotifications).values({
      userId,
      type: notificationType,
      title: notificationTitle,
      message: notificationMessage,
      data: {
        credits: creditsAmount,
        ...notificationData
      },
      read: false,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    return newBalance;
  };

  if (trx) {
    return executeAward(trx);
  } else {
    return dbWrite.transaction(async (tx) => executeAward(tx));
  }
}
