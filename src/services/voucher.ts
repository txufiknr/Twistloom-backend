/**
 * Credit Voucher Service
 *
 * Handles code generation, HMAC hashing, and redemption logic.
 * @see docs/roadmap/TWISTLOOM_CREDIT_VOUCHERS_AND_PROMOTIONAL_ENTITLEMENTS_ROADMAP.md §9
 */

import { createHmac, randomBytes } from "node:crypto";
import { eq, and, sql, desc } from "drizzle-orm";
import { dbRead, dbWrite } from "../db/client.js";
import {
  creditVoucherCampaigns,
  creditVoucherCodes,
  creditVoucherRedemptions,
  users,
  transactions,
} from "../db/schema.js";
import { generateId } from "../utils/uuid.js";
import { addCredits } from "./credits.js";
import type {
  RedeemCreditVoucherResponse,
  AdminVoucherCampaignListItem,
  AdminVoucherCampaignDetail,
  AdminGenerateCodesResponse,
} from "../types/voucher.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CODE_LENGTH = 12;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous I/1/O/0
const HMAC_KEY = process.env.VOUCHER_HMAC_KEY || process.env.SESSION_SECRET || "twistloom-voucher-dev-key";
const HMAC_KEY_VERSION = 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a user-supplied voucher code: trim, uppercase, strip spaces and hyphens.
 */
export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]/g, "");
}

/**
 * Compute HMAC-SHA-256 digest of a normalized code.
 */
export function hmacCode(normalizedCode: string, keyVersion = HMAC_KEY_VERSION): string {
  const key = `${HMAC_KEY}_v${keyVersion}`;
  return createHmac("sha256", key).update(normalizedCode).digest("hex");
}

/**
 * Generate a random voucher code of the given length.
 */
function generateRawCode(length = CODE_LENGTH): string {
  const bytes = randomBytes(length);
  let code = "";
  for (let i = 0; i < length; i++) {
    code += CODE_CHARS[bytes[i] % CODE_CHARS.length];
  }
  return code;
}

// ---------------------------------------------------------------------------
// Campaign queries (admin)
// ---------------------------------------------------------------------------

