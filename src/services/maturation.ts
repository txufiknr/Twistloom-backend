/**
 * Creator Earnings Maturation Service
 *
 * Implements the automated risk settlement hold & maturation pipeline.
 * Earnings entering the system via Thanks tipping or revenue share are
 * initially held in `status: "pending"` with a 14-day maturation settlement
 * hold (`matureAt`).
 *
 * Once `matureAt <= NOW()`, this engine transitions earnings to
 * `status: "completed"` and atomically transfers funds from
 * `creatorWallets.pendingAmount` to `creatorWallets.availableAmount`.
 *
 * @see docs/architecture/CREATOR_WALLET_ARCHITECTURE.md
 * @see docs/roadmap/CREATOR_PAYOUT_DISBURSEMENT_PIPELINE_ROADMAP.md
 */

import { eq, and, lte, inArray, sql } from "drizzle-orm";
import { dbWrite } from "../db/client.js";
import { creatorEarnings, creatorWallets } from "../db/schema.js";
import type { WalletCurrency, MaturationResult } from "../types/wallet.js";

const BATCH_SIZE = 500;
const MAX_BATCH_ROUNDS = 10;

/**
 * Scans for pending creator earnings whose settlement hold has expired,
 * transitions them to 'completed', and atomically moves the amounts
 * from pendingAmount to availableAmount in creatorWallets.
 *
 * @param asOfDate - Cutoff date for maturation (defaults to current timestamp)
 * @returns Summary of matured earnings count, unique creators, and amounts by currency
 */
export async function maturePendingEarnings(asOfDate: Date = new Date()): Promise<MaturationResult> {
  const result: MaturationResult = {
    maturedCount: 0,
    creatorsCount: 0,
    totalAmountsByCurrency: {
      IDR: 0,
      USD: 0,
    },
  };

  const processedCreatorIds = new Set<string>();
  let rounds = 0;

  while (rounds < MAX_BATCH_ROUNDS) {
    rounds++;

    // 1. Fetch a batch of pending earnings whose maturation hold has elapsed (from primary writer to prevent replica lag loops)
    const pendingRows = await dbWrite
      .select({
        id: creatorEarnings.id,
        creatorId: creatorEarnings.creatorId,
        creatorAmount: creatorEarnings.creatorAmount,
        currency: creatorEarnings.currency,
      })
      .from(creatorEarnings)
      .where(
        and(
          eq(creatorEarnings.status, "pending"),
          lte(creatorEarnings.matureAt, asOfDate)
        )
      )
      .limit(BATCH_SIZE);

    if (pendingRows.length === 0) {
      break;
    }

    // 2. Group by creator and currency to perform bulk ledger updates
    const creatorGroups = new Map<string, {
      creatorId: string;
      currency: WalletCurrency;
      earningIds: string[];
    }>();

    for (const row of pendingRows) {
      const currency = row.currency as WalletCurrency;
      const key = `${row.creatorId}:${currency}`;

      let group = creatorGroups.get(key);
      if (!group) {
        group = {
          creatorId: row.creatorId,
          currency,
          earningIds: [],
        };
        creatorGroups.set(key, group);
      }

      group.earningIds.push(row.id);
    }

    // 3. Process each creator group inside an atomic transaction
    for (const group of creatorGroups.values()) {
      await dbWrite.transaction(async (tx) => {
        // Atomically transition earnings status to 'completed' with conditional WHERE status = 'pending'
        const transitionedRows = await tx
          .update(creatorEarnings)
          .set({
            status: "completed",
            updatedAt: new Date(),
          })
          .where(
            and(
              inArray(creatorEarnings.id, group.earningIds),
              eq(creatorEarnings.status, "pending")
            )
          )
          .returning({
            id: creatorEarnings.id,
            creatorAmount: creatorEarnings.creatorAmount,
          });

        if (transitionedRows.length === 0) {
          return;
        }

        const actualMaturedAmount = transitionedRows.reduce(
          (sum, row) => sum + row.creatorAmount,
          0
        );

        // Move only the verified matured amount from pendingAmount to availableAmount
        await tx
          .update(creatorWallets)
          .set({
            availableAmount: sql`${creatorWallets.availableAmount} + ${actualMaturedAmount}`,
            pendingAmount: sql`GREATEST(0, ${creatorWallets.pendingAmount} - ${actualMaturedAmount})`,
            updatedAt: new Date(),
          })
          .where(eq(creatorWallets.creatorId, group.creatorId));

        result.maturedCount += transitionedRows.length;
        processedCreatorIds.add(group.creatorId);
        result.totalAmountsByCurrency[group.currency] =
          (result.totalAmountsByCurrency[group.currency] || 0) + actualMaturedAmount;
      });
    }

    // If batch was smaller than limit, we've exhausted all eligible records
    if (pendingRows.length < BATCH_SIZE) {
      break;
    }
  }

  result.creatorsCount = processedCreatorIds.size;
  return result;
}
