/**
 * 🥚 Easter Egg Service
 *
 * Handles runtime ephemeral roll checks, idempotent claims, and mystery-gift cracking.
 *
 * Core principles:
 * - Ephemeral rolls: no uncollected spawn rows in DB.
 * - Cryptographic claim tokens (HMAC-SHA256, 5-minute TTL).
 * - Anti-farm: rate limiting + cooldown + daily roll budget.
 * - Idempotent claims into `easter_egg_discoveries` (drives trigger #11 for lifetime counter).
 * - Weighted mystery-gift reward draws with platform-safe credit economy guardrails.
 *
 * @see src/db/schema.ts (`easterEggDiscoveries`, `easterEggRollBudget`, `userInventory`, `userCounters`)
 * @see docs/roadmap/EASTER_EGG_SYSTEM_ROADMAP.md
 */

import { createHmac, timingSafeEqual } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../db/client.js";
import {
  easterEggDiscoveries,
  easterEggRollBudget,
  userCounters,
  userInventory,
} from "../db/schema.js";
import { generateId } from "../utils/uuid.js";
import { deductUserItem } from "./consumables.js";
import { addCredits } from "./credits.js";
import { sendSystemBroadcast } from "./broadcast.js";

const CLAIM_TOKEN_SECRET =
  process.env.EASTER_EGG_SECRET ||
  process.env.NEXTAUTH_SECRET ||
  process.env.JWT_SECRET ||
  "twistloom-easter-egg-signing-secret-key-2026";

const CLAIM_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes
const ROLL_COOLDOWN_MS = 15 * 1000; // 15 seconds between rolls
const DAILY_ROLL_CAP = 50; // Max 50 rolls/day

export interface ClaimTokenPayload {
  userId: string;
  bookId: string;
  pageId: string;
  paragraphIndex: number;
  exp: number;
}

/**
 * Generates an HMAC-signed claim token.
 */
export function generateClaimToken(payload: ClaimTokenPayload): string {
  const json = JSON.stringify(payload);
  const dataB64 = Buffer.from(json).toString("base64url");
  const signature = createHmac("sha256", CLAIM_TOKEN_SECRET)
    .update(dataB64)
    .digest("base64url");
  return `${dataB64}.${signature}`;
}

/**
 * Validates and decodes an HMAC-signed claim token.
 */
export function verifyClaimToken(token: string, expectedUserId: string): ClaimTokenPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [dataB64, signature] = parts;

    const expectedSignature = createHmac("sha256", CLAIM_TOKEN_SECRET)
      .update(dataB64)
      .digest("base64url");

    if (
      signature.length !== expectedSignature.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))
    ) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(dataB64, "base64url").toString("utf-8")) as ClaimTokenPayload;
    if (!payload || payload.userId !== expectedUserId) return null;
    if (Date.now() > payload.exp) return null;

    return payload;
  } catch {
    return null;
  }
}

export interface EasterEggCheckResult {
  show: boolean;
  paragraphIndex?: number;
  claimToken?: string;
}

/**
 * Performs a lightweight runtime dice roll for Easter Egg discovery on page navigation.
 */
