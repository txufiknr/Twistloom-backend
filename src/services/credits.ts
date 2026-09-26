/**
 * Credits Service Module
 *
 * Centralized credit management: consumption, balance checks, refunds, awards,
 * the atomic `executeWithCredits` wrapper (DB-atomic operations), and the
 * two-phase `reserveCredits` / `settleReservation` / `releaseReservation`
 * trio used by AI-generation flows so no LLM call ever runs inside a
 * transaction.
 *
 * @example
 * // Consume credits for story generation
 * await consumeCredits(userId, "STORY_GENERATION", {
 *   context: "book_creation",
 *   metadata: { bookId: "book123" }
 * });
 *
 * // Atomic: consume + operation in one transaction (DB-only operations)
 * const { result, correlationId } = await executeWithCredits(
 *   userId,
 *   "STORY_GENERATION",
 *   async (tx) => { ... },
 *   { context: "book_creation" }
 * );
 *
 * // Two-phase: charge, generate outside any transaction, then settle/release
 * const { result } = await withCreditReservation(
 *   userId, "PEN_TRANSFORM",
 *   async () => aiPrompt(...),
 *   async (out, tx) => { ... },
 *   { context: "pen_transform" }
 * );
 */

import { type DBTransaction, dbWrite, dbRead } from '../db/client.js';
import { users, transactions, userNotifications } from '../db/schema.js';
import { CREDIT_COSTS, getCreditCostForUser, isDemoUser, CREDIT_RESERVATION_TTL_MS, type CreditCostKey } from '../config/credits.js';
import { generateId } from '../utils/uuid.js';
import { eq, and, sql } from 'drizzle-orm';
import { CREDIT_ERRORS } from '../config/errors.js';
import { logUserActivity } from './user.js';
import { retryWithBackoffOrNull } from '../utils/retry.js';
import type { ConsumeCreditsOptions, ConsumeCreditsResult, CreditReservation, TransactionType } from '../types/credits.js';
import { PAYMENT_GATEWAY, type PaymentGateway } from '../types/payment.js';
import { requireNoFraudFlags } from './fraud-detection.js';

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

  const cost = getCreditCostForUser(userId, costKey);
  if (cost < 0) throw new Error(`Invalid credit cost: ${costKey} must be greater than or equal to 0`);

  // Free demo / zero-cost actions — no balance change or usage row
  if (cost === 0) {
    console.log(`[consumeCredits] ⏩ Free action (cost 0): ${costKey}`);
    const [userRow] = await dbRead
      .select({ credits: users.credits })
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1);
    return {
      remainingCredits: userRow?.credits ?? 0,
      transactionId: generateId(),
    };
  }

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
 *
 * @param rowType - Ledger row type to insert: `'usage'` (default) or
 *   `'reserve'` for the two-phase reservation flow (roadmap §3.1).
 */
