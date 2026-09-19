/**
 * Automated Payout Disbursement Pipeline Engine
 *
 * Implements automated batching and gateway dispatch for creator withdrawals.
 * Supports:
 * - Domestic IDR via Xendit Automated Disbursements (BI-FAST / Realtime)
 * - Decrypted PII (AES-256-GCM) bank account retrieval
 * - Idempotent external reference tracking (`twistloom_payout_${payoutId}`)
 * - Atomic DB row locks and non-blocking external HTTP boundaries
 * - Webhook callback reconciliation with wallet balance restoration on failures
 *
 * @see docs/architecture/CREATOR_WALLET_ARCHITECTURE.md
 * @see docs/roadmap/CREATOR_PAYOUT_DISBURSEMENT_PIPELINE_ROADMAP.md
 */

import { eq, and, or, lte, sql, desc } from "drizzle-orm";
import { dbRead, dbWrite } from "../db/client.js";
import { creatorPayouts, creatorWallets, creatorPayoutMethods, creatorPayoutEvents } from "../db/schema.js";
import { decryptPII } from "../utils/crypto.js";
import { createXenditDisbursement } from "../utils/xendit.js";
import type { DisbursementBatchResult } from "../types/wallet.js";

export interface XenditDisbursementCallbackPayload {
  id: string;
  external_id: string;
  amount: number;
  bank_code: string;
  account_holder_name: string;
  status: "COMPLETED" | "FAILED" | "PENDING";
  failure_code?: string;
  disbursement_description?: string;
}

/**
 * Scans for pending creator payouts and dispatches them to their
 * respective payment gateway (Xendit for IDR, Stripe for USD).
 *
 * Enforces strict transaction boundaries:
 * 1. Payout row is locked and marked 'processing' inside DB transaction.
 * 2. External HTTP call to gateway occurs outside DB transaction.
 * 3. Provider payout reference and final status recorded in follow-up transaction.
 */