export async function checkEasterEgg(
  userId: string,
  bookId: string,
  pageId: string,
  paragraphCount: number = 3,
): Promise<EasterEggCheckResult> {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  // 1. Check if user already claimed an egg for this page
  const [alreadyClaimed] = await dbRead
    .select({ id: easterEggDiscoveries.id })
    .from(easterEggDiscoveries)
    .where(and(eq(easterEggDiscoveries.userId, userId), eq(easterEggDiscoveries.pageId, pageId)))
    .limit(1);

  if (alreadyClaimed) {
    return { show: false };
  }

  // 2. Anti-farm roll budget check
  const [budget] = await dbRead
    .select({
      lastRollAt: easterEggRollBudget.lastRollAt,
      rollsToday: easterEggRollBudget.rollsToday,
      day: easterEggRollBudget.day,
    })
    .from(easterEggRollBudget)
    .where(eq(easterEggRollBudget.userId, userId))
    .limit(1);

  const isToday = budget?.day === today;
  const rollsToday = isToday ? budget.rollsToday : 0;
  const lastRollAt = budget?.lastRollAt;

  // Check cooldown (< 15s)
  if (lastRollAt && now.getTime() - lastRollAt.getTime() < ROLL_COOLDOWN_MS) {
    return { show: false };
  }

  // Check daily limit (50 rolls/day)
  if (rollsToday >= DAILY_ROLL_CAP) {
    return { show: false };
  }

  // Update roll budget
  await dbWrite
    .insert(easterEggRollBudget)
    .values({
      userId,
      lastRollAt: now,
      rollsToday: 1,
      day: today,
    })
    .onConflictDoUpdate({
      target: [easterEggRollBudget.userId],
      set: {
        lastRollAt: now,
        rollsToday: isToday ? sql`${easterEggRollBudget.rollsToday} + 1` : 1,
        day: today,
        updatedAt: now,
      },
    });

  // 3. Roll probability with newcomer boost & soft anti-drought
  const [counters] = await dbRead
    .select({ easterEggsFound: userCounters.easterEggsFound })
    .from(userCounters)
    .where(eq(userCounters.userId, userId))
    .limit(1);

  const lifetimeFound = counters?.easterEggsFound ?? 0;

  let probability = 0.002; // Base: 0.2% (~1 in 500 pages)
  if (lifetimeFound === 0) {
    probability = 0.05; // Newcomer welcome boost: 5% (~1 in 20 pages)
  } else if (rollsToday >= 40) {
    probability = 0.005; // Soft anti-drought boost: 0.5%
  }

  const rolled = Math.random() < probability;
  if (!rolled) {
    return { show: false };
  }

  // 4. On Hit: pick random paragraph index & issue claim token
  const validParagraphCount = Math.max(1, paragraphCount);
  const paragraphIndex = Math.floor(Math.random() * validParagraphCount);

  const claimToken = generateClaimToken({
    userId,
    bookId,
    pageId,
    paragraphIndex,
    exp: Date.now() + CLAIM_TOKEN_TTL_MS,
  });

  return {
    show: true,
    paragraphIndex,
    claimToken,
  };
}

export interface EasterEggClaimResult {
  success: boolean;
  easterEggsFound: number;
  inventoryQuantity: number;
}

/**
 * Claims a discovered Easter Egg using a verified claim token.
 */
export async function claimEasterEgg(
  userId: string,
  claimToken: string,
): Promise<EasterEggClaimResult> {
  const payload = verifyClaimToken(claimToken, userId);
  if (!payload) {
    throw new Error("Invalid or expired Easter Egg claim token.");
  }

  const result = await dbWrite.transaction(async (tx) => {
    // 1. Insert into claim log (idempotent)
    const discoveryId = generateId();
    const [inserted] = await tx
      .insert(easterEggDiscoveries)
      .values({
        id: discoveryId,
        userId,
        bookId: payload.bookId,
        pageId: payload.pageId,
        paragraphIndex: payload.paragraphIndex,
        kind: "easter_egg",
      })
      .onConflictDoNothing()
      .returning({ id: easterEggDiscoveries.id });

    if (!inserted) {
      // Already claimed: fetch current state
      const [existingCounters] = await tx
        .select({ easterEggsFound: userCounters.easterEggsFound })
        .from(userCounters)
        .where(eq(userCounters.userId, userId))
        .limit(1);

      const [existingInv] = await tx
        .select({ quantity: userInventory.quantity })
        .from(userInventory)
        .where(and(eq(userInventory.userId, userId), eq(userInventory.itemType, "easter_egg")))
        .limit(1);

      return {
        success: true,
        easterEggsFound: existingCounters?.easterEggsFound ?? 1,
        inventoryQuantity: existingInv?.quantity ?? 0,
      };
    }

    // 2. Grant +1 easter_egg to user_inventory
    await tx
      .insert(userInventory)
      .values({
        userId,
        itemType: "easter_egg",
        quantity: 1,
        lastPurchasedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [userInventory.userId, userInventory.itemType],
        set: {
          quantity: sql`${userInventory.quantity} + 1`,
          updatedAt: new Date(),
        },
      });

    // 3. Read updated counters & inventory (Trigger #11 increments user_counters automatically)
    const [updatedCounters] = await tx
      .select({ easterEggsFound: userCounters.easterEggsFound })
      .from(userCounters)
      .where(eq(userCounters.userId, userId))
      .limit(1);

    const [updatedInv] = await tx
      .select({ quantity: userInventory.quantity })
      .from(userInventory)
      .where(and(eq(userInventory.userId, userId), eq(userInventory.itemType, "easter_egg")))
      .limit(1);

    const easterEggsFound = updatedCounters?.easterEggsFound ?? 1;
    const inventoryQuantity = updatedInv?.quantity ?? 1;

    // 4. System broadcast on user's very first lifetime discovery
    if (easterEggsFound === 1) {
      sendSystemBroadcast(
        userId,
        "🥚 A secret was uncovered. A reader found their first Easter Egg in the Loom.",
      ).catch(() => {});
    }

    return {
      success: true,
      easterEggsFound,
      inventoryQuantity,
    };
  });

  return result;
}