async function consumeCreditsInTransaction(
  tx: DBTransaction,
  userId: string,
  cost: number,
  options: ConsumeCreditsOptions,
  rowType: TransactionType = 'usage'
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

  // Update user credits (do NOT set updatedAt — it's a user-controlled profile field, per AGENTS.md §8G)
  await tx
    .update(users)
    .set({ credits: sql`${users.credits} - ${cost}` })
    .where(eq(users.userId, userId));

  // Record transaction with correlation ID if provided
  const transactionId = generateId();
  await tx.insert(transactions).values({
    id: transactionId,
    userId,
    type: rowType,
    credits: -cost, // Negative for consumption
    amountCents: null, // Usage transactions don't have USD amount
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
  const cost = getCreditCostForUser(userId, costKey);
  if (cost < 0) throw new Error(`Invalid credit cost: ${costKey} must be greater than or equal to 0`);
  if (cost === 0) return true;

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

    // Update user credits (do NOT set updatedAt — it's a user-controlled profile field, per AGENTS.md §8G)
    await tx
      .update(users)
      .set({ credits: sql`${users.credits} + ${amount}` })
      .where(eq(users.userId, userId));

    // Pass metadata as a direct object — see note in consumeCreditsInTransaction.
    await tx.insert(transactions).values({
      userId,
      type: 'reward',
      credits: amount, // Positive for addition
      amountCents: null, // Credit additions don't have USD amount
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
  costKey: CreditCostKey | number,
  options: ConsumeCreditsOptions = {}
): Promise<number> {
  const amount = typeof costKey === 'number' ? (isDemoUser(userId) ? 0 : costKey) : getCreditCostForUser(userId, costKey);
  if (amount < 0) throw new Error(`Invalid credit cost: ${costKey} must be greater than or equal to 0`);

  // Nothing was charged (free demo / zero-cost) — no refund needed
  if (amount === 0) {
    const [userRow] = await dbRead
      .select({ credits: users.credits })
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1);
    if (!userRow) throw new Error(`User not found: ${userId}`);
    return userRow.credits;
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
 * @param costKey        - Key into `CREDIT_COSTS` (or raw numeric amount)
 * @param correlationId  - Idempotency key (from the original consumption record)
 * @param options        - Context, metadata, and transaction overrides
 * @returns New (or existing) balance after the refund
 */
export async function refundCreditsIdempotent(
  userId: string,
  costKey: CreditCostKey | number,
  correlationId: string,
  options: ConsumeCreditsOptions = {}
): Promise<number> {
  const amount = typeof costKey === 'number' ? (isDemoUser(userId) ? 0 : costKey) : getCreditCostForUser(userId, costKey);
  if (amount < 0) throw new Error(`Invalid credit cost: ${costKey} must be greater than or equal to 0`);

  // Nothing was charged (free demo / zero-cost) — no refund needed
  if (amount === 0) {
    const [userRow] = await dbRead
      .select({ credits: users.credits })
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1);
    if (!userRow) throw new Error(`User not found: ${userId}`);
    return userRow.credits;
  }

  // Wrap idempotency check + addCredits in a single transaction to prevent
  // two concurrent redelivered webhooks from both passing the check (TOCTOU).
  return dbWrite.transaction(async (tx) => {
    // Check for an existing refund record with this correlation ID
    const existingRefund = await tx
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.context, options.context || 'refund'),
          sql`${transactions.metadata}->>'correlationId' = ${correlationId}`
        )
      )
      .limit(1);

    if (existingRefund.length > 0) {
      // Return current user credits instead of refunding again
      console.log(`[refundCreditsIdempotent] ℹ️ Refund already processed for correlationId: ${correlationId}`);
      const [userRow] = await tx
        .select({ credits: users.credits })
        .from(users)
        .where(eq(users.userId, userId))
        .limit(1);

      if (!userRow) throw new Error(`User not found: ${userId}`);
      return userRow.credits;
    }

    // No existing refund, proceed with refund — pass tx so addCredits
    // participates in the same atomic transaction
    return addCredits(userId, amount, {
      context: options.context || 'refund',
      metadata: { ...options.metadata, correlationId },
      tx,
    });
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
 * Everything — credit deduction, the `operation` callback — runs inside ONE
 * Postgres transaction. If `operation` throws the entire transaction is
 * **rolled back by the database**, including the credit deduction, so the
 * user's balance is unchanged and no refund row is needed (or possible — any
 * in-transaction refund would roll back too).
 *
 * **When a separate refund IS needed:**
 * If your code succeeds here (transaction commits, credits deducted) but then
 * fails in a subsequent step that runs OUTSIDE this function, use the returned
 * `correlationId` with `refundCredits` / `refundCreditsIdempotent`.
 *
 * **When NOT to use this for AI generation:** the transaction (and the
 * `users` row lock) stays open for the whole `operation`, so wrapping an LLM
 * call holds a pool connection + row lock for the full provider latency.
 * AI-calling flows must use the reserve → generate → settle/release trio
 * (`reserveCredits` / `withCreditReservation` below instead: the charge
 * commits in a millisecond-scale reserve transaction, generation runs with no
 * transaction open, and failures persist a real `refund` row.
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
  const cost = typeof costKey === 'number' ? (isDemoUser(userId) ? 0 : costKey) : getCreditCostForUser(userId, costKey);
  if (cost < 0) throw new Error(`Invalid credit cost: ${costKey} must be greater than or equal to 0`);

  const correlationId = options.correlationId || generateId();

  // Fraud detection: block high-risk users from credit-sensitive operations
  if (cost > 0) {
    await requireNoFraudFlags(userId, undefined, 'usage');
  }

  // Free demo / zero-cost — run the operation without charging
  if (cost === 0) {
    console.log(`[executeWithCredits] ⏩ Free action (cost 0): ${costKey}`);
    return dbWrite.transaction(async (tx) => {
      const result = await operation(tx);
      return { result, correlationId, transactionId: generateId() };
    });
  }

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
      // ── 3. Failure path — the DATABASE rolls everything back ────────────
      //
      // The deduction above and every write in `operation` are reverted by the
      // implicit ROLLBACK, so the balance is already restored and a refund row
      // written here would be rolled back with them (this used to insert one
      // "for documentation" — it could never persist). No separate refund call
      // is required for errors originating inside `operation`. Failures AFTER
      // this function returns need `refundCredits`/`refundCreditsIdempotent`;
      // AI-generation flows should use the reserve/settle/release trio instead,
      // whose release path commits a real, persistent `refund` row.
      console.error('[executeWithCredits] ❌ Operation failed — transaction rolled back (deduction reverted):', operationError);
      throw operationError;
    }
  });
}

