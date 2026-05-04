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

import { dbWrite } from "../db/client.js";
import { users, transactions } from "../db/schema.js";
import { CREDIT_COSTS, type CreditCostKey } from "../config/credits.js";
import { generateId } from "../utils/uuid.js";
import { eq, sql } from "drizzle-orm";
import { CREDIT_ERRORS } from "../config/errors.js";

/**
 * Credit consumption options
 */
interface ConsumeCreditsOptions {
  /** Additional context for the transaction */
  context?: string;
  /** Optional metadata for the transaction */
  metadata?: Record<string, unknown>;
}

/**
 * Consumes credits from a user's account
 * 
 * @param userId - User ID to consume credits from
 * @param costKey - Credit cost key from CREDIT_COSTS
 * @param options - Additional options for the transaction
 * @returns Updated user credit balance
 * 
 * @throws Error if user has insufficient credits
 * 
 * @example
 * ```typescript
 * const newBalance = await consumeCredits("user123", "STORY_GENERATION", {
 *   context: "book_creation",
 *   metadata: { bookId: "book456" }
 * });
 * ```
 */
export async function consumeCredits(
  userId: string,
  costKey: CreditCostKey,
  options: ConsumeCreditsOptions = {}
): Promise<number> {
  const cost = CREDIT_COSTS[costKey];
  
  if (cost <= 0) {
    throw new Error(`Invalid credit cost: ${costKey} must be greater than 0`);
  }

  // Start transaction to ensure atomicity
  const result = await dbWrite.transaction(async (tx) => {
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
      throw new Error(`${CREDIT_ERRORS.INSUFFICIENT_CREDITS_PATTERN} requires ${cost} credits, but only ${currentCredits} available`);
    }

    // Update user credits
    await tx
      .update(users)
      .set({ 
        credits: sql`${users.credits} - ${cost}`,
        updatedAt: new Date()
      })
      .where(eq(users.userId, userId));

    // Record transaction
    await tx.insert(transactions).values({
      id: generateId(),
      userId,
      type: 'usage',
      credits: -cost, // Negative for consumption
      amountUsd: null, // Usage transactions don't have USD amount
      context: options.context,
      metadata: options.metadata ? JSON.stringify(options.metadata) : null,
      createdAt: new Date()
    });

    return currentCredits - cost;
  });

  return result;
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

  const userResult = await dbWrite
    .select({ credits: users.credits })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1);

  if (!userResult.length) {
    return false;
  }

  return userResult[0].credits >= cost;
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
 * Adds credits to a user's account
 * 
 * @param userId - User ID to add credits to
 * @param amount - Number of credits to add (must be positive)
 * @param options - Additional options for the transaction
 * @returns Updated user credit balance
 * 
 * @throws Error if amount is not positive
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
  if (amount <= 0) {
    throw new Error(`Invalid credit amount: ${amount} must be greater than 0`);
  }

  // Start transaction to ensure atomicity
  const result = await dbWrite.transaction(async (tx) => {
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

    // Update user credits
    await tx
      .update(users)
      .set({ 
        credits: sql`${users.credits} + ${amount}`,
        updatedAt: new Date()
      })
      .where(eq(users.userId, userId));

    // Record transaction
    await tx.insert(transactions).values({
      userId,
      type: 'reward',
      credits: amount, // Positive for addition
      amountUsd: null, // Credit additions don't have USD amount
      context: options.context,
      metadata: options.metadata ? JSON.stringify(options.metadata) : null,
      createdAt: new Date()
    });

    return currentCredits + amount;
  });

  return result;
}
