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

import { and, eq, sql, asc, desc, inArray, lte } from "drizzle-orm";
import { dbRead, dbWrite, type DBTransaction } from "../db/client.js";
import { pages, userConsumableEffects, userCounters, userInventory, userPageProgress, userStoryAnchors } from "../db/schema.js";
import { getConsumable, DANGER_SIGHT_DURATION_SECONDS } from "../config/consumables.js";
import { executeWithCredits } from "./credits.js";
import type { InventoryItemType } from "../types/consumable.js";

const MEGAPHONE: InventoryItemType = "megaphone";
const DANGER_SIGHT: InventoryItemType = "item_danger_sight";

/**
 * Every consumable activation/spend error returned to the client carries a
 * `code` that is exactly the i18n key suffix the frontend resolves under
 * `consumables.errors` (mirrors `BROADCAST_ERROR_CODES`). The English `error`
 * string in the envelope is a dev-facing / last-resort fallback only.
 * Keeping the vocabulary a const-derived union guarantees the constructor can
 * only ever emit a known code, so server and i18n catalog cannot drift.
 */
export const CONSUMABLE_ERROR_CODES = [
  "consumables.alreadyActive",
  "consumables.noneLeft",
] as const;

export type ConsumableErrorCode = (typeof CONSUMABLE_ERROR_CODES)[number];

/** Code-driven consumable error; mapped to HTTP by the route. */
export class ConsumableError extends Error {
  public readonly code: ConsumableErrorCode;

  constructor(code: ConsumableErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ConsumableError";
  }
}

/** Shared Danger Sight payload for activate + status responses. */
export interface DangerSightStatus {
  active: boolean;
  expiresAt: string | null;
  /** Server-authoritative seconds left; the client derives its countdown from this. */
  remainingSeconds: number;
}

export interface DangerSightActivationResult extends DangerSightStatus {
  /** Inventory left after the deduct — lets callers update their count without a refetch. */
  remainingItems: number;
}

function toDangerSightStatus(expiresAt: Date | null): DangerSightStatus {
  const remainingMs = expiresAt ? expiresAt.getTime() - Date.now() : 0;
  const remainingSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  return {
    active: remainingSeconds > 0,
    expiresAt: remainingSeconds > 0 && expiresAt ? expiresAt.toISOString() : null,
    remainingSeconds,
  };
}

/**
 * Reads the account-global Danger Sight buff state (pure read; the effect
 * row's `expiresAt` is the source of truth — no separate "active" flag to
 * drift). A missing or past-dated `user_consumable_effects` row reads as
 * inactive (lazy expiry).
 */
export async function getDangerSightStatus(userId: string): Promise<DangerSightStatus> {
  const [row] = await dbRead
    .select({ expiresAt: userConsumableEffects.expiresAt })
    .from(userConsumableEffects)
    .where(
      and(
        eq(userConsumableEffects.userId, userId),
        eq(userConsumableEffects.itemType, DANGER_SIGHT),
      ),
    )
    .limit(1);
  return toDangerSightStatus(row?.expiresAt ?? null);
}

/**
 * Activates 1 Danger Sight: atomically claims the user's
 * `(user_id, item_type)` row in `user_consumable_effects` via
 * `ON CONFLICT … WHERE expires_at <= now` (zero returned rows ⇒ a window is
 * still live ⇒ `409 alreadyActive` — no stacking, no `users` row lock), then
 * deducts 1 `item_danger_sight`, all in one transaction. A rollback on the
 * deduct also reverts the claim, so the effect row and inventory can never
 * diverge.
 *
 * @throws {ConsumableError} `consumables.alreadyActive` when the buff is live,
 *   `consumables.noneLeft` when the user owns zero lenses.
 */