// ---------------------------------------------------------------------------
// Credit reservations — reserve → generate → settle/release (roadmap §3.1)
// ---------------------------------------------------------------------------

/**
 * Claims a `type='reserve'` row and refunds it — atomically.
 *
 * The guarded `UPDATE … WHERE type = 'reserve'` doubles as the idempotency
 * primitive: whoever flips the row issues exactly one refund; a concurrent
 * settle/release/sweep sees 0 rows and no-ops. On success the reserve row
 * becomes a normal `usage` row (the historical debit) and a **persistent**
 * `refund` row is inserted (the original debit + refund = net zero, both
 * visible in the ledger).
 *
 * Exported for the leak sweeper (`services/credit-reservations.ts`), which
 * drives it with rows it found expired. Callers supply the open transaction.
 *
 * @param tx            - Open transaction
 * @param reservationId - PK of the `type='reserve'` transactions row
 * @param reason        - Machine-readable release reason (stored in refund metadata)
 * @returns `true` when this call claimed the row and refunded it,
 *   `false` when it was already settled or released (idempotent no-op)
 */
export async function claimAndRefundReservationTx(
  tx: DBTransaction,
  reservationId: string,
  reason: string
): Promise<boolean> {
  const [claimed] = await tx
    .update(transactions)
    .set({ type: 'usage' })
    .where(and(eq(transactions.id, reservationId), eq(transactions.type, 'reserve')))
    .returning();
  if (!claimed) return false;

  // Reserve rows store a negative `credits` value (the deduction).
  const refund = Math.abs(claimed.credits);
  if (refund > 0) {
    // Balance restoration (UPDATE takes the row lock itself)
    await tx
      .update(users)
      .set({ credits: sql`${users.credits} + ${refund}` })
      .where(eq(users.userId, claimed.userId));

    const priorMetadata =
      claimed.metadata && typeof claimed.metadata === 'object' && !Array.isArray(claimed.metadata)
        ? (claimed.metadata as Record<string, unknown>)
        : {};

    // Persistent audit row — this is the refund that used to be impossible
    // (it was written inside a transaction that always rolled back).
    await tx.insert(transactions).values({
      id: generateId(),
      userId: claimed.userId,
      type: 'refund',
      credits: refund,
      amountCents: null,
      context: claimed.context,
      metadata: {
        ...priorMetadata,
        releaseReason: reason,
        originalTransactionId: reservationId,
      },
      createdAt: new Date(),
    });
  }
  return true;
}

/**
 * Phase 1 of two-phase charging: deducts credits and records a transient
 * `type='reserve'` row in a **millisecond-scale** transaction (row lock held
 * only for the deduction — never across an LLM call).
 *
 * The deduction happens BEFORE generation, so a zero-balance request is
 * rejected before any provider token is spent (Alternative C in roadmap §3.1;
 * generate-then-charge would be a free-token abuse vector).
 *
 * Idempotency: when `options.correlationId` matches an existing in-flight
 * `reserve` row for this user it is reused instead of double-charging a
 * retried request. A `cost` of 0 (free/demo) returns a reservation with
 * `transactionId: null` and opens no transaction at all.
 *
 * @param userId  - User to charge
 * @param costKey - Key into `CREDIT_COSTS` (or a raw numeric cost)
 * @param options - Context, metadata, correlation ID
 * @returns The reservation to pass to `settleReservation` / `releaseReservation`
 * @throws With `CREDIT_ERRORS.INSUFFICIENT_CREDITS` prefix when balance is too low
 */