export type RewardType = "credits" | "megaphone" | "cosmetic";

export interface EasterEggReward {
  type: RewardType;
  name: string;
  description: string;
  icon: string;
  creditsAmount?: number;
  quantity?: number;
  isJackpot?: boolean;
}

export interface EasterEggCrackResult {
  success: boolean;
  reward: EasterEggReward;
  remainingEggs: number;
}

/**
 * Cracks open one owned Easter Egg to draw a weighted mystery reward.
 */
export async function crackEasterEgg(userId: string): Promise<EasterEggCrackResult> {
  const result = await dbWrite.transaction(async (tx) => {
    // 1. Deduct 1 Easter Egg from user's inventory
    const remainingEggs = await deductUserItem(tx, userId, "easter_egg", 1);

    // 2. Draw weighted random reward
    // Weights:
    // 50% → 10-25 credits (Common)
    // 25% → 30-50 credits (Uncommon)
    // 15% → 1 × 📣 Megaphone (Rare)
    // 7%  → 75-100 credits (Rare)
    // 3%  → 250 credits Jackpot (Extremely Rare)
    const rand = Math.random() * 100;
    let reward: EasterEggReward;

    if (rand < 50) {
      // 10-25 credits
      const credits = 10 + Math.floor(Math.random() * 16);
      await addCredits(userId, credits, { context: "easter_egg_crack", tx });
      reward = {
        type: "credits",
        name: `${credits} Credits`,
        description: "A handful of shimmering Loom credits.",
        icon: "🪙",
        creditsAmount: credits,
        isJackpot: false,
      };
    } else if (rand < 75) {
      // 30-50 credits
      const credits = 30 + Math.floor(Math.random() * 21);
      await addCredits(userId, credits, { context: "easter_egg_crack", tx });
      reward = {
        type: "credits",
        name: `${credits} Credits`,
        description: "A generous pouch of Loom credits.",
        icon: "✨",
        creditsAmount: credits,
        isJackpot: false,
      };
    } else if (rand < 90) {
      // 1 × Megaphone
      await tx
        .insert(userInventory)
        .values({
          userId,
          itemType: "megaphone",
          quantity: 1,
          lastPurchasedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [userInventory.userId, userInventory.itemType],
          set: {
            quantity: sql`${userInventory.quantity} + 1`,
            updatedAt: new Date(),
          },
        });
      reward = {
        type: "megaphone",
        name: "1 × 📣 Megaphone",
        description: "A golden megaphone to broadcast your voice to all readers across the Loom.",
        icon: "📣",
        quantity: 1,
        isJackpot: false,
      };
    } else if (rand < 97) {
      // 75-100 credits
      const credits = 75 + Math.floor(Math.random() * 26);
      await addCredits(userId, credits, { context: "easter_egg_crack", tx });
      reward = {
        type: "credits",
        name: `${credits} Credits`,
        description: "A glowing cache of Loom credits!",
        icon: "💎",
        creditsAmount: credits,
        isJackpot: false,
      };
    } else {
      // 250 credits Jackpot!
      const credits = 250;
      await addCredits(userId, credits, { context: "easter_egg_crack", tx });
      reward = {
        type: "credits",
        name: "250 Credits Jackpot!",
        description: "The egg bursts with radiant energy! You struck the Easter Egg Jackpot!",
        icon: "👑",
        creditsAmount: credits,
        isJackpot: true,
      };

      // Broadcast jackpot announcement
      sendSystemBroadcast(
        userId,
        "✨ A mystery Easter Egg cracked open to reveal a rare 250 Credit Jackpot!",
      ).catch(() => {});
    }

    return {
      success: true,
      reward,
      remainingEggs,
    };
  });

  return result;
}