export async function listCampaigns(): Promise<AdminVoucherCampaignListItem[]> {
  const rows = await dbRead
    .select({
      id: creditVoucherCampaigns.id,
      slug: creditVoucherCampaigns.slug,
      displayName: creditVoucherCampaigns.displayName,
      status: creditVoucherCampaigns.status,
      grantType: creditVoucherCampaigns.grantType,
      creditsPerRedemption: creditVoucherCampaigns.creditsPerRedemption,
      maxRedemptions: creditVoucherCampaigns.maxRedemptions,
      maxRedemptionsPerUser: creditVoucherCampaigns.maxRedemptionsPerUser,
      startsAt: creditVoucherCampaigns.startsAt,
      endsAt: creditVoucherCampaigns.endsAt,
      createdByUserId: creditVoucherCampaigns.createdByUserId,
      createdAt: creditVoucherCampaigns.createdAt,
      codesIssued: sql<number>`count(${creditVoucherCodes.id})::int`,
      codesRedeemed: sql<number>`coalesce(sum(${creditVoucherCodes.redeemedCount}), 0)::int`,
    })
    .from(creditVoucherCampaigns)
    .leftJoin(creditVoucherCodes, eq(creditVoucherCodes.campaignId, creditVoucherCampaigns.id))
    .groupBy(creditVoucherCampaigns.id)
    .orderBy(desc(creditVoucherCampaigns.createdAt));

  return rows.map((r) => ({
    ...r,
    status: r.status as AdminVoucherCampaignListItem["status"],
    grantType: r.grantType as AdminVoucherCampaignListItem["grantType"],
    startsAt: r.startsAt?.toISOString() ?? null,
    endsAt: r.endsAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function getCampaign(id: string): Promise<AdminVoucherCampaignDetail | null> {
  const [row] = await dbRead
    .select()
    .from(creditVoucherCampaigns)
    .where(eq(creditVoucherCampaigns.id, id))
    .limit(1);

  if (!row) return null;

  const [{ codesIssued }] = await dbRead
    .select({ codesIssued: sql<number>`count(${creditVoucherCodes.id})::int` })
    .from(creditVoucherCodes)
    .where(eq(creditVoucherCodes.campaignId, id));

  const [{ codesRedeemed }] = await dbRead
    .select({ codesRedeemed: sql<number>`coalesce(sum(${creditVoucherCodes.redeemedCount}), 0)::int` })
    .from(creditVoucherCodes)
    .where(eq(creditVoucherCodes.campaignId, id));

  return {
    ...row,
    status: row.status as AdminVoucherCampaignDetail["status"],
    grantType: row.grantType as AdminVoucherCampaignDetail["grantType"],
    eligibilityPolicy: row.eligibilityPolicy as AdminVoucherCampaignDetail["eligibilityPolicy"],
    distributionType: row.distributionType as AdminVoucherCampaignDetail["distributionType"],
    codesIssued,
    codesRedeemed,
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    createdByUserId: row.createdByUserId,
    approvedByUserId: row.approvedByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function createCampaign(data: {
  slug: string;
  displayName: string;
  internalPurpose: string;
  creditsPerRedemption: number;
  maxRedemptions: number;
  maxRedemptionsPerUser?: number;
  startsAt?: Date | null;
  endsAt?: Date | null;
  eligibilityPolicy?: string;
  distributionType?: string;
  createdByUserId: string;
}): Promise<AdminVoucherCampaignDetail> {
  const [row] = await dbWrite
    .insert(creditVoucherCampaigns)
    .values({
      slug: data.slug,
      displayName: data.displayName,
      internalPurpose: data.internalPurpose,
      creditsPerRedemption: data.creditsPerRedemption,
      maxRedemptions: data.maxRedemptions,
      maxRedemptionsPerUser: data.maxRedemptionsPerUser ?? 1,
      startsAt: data.startsAt ?? null,
      endsAt: data.endsAt ?? null,
      eligibilityPolicy: data.eligibilityPolicy ?? "open",
      distributionType: data.distributionType ?? "single_use_batch",
      createdByUserId: data.createdByUserId,
    })
    .returning();

  return {
    ...row,
    status: row.status as AdminVoucherCampaignDetail["status"],
    grantType: row.grantType as AdminVoucherCampaignDetail["grantType"],
    eligibilityPolicy: row.eligibilityPolicy as AdminVoucherCampaignDetail["eligibilityPolicy"],
    distributionType: row.distributionType as AdminVoucherCampaignDetail["distributionType"],
    codesIssued: 0,
    codesRedeemed: 0,
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    createdByUserId: row.createdByUserId,
    approvedByUserId: row.approvedByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function updateCampaign(
  id: string,
  data: {
    displayName?: string;
    internalPurpose?: string;
    status?: string;
    creditsPerRedemption?: number;
    maxRedemptions?: number;
    maxRedemptionsPerUser?: number;
    startsAt?: Date | null;
    endsAt?: Date | null;
  }
): Promise<AdminVoucherCampaignDetail | null> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (data.displayName !== undefined) updates.displayName = data.displayName;
  if (data.internalPurpose !== undefined) updates.internalPurpose = data.internalPurpose;
  if (data.status !== undefined) updates.status = data.status;
  if (data.creditsPerRedemption !== undefined) updates.creditsPerRedemption = data.creditsPerRedemption;
  if (data.maxRedemptions !== undefined) updates.maxRedemptions = data.maxRedemptions;
  if (data.maxRedemptionsPerUser !== undefined) updates.maxRedemptionsPerUser = data.maxRedemptionsPerUser;
  if (data.startsAt !== undefined) updates.startsAt = data.startsAt;
  if (data.endsAt !== undefined) updates.endsAt = data.endsAt;

  const [row] = await dbWrite
    .update(creditVoucherCampaigns)
    .set(updates)
    .where(eq(creditVoucherCampaigns.id, id))
    .returning();

  if (!row) return null;
  return getCampaign(id);
}

// ---------------------------------------------------------------------------
// Code generation (admin)
// ---------------------------------------------------------------------------

export async function generateCodes(
  campaignId: string,
  count: number
): Promise<AdminGenerateCodesResponse> {
  const rawCodes: string[] = [];
  const codeRows: Array<{
    campaignId: string;
    codeHmac: string;
    hmacKeyVersion: number;
    publicPrefix: string;
    lastFour: string;
    status: string;
  }> = [];

  for (let i = 0; i < count; i++) {
    const raw = generateRawCode();
    const normalized = normalizeCode(raw);
    const hmac = hmacCode(normalized);
    rawCodes.push(raw);
    codeRows.push({
      campaignId,
      codeHmac: hmac,
      hmacKeyVersion: HMAC_KEY_VERSION,
      publicPrefix: normalized.slice(0, 4),
      lastFour: normalized.slice(-4),
      status: "active",
    });
  }

  await dbWrite.insert(creditVoucherCodes).values(codeRows);

  return { campaignId, generated: count, codes: rawCodes };
}

// ---------------------------------------------------------------------------
// Redemption (customer)
// ---------------------------------------------------------------------------

/**
 * Redeem a voucher code for the given user.
 *
 * Returns the canonical redemption result or throws with a machine-readable
 * error code in `error.code`.
 */
export async function redeemVoucher(
  userId: string,
  rawCode: string,
  idempotencyKey: string
): Promise<RedeemCreditVoucherResponse> {
  const normalized = normalizeCode(rawCode);
  if (normalized.length < 6) {
    throw Object.assign(new Error("Invalid voucher code"), { code: "invalid_or_unavailable" });
  }

  // Rate-limit: max 5 attempts per minute per user
  // (basic check — real rate limiting done at route layer via Redis)

  const codeHmac = hmacCode(normalized);

  return dbWrite.transaction(async (tx) => {
    // Lock the code row for update
    const [codeRow] = await tx
      .select()
      .from(creditVoucherCodes)
      .where(eq(creditVoucherCodes.codeHmac, codeHmac))
      .for("update")
      .limit(1);

    if (!codeRow || codeRow.status !== "active") {
      throw Object.assign(new Error("Invalid or unavailable voucher code"), {
        code: "invalid_or_unavailable",
      });
    }

    // Lock the campaign row for update
    const [campaign] = await tx
      .select()
      .from(creditVoucherCampaigns)
      .where(eq(creditVoucherCampaigns.id, codeRow.campaignId))
      .for("update")
      .limit(1);

    if (!campaign) {
      throw Object.assign(new Error("Campaign not found"), { code: "invalid_or_unavailable" });
    }

    // Validate campaign status
    if (campaign.status !== "active") {
      throw Object.assign(new Error("Campaign is not active"), { code: "invalid_or_unavailable" });
    }

    // Validate time window
    const now = new Date();
    if (campaign.startsAt && now < campaign.startsAt) {
      throw Object.assign(new Error("Campaign has not started"), { code: "temporarily_unavailable" });
    }
    if (campaign.endsAt && now > campaign.endsAt) {
      throw Object.assign(new Error("Campaign has ended"), { code: "invalid_or_unavailable" });
    }

    // Validate code max redemptions
    if (codeRow.maxRedemptions > 0 && codeRow.redeemedCount >= codeRow.maxRedemptions) {
      throw Object.assign(new Error("Code has been fully redeemed"), { code: "invalid_or_unavailable" });
    }

    // Validate campaign max redemptions
    if (campaign.maxRedemptions > 0) {
      const [{ total }] = await tx
        .select({ total: sql<number>`count(*)::int` })
        .from(creditVoucherRedemptions)
        .where(eq(creditVoucherRedemptions.campaignId, campaign.id));
      if (total >= campaign.maxRedemptions) {
        throw Object.assign(new Error("Campaign redemption limit reached"), {
          code: "campaign_limit_reached",
        });
      }
    }

    // Validate per-user limit
    if (campaign.maxRedemptionsPerUser > 0) {
      const [{ userCount }] = await tx
        .select({ userCount: sql<number>`count(*)::int` })
        .from(creditVoucherRedemptions)
        .where(
          and(
            eq(creditVoucherRedemptions.campaignId, campaign.id),
            eq(creditVoucherRedemptions.userId, userId)
          )
        );
      if (userCount >= campaign.maxRedemptionsPerUser) {
        throw Object.assign(new Error("You have already redeemed this code"), {
          code: "already_redeemed_by_you",
        });
      }
    }

    // Check idempotency — replay existing result
    const [existing] = await tx
      .select()
      .from(creditVoucherRedemptions)
      .where(eq(creditVoucherRedemptions.idempotencyKey, idempotencyKey))
      .limit(1);

    if (existing) {
      const [user] = await tx
        .select({ credits: users.credits })
        .from(users)
        .where(eq(users.userId, userId))
        .limit(1);

      return {
        redemptionId: existing.id,
        transactionId: existing.transactionId,
        creditsGranted: existing.creditsGranted,
        newBalance: user?.credits ?? 0,
        campaignDisplayName: campaign.displayName,
        redeemedAt: existing.redeemedAt.toISOString(),
      };
    }

    // Issue credits
    const creditsAwarded = campaign.creditsPerRedemption;
    const newBalance = await addCredits(userId, creditsAwarded, {
      tx,
      context: "voucher_redemption",
      metadata: { campaignId: campaign.id, codeId: codeRow.id },
    });

    // Get the transaction ID we just created
    const [txn] = await tx
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          eq(transactions.userId, userId),
          eq(transactions.context, "voucher_redemption"),
          eq(transactions.type, "reward")
        )
      )
      .orderBy(desc(transactions.createdAt))
      .limit(1);

    // Insert redemption record
    const [redemption] = await tx
      .insert(creditVoucherRedemptions)
      .values({
        campaignId: campaign.id,
        codeId: codeRow.id,
        userId,
        creditsGranted: creditsAwarded,
        transactionId: txn?.id ?? generateId(),
        idempotencyKey,
        eligibilitySnapshot: {},
      })
      .returning();

    // Update code counter
    await tx
      .update(creditVoucherCodes)
      .set({ redeemedCount: sql`${creditVoucherCodes.redeemedCount} + 1` })
      .where(eq(creditVoucherCodes.id, codeRow.id));

    // Mark code as redeemed if single-use
    if (codeRow.maxRedemptions <= 1) {
      await tx
        .update(creditVoucherCodes)
        .set({ status: "redeemed" })
        .where(eq(creditVoucherCodes.id, codeRow.id));
    }

    return {
      redemptionId: redemption.id,
      transactionId: redemption.transactionId,
      creditsGranted: creditsAwarded,
      newBalance,
      campaignDisplayName: campaign.displayName,
      redeemedAt: redemption.redeemedAt.toISOString(),
    };
  });
}