export async function activateDangerSight(userId: string): Promise<DangerSightActivationResult> {
  const owned = await getUserItemCount(userId, DANGER_SIGHT);
  if (owned < 1) {
    throw new ConsumableError("consumables.noneLeft", "You have no Danger Sight lenses to activate.");
  }

  return dbWrite.transaction(async (tx) => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + DANGER_SIGHT_DURATION_SECONDS * 1000);

    const [effect] = await tx
      .insert(userConsumableEffects)
      .values({
        userId,
        itemType: DANGER_SIGHT,
        activatedAt: now,
        expiresAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [userConsumableEffects.userId, userConsumableEffects.itemType],
        set: { activatedAt: now, expiresAt, updatedAt: now },
        where: lte(userConsumableEffects.expiresAt, now),
      })
      .returning({ expiresAt: userConsumableEffects.expiresAt });

    if (!effect) {
      throw new ConsumableError("consumables.alreadyActive", "Danger Sight is already active.");
    }

    const remainingItems = await deductUserItem(tx, userId, DANGER_SIGHT, 1);

    return { ...toDangerSightStatus(effect.expiresAt), remainingItems };
  });
}

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
 * Verifies that a user has met the narrative feat requirement for dual-gated vault items.
 */
async function verifyHonorGate(
  userId: string,
  honorGate?: { metric: string; threshold: number; description: string },
  client: DBTransaction | typeof dbRead = dbRead,
): Promise<void> {
  if (!honorGate) return;

  const [counters] = await client
    .select()
    .from(userCounters)
    .where(eq(userCounters.userId, userId))
    .limit(1);

  const rawCounters = (counters ?? {}) as Record<string, unknown>;
  const val = rawCounters[honorGate.metric];
  const current = typeof val === "number" ? val : 0;

  if (current < honorGate.threshold) {
    throw new Error(
      `Honor Gate Locked: ${honorGate.description} (Progress: ${current}/${honorGate.threshold})`,
    );
  }
}

/**
 * Purchases one unit of a consumable item.
 * Charges the registry-defined credit price atomically via `executeWithCredits`
 * and increments the user's `user_inventory` in the same Postgres transaction.
 *
 * Enforces availability, honorGate, and `maxPerUser` inside the transaction lock.
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
      // Dual-Gate Principle: Enforce narrative honor gate inside the transaction lock
      await verifyHonorGate(userId, def.honorGate, tx);

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

  // Dual-Gate Principle: Enforce narrative honor gate before debiting credits
  await verifyHonorGate(userId, def.honorGate);

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

export interface DivergenceCheckResult {
  success: boolean;
  unexploredActionIndices: number[];
  unexploredActionTexts: string[];
  remainingCompasses: number;
}

/**
 * Evaluates branch choice exploration status for the current page.
 * Validates page existence first, deducts 1 Divergence Compass, and returns indices/texts of unvisited choices.
 *
 * Design Rationale:
 * A Divergence Compass performs an exploratory scan of the current decision junction.
 * Even if all branches have already been explored (unexploredActionIndices is empty), the scan
 * provides the critical diagnostic information that the reader has completely cleared this fork.
 * Therefore, the compass is intentionally consumed without refund upon successful scan.
 */
export async function checkDivergence(
  userId: string,
  bookId: string,
  pageId: string,
): Promise<DivergenceCheckResult> {
  return await dbWrite.transaction(async (tx) => {
    // 1. Fetch page actions and validate existence BEFORE deducting item
    const [page] = await tx
      .select({ actions: pages.actions })
      .from(pages)
      .where(and(eq(pages.id, pageId), eq(pages.bookId, bookId)))
      .limit(1);

    if (!page) {
      throw new Error(`Page not found: ${pageId}`);
    }

    // 2. Deduct 1 compass
    const remainingCompasses = await deductUserItem(tx, userId, "item_divergence_compass", 1);

    const pageActions = (page.actions ?? []) as Array<{
      text?: string;
      destinationPageIds?: string[];
    }>;

    // 3. Fetch all destination pages user has visited in this book
    const userProgress = await tx
      .select({ nextPageId: userPageProgress.nextPageId })
      .from(userPageProgress)
      .where(and(eq(userPageProgress.userId, userId), eq(userPageProgress.bookId, bookId)));

    const visitedPageIds = new Set(userProgress.map((p) => p.nextPageId));

    // 4. Identify unexplored actions
    const unexploredActionIndices: number[] = [];
    const unexploredActionTexts: string[] = [];

    pageActions.forEach((action, idx) => {
      const dests = action.destinationPageIds ?? [];
      const hasVisited = dests.length > 0 && dests.some((d) => visitedPageIds.has(d));
      if (!hasVisited) {
        unexploredActionIndices.push(idx);
        if (action.text) {
          unexploredActionTexts.push(action.text);
        }
      }
    });

    return {
      success: true,
      unexploredActionIndices,
      unexploredActionTexts,
      remainingCompasses,
    };
  });
}

