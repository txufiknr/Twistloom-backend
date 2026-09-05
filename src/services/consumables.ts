/**
 * Consumable Items & User Inventory Service
 *
 * Generic, registry-driven purchase, spend, and balance checking for
 * credit-bought, inventory-backed consumables (📣 Megaphone, potions, tokens, etc.).
 *
 * Core principles:
 * - Credits buy items via `executeWithCredits` (row-locked, auto-refund on fail).
 * - Features spend items via `deductUserItem` inside their own feature transactions.
 * - Single source of truth for price/availability lives in `CONSUMABLES_REGISTRY`.
 *
 * @see src/config/consumables.ts
 * @see src/db/schema.ts (`user_inventory`)
 */

import { and, eq, sql } from "drizzle-orm";
import { dbRead, type DBTransaction } from "../db/client.js";
import { userInventory } from "../db/schema.js";
import { getConsumable } from "../config/consumables.js";
import { executeWithCredits } from "./credits.js";
import type { InventoryItemType } from "../types/consumable.js";

const MEGAPHONE: InventoryItemType = "megaphone";

/**
 * Returns the user's owned quantity of a consumable item (0 when unowned).
 */
export async function getUserItemCount(
  userId: string,
  itemType: InventoryItemType,
): Promise<number> {
  const [row] = await dbRead
    .select({ quantity: userInventory.quantity })
    .from(userInventory)
    .where(and(eq(userInventory.userId, userId), eq(userInventory.itemType, itemType)))
    .limit(1);
  return row?.quantity ?? 0;
}

/** Convenience wrapper for the 📣 Megaphone count. */
export async function getUserMegaphoneCount(userId: string): Promise<number> {
  return getUserItemCount(userId, MEGAPHONE);
}

/**
 * Purchases one unit of a consumable item.
 * Charges the registry-defined credit price atomically via `executeWithCredits`
 * and increments the user's `user_inventory` in the same Postgres transaction.
 *
 * Enforces availability and `maxPerUser` inside the transaction lock.
 *
 * @param userId - Buyer
 * @param itemType - Registry item to buy (defaults to 📣 Megaphone)
 * @returns The new owned quantity of that item
 */
export async function purchaseConsumable(
  userId: string,
  itemType: InventoryItemType = MEGAPHONE,
): Promise<number> {
  const def = getConsumable(itemType);
  if (!def.available) {
    throw new Error(`${def.name} is not available for purchase`);
  }

  const { result } = await executeWithCredits(
    userId,
    def.creditsPrice,
    async (tx) => {
      // Re-check per-user cap inside the transaction if defined
      if (def.maxPerUser !== undefined) {
        const [existing] = await tx
          .select({ quantity: userInventory.quantity })
          .from(userInventory)
          .where(and(eq(userInventory.userId, userId), eq(userInventory.itemType, itemType)))
          .for("update")
          .limit(1);

        const currentQty = existing?.quantity ?? 0;
        if (currentQty >= def.maxPerUser) {
          throw new Error(`You already own the maximum of ${def.maxPerUser} ${def.name}`);
        }
      }

      await tx
        .insert(userInventory)
        .values({ userId, itemType, quantity: 1, lastPurchasedAt: new Date() })
        .onConflictDoUpdate({
          target: [userInventory.userId, userInventory.itemType],
          set: {
            quantity: sql`${userInventory.quantity} + 1`,
            lastPurchasedAt: new Date(),
            updatedAt: new Date(),
          },
        });

      const [row] = await tx
        .select({ quantity: userInventory.quantity })
        .from(userInventory)
        .where(and(eq(userInventory.userId, userId), eq(userInventory.itemType, itemType)))
        .limit(1);

      return row?.quantity ?? 0;
    },
    { context: "consumable_purchase", metadata: { itemType } },
  );

  return result;
}

/**
 * Purchases multiple units of a consumable item in a single atomic transaction.
 *
 * Charges `creditsPrice * quantity` credits via `executeWithCredits` and performs
 * a single upsert incrementing by `quantity`. Either all units are acquired or
 * none (on insufficient credits, maxPerUser breach, etc.).
 *
 * @param userId - Buyer
 * @param itemType - Registry item to buy
 * @param quantity - Number of units to purchase (must be ≥ 1)
 * @returns The new owned quantity of that item after the batch purchase
 */
export async function purchaseConsumableBatch(
  userId: string,
  itemType: InventoryItemType,
  quantity: number,
): Promise<number> {
  if (quantity < 1) throw new Error("quantity must be at least 1");

  const def = getConsumable(itemType);
  if (!def.available) {
    throw new Error(`${def.name} is not available for purchase`);
  }

  const totalCost = def.creditsPrice * quantity;

  const { result } = await executeWithCredits(
    userId,
    totalCost,
    async (tx) => {
      // Enforce per-user cap inside the transaction if defined
      if (def.maxPerUser !== undefined) {
        const [existing] = await tx
          .select({ quantity: userInventory.quantity })
          .from(userInventory)
          .where(and(eq(userInventory.userId, userId), eq(userInventory.itemType, itemType)))
          .for("update")
          .limit(1);

        const currentQty = existing?.quantity ?? 0;
        if (currentQty + quantity > def.maxPerUser) {
          throw new Error(
            `Cannot purchase ${quantity} × ${def.name} — you already own ${currentQty}, max is ${def.maxPerUser}`,
          );
        }
      }

      await tx
        .insert(userInventory)
        .values({ userId, itemType, quantity, lastPurchasedAt: new Date() })
        .onConflictDoUpdate({
          target: [userInventory.userId, userInventory.itemType],
          set: {
            quantity: sql`${userInventory.quantity} + ${quantity}`,
            lastPurchasedAt: new Date(),
            updatedAt: new Date(),
          },
        });

      const [row] = await tx
        .select({ quantity: userInventory.quantity })
        .from(userInventory)
        .where(and(eq(userInventory.userId, userId), eq(userInventory.itemType, itemType)))
        .limit(1);

      return row?.quantity ?? 0;
    },
    { context: "consumable_purchase", metadata: { itemType, quantity } },
  );

  return result;
}

/**
 * Deducts an item from the user's inventory inside a caller's transaction.
 *
 * Uses `SELECT ... FOR UPDATE` to prevent concurrent double-spends.
 *
 * @param tx - Active database transaction
 * @param userId - Owner
 * @param itemType - Consumable key to spend
 * @param amount - Quantity to deduct (defaults to 1)
 * @returns Remaining quantity after deduction
 * @throws Error if the user owns fewer than `amount` items
 */
export async function deductUserItem(
  tx: DBTransaction,
  userId: string,
  itemType: InventoryItemType,
  amount: number = 1,
): Promise<number> {
  const [item] = await tx
    .select({ id: userInventory.id, quantity: userInventory.quantity })
    .from(userInventory)
    .where(and(eq(userInventory.userId, userId), eq(userInventory.itemType, itemType)))
    .for("update")
    .limit(1);

  if (!item || item.quantity < amount) {
    const def = getConsumable(itemType);
    throw new Error(`Insufficient ${def.name}. You own ${item?.quantity ?? 0}, but ${amount} is required.`);
  }

  const remaining = item.quantity - amount;

  await tx
    .update(userInventory)
    .set({ quantity: remaining, updatedAt: new Date() })
    .where(eq(userInventory.id, item.id));

  return remaining;
}