export async function reserveCredits(
  userId: string,
  costKey: CreditCostKey | number,
  options: ConsumeCreditsOptions = {}
): Promise<CreditReservation> {
  const cost = typeof costKey === 'number' ? (isDemoUser(userId) ? 0 : costKey) : getCreditCostForUser(userId, costKey);
  if (cost < 0) throw new Error(`Invalid credit cost: ${costKey} must be greater than or equal to 0`);

  const correlationId = options.correlationId || generateId();

  // Fraud detection: block high-risk users from credit-sensitive operations
  if (cost > 0) {
    await requireNoFraudFlags(userId, undefined, 'usage');
  }

  // Free demo / zero-cost — nothing to hold, no transaction at all
  if (cost === 0) {
    return { userId, cost: 0, correlationId, transactionId: null, options };
  }

  const expiresAt = new Date(Date.now() + CREDIT_RESERVATION_TTL_MS).toISOString();

  const transactionId = await dbWrite.transaction(async (tx) => {
    // Idempotent reuse: a concurrent retry with the same correlationId already
    // holds this deduction in-flight — reuse its reserve row instead of
    // charging twice.
    const [existing] = await tx
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.type, 'reserve'),
          sql`${transactions.metadata}->>'correlationId' = ${correlationId}`
        )
      )
      .limit(1);
    if (existing) return existing.id;

    const { transactionId: reservedId } = await consumeCreditsInTransaction(
      tx,
      userId,
      cost,
      {
        ...options,
        correlationId,
        metadata: { ...options.metadata, correlationId, expiresAt },
      },
      'reserve'
    );
    return reservedId;
  });

  return { userId, cost, correlationId, transactionId, options };
}

/**
 * Phase 3 (success): runs the caller's persistence work in a short transaction
 * and converts the `reserve` row into a settled `usage` row in the SAME
 * transaction — either everything commits or the reserve stays held for
 * `releaseReservation` to refund.
 *
 * No LLM call may run inside `operation` — generation belongs in the
 * generate phase between reserve and settle.
 *
 * @param reservation - Reservation from `reserveCredits`
 * @param operation   - Short DB-only callback (span/audit writes), receives the open `tx`
 * @returns The operation's result
 */
export async function settleReservation<T>(
  reservation: CreditReservation,
  operation: (tx: DBTransaction) => Promise<T>
): Promise<T> {
  const reservationId = reservation.transactionId;

  // Cost-0 reservations hold no row — just run the persistence work in its own
  // transaction (the generate phase already ran with no transaction open).
  if (reservationId === null) {
    return dbWrite.transaction((tx) => operation(tx));
  }

  return dbWrite.transaction(async (tx) => {
    const result = await operation(tx);

    // Guarded flip `reserve → usage`: 0 rows means a concurrent release/sweep
    // already handled this reservation — the whole transaction must roll back
    // so its writes cannot land on top of a refunded charge.
    const [settled] = await tx
      .update(transactions)
      .set({ type: 'usage' })
      .where(and(eq(transactions.id, reservationId), eq(transactions.type, 'reserve')))
      .returning({ id: transactions.id });
    if (!settled) {
      throw new Error(`Credit reservation ${reservationId} was already settled or released`);
    }

    return result;
  });
}

/**
 * Phase 3 (failure): refunds a reservation — claims the `reserve` row and
 * inserts a **persistent** `refund` row (the historic pain point: refunds used
 * to be written inside the transaction that rolled them back, so they never
 * existed).
 *
 * Retries transient failures up to 3 times; if every attempt fails the error
 * is logged and swallowed here so the caller's ORIGINAL error still propagates
 * — the leak sweeper (`sweepExpiredCreditReservations`) refunds any reservation
 * left held beyond `CREDIT_RESERVATION_TTL_MS`.
 *
 * Safe to call when the reservation cost was 0 or when the row was already
 * settled/released (idempotent no-op).
 *
 * @param reservation - Reservation from `reserveCredits`
 * @param cause       - The error that triggered the release (recorded in metadata)
 */