export interface StoryAnchorItem {
  id: string;
  userId: string;
  bookId: string;
  pageId: string;
  pageNumber: number;
  choicePrompt: string | null;
  createdAt: Date;
}

const MAX_ANCHORS_PER_BOOK = 3;

/**
 * Drops a Memory Anchor at the current page/fork.
 * Deducts 1 Memory Anchor from inventory. Replaces the oldest anchor(s) if user already has 3.
 *
 * Concurrency Safety:
 * Queries existing anchors with `.for("update")` to serialize concurrent anchor placements.
 * Evicts all excess anchors so total count strictly remains <= MAX_ANCHORS_PER_BOOK.
 *
 * @param choicePrompt Optional concise text preview snippet (truncated to 40 chars in UI for backtrack menu preview)
 */
export async function dropMemoryAnchor(
  userId: string,
  bookId: string,
  pageId: string,
  pageNumber: number,
  choicePrompt?: string,
): Promise<{ success: boolean; anchor: StoryAnchorItem; remainingAnchors: number }> {
  return await dbWrite.transaction(async (tx) => {
    // 1. Deduct 1 anchor
    const remainingAnchors = await deductUserItem(tx, userId, "item_memory_anchor", 1);

    // 2. Check existing anchors for this user & book with row locking to serialize concurrent requests
    const existing = await tx
      .select({ id: userStoryAnchors.id, createdAt: userStoryAnchors.createdAt })
      .from(userStoryAnchors)
      .where(and(eq(userStoryAnchors.userId, userId), eq(userStoryAnchors.bookId, bookId)))
      .orderBy(asc(userStoryAnchors.createdAt))
      .for("update");

    // If >= MAX_ANCHORS_PER_BOOK, evict enough oldest anchors to make room for 1 new anchor
    if (existing.length >= MAX_ANCHORS_PER_BOOK) {
      const excessCount = existing.length - MAX_ANCHORS_PER_BOOK + 1;
      const idsToDelete = existing.slice(0, excessCount).map((a) => a.id);
      await tx.delete(userStoryAnchors).where(inArray(userStoryAnchors.id, idsToDelete));
    }

    // 3. Insert new anchor
    const [inserted] = await tx
      .insert(userStoryAnchors)
      .values({
        userId,
        bookId,
        pageId,
        pageNumber,
        choicePrompt: choicePrompt || null,
      })
      .returning();

    return {
      success: true,
      anchor: inserted,
      remainingAnchors,
    };
  });
}

/**
 * Retrieves all saved memory anchors for a user in a specific book.
 */
export async function getStoryAnchors(
  userId: string,
  bookId: string,
): Promise<StoryAnchorItem[]> {
  const anchors = await dbRead
    .select()
    .from(userStoryAnchors)
    .where(and(eq(userStoryAnchors.userId, userId), eq(userStoryAnchors.bookId, bookId)))
    .orderBy(desc(userStoryAnchors.createdAt));

  return anchors;
}

/**
 * Deletes a saved memory anchor.
 */
export async function deleteStoryAnchor(
  userId: string,
  anchorId: string,
): Promise<{ success: boolean }> {
  await dbWrite
    .delete(userStoryAnchors)
    .where(and(eq(userStoryAnchors.id, anchorId), eq(userStoryAnchors.userId, userId)));

  return { success: true };
}