export async function processPendingPayouts(limit = 50): Promise<DisbursementBatchResult> {
  const result: DisbursementBatchResult = {
    processedCount: 0,
    completedCount: 0,
    pendingCount: 0,
    failedCount: 0,
    skippedCount: 0,
  };

  // 1. Fetch pending payouts (and stuck processing payouts older than 15 minutes for safe idempotent reconciliation)
  const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
  const pendingPayouts = await dbWrite
    .select()
    .from(creatorPayouts)
    .where(
      or(
        eq(creatorPayouts.status, "pending"),
        and(
          eq(creatorPayouts.status, "processing"),
          lte(creatorPayouts.updatedAt, fifteenMinutesAgo)
        )
      )
    )
    .orderBy(creatorPayouts.createdAt)
    .limit(limit);

  if (pendingPayouts.length === 0) {
    return result;
  }

  for (const payout of pendingPayouts) {
    result.processedCount++;

    // Currently, automated disbursement is implemented for Xendit (IDR)
    if (payout.provider !== "xendit" || payout.currency !== "IDR") {
      result.skippedCount++;
      continue;
    }

    // 2. Fetch the payout method (prefer specific method bound to payout, fallback to default verified)
    let method: typeof creatorPayoutMethods.$inferSelect | undefined;

    if (payout.payoutMethodId) {
      const [specificMethod] = await dbRead
        .select()
        .from(creatorPayoutMethods)
        .where(
          and(
            eq(creatorPayoutMethods.id, payout.payoutMethodId),
            eq(creatorPayoutMethods.isVerified, true)
          )
        )
        .limit(1);
      method = specificMethod;
    }

    if (!method) {
      const methods = await dbRead
        .select()
        .from(creatorPayoutMethods)
        .where(
          and(
            eq(creatorPayoutMethods.creatorId, payout.creatorId),
            eq(creatorPayoutMethods.isVerified, true)
          )
        )
        .orderBy(desc(creatorPayoutMethods.isDefault), desc(creatorPayoutMethods.createdAt))
        .limit(1);

      method = methods[0];
    }

    // If no verified payout method exists, fail payout and refund available balance
    if (!method || !method.bankCode || !method.accountNumberEncrypted) {
      await dbWrite.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(creatorPayouts)
          .where(and(eq(creatorPayouts.id, payout.id), eq(creatorPayouts.status, "pending")))
          .for("update")
          .limit(1);

        if (!existing) return;

        // Refund wallet (pending -> available)
        await tx
          .update(creatorWallets)
          .set({
            availableAmount: sql`${creatorWallets.availableAmount} + ${payout.amount}`,
            pendingAmount: sql`GREATEST(0, ${creatorWallets.pendingAmount} - ${payout.amount})`,
            updatedAt: new Date(),
          })
          .where(eq(creatorWallets.creatorId, payout.creatorId));

        await tx
          .update(creatorPayouts)
          .set({
            status: "failed",
            failureReason: "NO_VERIFIED_PAYOUT_METHOD",
            updatedAt: new Date(),
          })
          .where(eq(creatorPayouts.id, payout.id));

        await tx.insert(creatorPayoutEvents).values({
          payoutId: payout.id,
          previousStatus: "pending",
          newStatus: "failed",
          actorType: "system",
          note: "Rejected: No verified payout method found for creator",
        });
      });

      result.failedCount++;
      continue;
    }

    // 3. Decrypt raw bank account number
    let rawAccountNumber: string;
    try {
      rawAccountNumber = await decryptPII(method.accountNumberEncrypted);
    } catch {
      rawAccountNumber = "";
    }

    if (!rawAccountNumber) {
      await dbWrite.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(creatorPayouts)
          .where(and(eq(creatorPayouts.id, payout.id), eq(creatorPayouts.status, "pending")))
          .for("update")
          .limit(1);

        if (!existing) return;

        await tx
          .update(creatorWallets)
          .set({
            availableAmount: sql`${creatorWallets.availableAmount} + ${payout.amount}`,
            pendingAmount: sql`GREATEST(0, ${creatorWallets.pendingAmount} - ${payout.amount})`,
            updatedAt: new Date(),
          })
          .where(eq(creatorWallets.creatorId, payout.creatorId));

        await tx
          .update(creatorPayouts)
          .set({
            status: "failed",
            failureReason: "ACCOUNT_DECRYPTION_FAILED",
            updatedAt: new Date(),
          })
          .where(eq(creatorPayouts.id, payout.id));

        await tx.insert(creatorPayoutEvents).values({
          payoutId: payout.id,
          previousStatus: "pending",
          newStatus: "failed",
          actorType: "system",
          note: "Rejected: Failed to decrypt account number",
        });
      });

      result.failedCount++;
      continue;
    }

    // 4. Mark payout as 'processing' inside DB transaction (acquire lock)
    const acquired = await dbWrite.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(creatorPayouts)
        .where(
          and(
            eq(creatorPayouts.id, payout.id),
            or(
              eq(creatorPayouts.status, "pending"),
              and(
                eq(creatorPayouts.status, "processing"),
                lte(creatorPayouts.updatedAt, fifteenMinutesAgo)
              )
            )
          )
        )
        .for("update")
        .limit(1);

      if (!existing) return false;

      await tx
        .update(creatorPayouts)
        .set({
          status: "processing",
          providerMethod: method.methodType,
          providerAccountLast4: method.accountLast4,
          updatedAt: new Date(),
        })
        .where(eq(creatorPayouts.id, payout.id));

      await tx.insert(creatorPayoutEvents).values({
        payoutId: payout.id,
        previousStatus: existing.status,
        newStatus: "processing",
        actorType: "system",
        note: existing.status === "processing"
          ? "Re-attempting stuck disbursement dispatch to gateway"
          : "Disbursement batch lock acquired, dispatching to gateway",
      });

      return true;
    });

    if (!acquired) {
      // Payout was concurrently acquired or cancelled
      result.skippedCount++;
      continue;
    }

    // 5. Execute external HTTP call to Xendit OUTSIDE the DB transaction
    const externalId = `twistloom_payout_${payout.id}`;
    let disbResponse;

    try {
      disbResponse = await createXenditDisbursement({
        externalId,
        amount: payout.netAmount,
        bankCode: method.bankCode,
        accountHolderName: method.accountName || "Creator",
        accountNumber: rawAccountNumber,
        description: `Twistloom Payout ${payout.id.slice(0, 8)}`,
      });
    } catch (httpError) {
      console.error(`[Disbursement] HTTP error dispatching payout ${payout.id}:`, httpError);
      // Payout remains in 'processing' status with idempotency key preserved
      await dbWrite.insert(creatorPayoutEvents).values({
        payoutId: payout.id,
        previousStatus: "processing",
        newStatus: "processing",
        actorType: "system",
        note: `Gateway dispatch error: ${httpError instanceof Error ? httpError.message : "Unknown"}`,
      });
      result.pendingCount++;
      continue;
    }

    // 6. Record gateway response in DB
    await dbWrite.transaction(async (tx) => {
      if (disbResponse.status === "COMPLETED") {
        // Disbursement settled immediately (synchronous confirmation)
        await tx
          .update(creatorWallets)
          .set({
            pendingAmount: sql`GREATEST(0, ${creatorWallets.pendingAmount} - ${payout.amount})`,
            withdrawnAmount: sql`${creatorWallets.withdrawnAmount} + ${payout.amount}`,
            updatedAt: new Date(),
          })
          .where(eq(creatorWallets.creatorId, payout.creatorId));

        await tx
          .update(creatorPayouts)
          .set({
            status: "completed",
            providerPayoutId: disbResponse.id,
            updatedAt: new Date(),
          })
          .where(eq(creatorPayouts.id, payout.id));

        await tx.insert(creatorPayoutEvents).values({
          payoutId: payout.id,
          previousStatus: "processing",
          newStatus: "completed",
          actorType: "system",
          note: `Synchronously confirmed by gateway (ID: ${disbResponse.id})`,
        });

        result.completedCount++;
      } else if (disbResponse.status === "FAILED") {
        // Gateway rejected immediately
        await tx
          .update(creatorWallets)
          .set({
            availableAmount: sql`${creatorWallets.availableAmount} + ${payout.amount}`,
            pendingAmount: sql`GREATEST(0, ${creatorWallets.pendingAmount} - ${payout.amount})`,
            updatedAt: new Date(),
          })
          .where(eq(creatorWallets.creatorId, payout.creatorId));

        await tx
          .update(creatorPayouts)
          .set({
            status: "failed",
            providerPayoutId: disbResponse.id,
            failureReason: disbResponse.failure_code || "DISBURSEMENT_REJECTED",
            updatedAt: new Date(),
          })
          .where(eq(creatorPayouts.id, payout.id));

        await tx.insert(creatorPayoutEvents).values({
          payoutId: payout.id,
          previousStatus: "processing",
          newStatus: "failed",
          actorType: "system",
          note: `Gateway rejected: ${disbResponse.failure_code || "Unknown"}`,
        });

        result.failedCount++;
      } else {
        // Standard async state: update providerPayoutId, awaiting webhook callback
        await tx
          .update(creatorPayouts)
          .set({
            providerPayoutId: disbResponse.id,
            updatedAt: new Date(),
          })
          .where(eq(creatorPayouts.id, payout.id));

        result.pendingCount++;
      }
    });
  }

  return result;
}