export async function releaseReservation(reservation: CreditReservation, cause: unknown): Promise<void> {
  const reservationId = reservation.transactionId;
  if (reservationId === null) return; // nothing was held

  const reason = cause instanceof Error ? cause.message : String(cause);
  const outcome = await retryWithBackoffOrNull(
    () => dbWrite.transaction((tx) => claimAndRefundReservationTx(tx, reservationId, reason)),
    {
      maxRetries: 3,
      baseDelayMs: 500,
      onRetry: (attempt, error) => {
        console.error(`[releaseReservation] ❌ Release attempt ${attempt}/3 failed for ${reservationId}:`, error);
      },
    }
  );

  if (outcome === null) {
    // Deliberately swallowed: rethrowing would mask the caller's original
    // error, and the sweeper reclaims the row after the TTL regardless.
    console.error(
      `[releaseReservation] ❌ Could not release reservation ${reservationId} after retries — leak sweeper will refund it after ${CREDIT_RESERVATION_TTL_MS}ms`
    );
  }
}

/**
 * Convenience wrapper implementing the full reserve → generate → settle/release
 * flow (roadmap §3.1) so call sites never hand-roll the phases:
 *
 * ```ts
 * const result = await withCreditReservation(
 *   userId, "PEN_TRANSFORM",
 *   async () => aiPrompt(...),            // generate — NO transaction open
 *   async (out, tx) => tx.insert(...),    // persist  — short transaction
 *   { context: "pen_transform" },
 * );
 * ```
 *
 * - `reserveCredits` throws BEFORE `generate` runs, so a zero-balance request
 *   never spends provider tokens.
 * - Any failure in either phase releases (refunds) the reservation, then
 *   **rethrows the original error** — cleanup never masks the cause.
 *
 * @param userId   - User to charge
 * @param costKey  - Key into `CREDIT_COSTS` (or a raw numeric cost)
 * @param generate - AI/provider work — must NOT open a DB transaction
 * @param persist  - Short DB-only transaction callback for the generated result
 * @param options  - Context, metadata, correlation ID
 * @returns The persist phase's result
 */
export async function withCreditReservation<T, R>(
  userId: string,
  costKey: CreditCostKey | number,
  generate: () => Promise<T>,
  persist: (generated: T, tx: DBTransaction) => Promise<R>,
  options: ConsumeCreditsOptions = {}
): Promise<R> {
  const reservation = await reserveCredits(userId, costKey, options);

  let generated: T;
  try {
    generated = await generate();
  } catch (error) {
    await releaseReservation(reservation, error);
    throw error;
  }

  try {
    return await settleReservation(reservation, (tx) => persist(generated, tx));
  } catch (error) {
    await releaseReservation(reservation, error);
    throw error;
  }
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
  /** Payment gateway for this award; defaults to `stripe` */
  gateway?: PaymentGateway;
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
  /** Amount in cents for purchase transactions (null for usage/reward) */
  amountCents?: number | null;
  /** Human-readable context label for the transaction */
  context?: string;
  /** Gateway payment ID (Stripe `pi_xxx`, Xendit payment/invoice ID) — unique per gateway */
  providerPaymentId?: string;
  /** Gateway webhook event ID — unique per gateway */
  providerEventId?: string;
  /** Existing DB transaction to join */
  tx?: DBTransaction;
}

/**
 * Awards credits with a transaction record and an in-app notification.
 *
 * Used for payment-gateway purchases, referral bonuses, achievement rewards, etc.
 * Wraps in its own transaction when `tx` is not provided.
 *
 * Provider IDs (`providerPaymentId`, `providerEventId`) are written to the unique-
 * constrained columns for webhook idempotency.
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
    gateway = PAYMENT_GATEWAY.stripe,
    notificationType,
    notificationTitle,
    notificationMessage,
    notificationData = {},
    metadata = {},
    amountCents = null,
    context,
    providerPaymentId,
    providerEventId,
    tx: trx
  } = options;

  // Use provided transaction or create a new one
  const executeAward = async (tx: DBTransaction) => {
    // Acquire row lock to prevent race conditions with concurrent awards
    const [user] = await tx
      .select({ credits: users.credits })
      .from(users)
      .where(eq(users.userId, userId))
      .for('update')
      .limit(1);

    if (!user) throw new Error('User not found');

    const newBalance = user.credits + creditsAmount;

    // Update user credits (do NOT set updatedAt — it's a user-controlled profile field, per AGENTS.md §8G)
    await tx
      .update(users)
      .set({ credits: sql`${users.credits} + ${creditsAmount}` })
      .where(eq(users.userId, userId));

    // Create transaction record (provider IDs written for idempotency)
    await tx.insert(transactions).values({
      userId,
      type,
      credits: creditsAmount,
      amountCents,
      gateway,
      providerPaymentId: providerPaymentId ?? null,
      providerEventId: providerEventId ?? null,
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