/**
 * Handles incoming Xendit disbursement webhook callbacks.
 * Reconciles async bank transfers and finalizes creator wallet accounting.
 */
export async function handleXenditDisbursementCallback(
  payload: XenditDisbursementCallbackPayload
): Promise<{ success: boolean; payoutId?: string; error?: string }> {
  // Extract payout UUID from external_id (format: twistloom_payout_<uuid> or raw uuid)
  const externalId = payload.external_id || "";
  const rawId = externalId.startsWith("twistloom_payout_")
    ? externalId.replace("twistloom_payout_", "")
    : externalId;

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId);
  const payoutId = isUuid ? rawId : null;

  if (!payoutId && !payload.id) {
    return { success: false, error: "MISSING_IDENTIFIER" };
  }

  return await dbWrite.transaction(async (tx) => {
    // Lookup payout row
    const [payout] = await tx
      .select()
      .from(creatorPayouts)
      .where(
        payoutId
          ? eq(creatorPayouts.id, payoutId)
          : eq(creatorPayouts.providerPayoutId, payload.id)
      )
      .for("update")
      .limit(1);

    if (!payout) {
      return { success: false, error: "PAYOUT_NOT_FOUND" };
    }

    // Idempotency check: if payout has already reached terminal status, ignore duplicate
    if (payout.status === "completed" || payout.status === "failed") {
      return { success: true, payoutId: payout.id };
    }

    if (payload.status === "COMPLETED") {
      // 1. Finalize wallet deduction: pendingAmount -> withdrawnAmount
      await tx
        .update(creatorWallets)
        .set({
          pendingAmount: sql`GREATEST(0, ${creatorWallets.pendingAmount} - ${payout.amount})`,
          withdrawnAmount: sql`${creatorWallets.withdrawnAmount} + ${payout.amount}`,
          updatedAt: new Date(),
        })
        .where(eq(creatorWallets.creatorId, payout.creatorId));

      // 2. Mark payout completed
      await tx
        .update(creatorPayouts)
        .set({
          status: "completed",
          providerPayoutId: payload.id || payout.providerPayoutId,
          updatedAt: new Date(),
        })
        .where(eq(creatorPayouts.id, payout.id));

      // 3. Log audit event
      await tx.insert(creatorPayoutEvents).values({
        payoutId: payout.id,
        previousStatus: payout.status,
        newStatus: "completed",
        actorType: "webhook",
        note: `Disbursement completed via Xendit callback (${payload.bank_code || ""})`,
        metadata: {
          xenditId: payload.id,
          bankCode: payload.bank_code,
          amount: payload.amount,
        },
      });

      return { success: true, payoutId: payout.id };
    }

    if (payload.status === "FAILED") {
      // 1. Refund wallet: pendingAmount -> availableAmount
      await tx
        .update(creatorWallets)
        .set({
          availableAmount: sql`${creatorWallets.availableAmount} + ${payout.amount}`,
          pendingAmount: sql`GREATEST(0, ${creatorWallets.pendingAmount} - ${payout.amount})`,
          updatedAt: new Date(),
        })
        .where(eq(creatorWallets.creatorId, payout.creatorId));

      // 2. Mark payout failed
      await tx
        .update(creatorPayouts)
        .set({
          status: "failed",
          providerPayoutId: payload.id || payout.providerPayoutId,
          failureReason: payload.failure_code || "DISBURSEMENT_FAILED",
          updatedAt: new Date(),
        })
        .where(eq(creatorPayouts.id, payout.id));

      // 3. Log audit event
      await tx.insert(creatorPayoutEvents).values({
        payoutId: payout.id,
        previousStatus: payout.status,
        newStatus: "failed",
        actorType: "webhook",
        note: `Disbursement failed: ${payload.failure_code || "Unknown error"}`,
        metadata: {
          xenditId: payload.id,
          failureCode: payload.failure_code,
        },
      });

      return { success: true, payoutId: payout.id };
    }

    return { success: true, payoutId: payout.id };
  });
}
