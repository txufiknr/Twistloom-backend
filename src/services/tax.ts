/**
 * Creator Global Tax Onboarding Service
 *
 * Implements tax identification, treaty rate resolution, and certification
 * storage for global creators across W-8BEN (International), W-9 (US), and
 * NPWP (Indonesia).
 *
 * Sensitive Tax IDs (SSN / EIN / NPWP / FTIN) are encrypted with Web Crypto
 * AES-256-GCM and blind indexed with HMAC-SHA256.
 *
 * @see docs/architecture/CREATOR_WALLET_ARCHITECTURE.md
 * @see docs/roadmap/CREATOR_GLOBAL_TAX_ONBOARDING_ROADMAP.md
 */

import { eq, and, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../db/client.js";
import { creatorTaxProfiles } from "../db/schema.js";
import { encryptPII, generateBlindIndex, extractLast4 } from "../utils/crypto.js";
import type { CreatorTaxProfile, SaveTaxProfileRequest, SaveTaxProfileResponse, TaxFormType, TaxProfileStatus } from "../types/wallet.js";

/**
 * Standard US tax treaty reduced royalty withholding rates by country code (ISO 3166-1 alpha-2)
 */
export const US_TAX_TREATY_RATES: Record<string, { rate: number; article: string }> = {
  ID: { rate: 0.10, article: "Article 13 (Royalties)" },
  GB: { rate: 0.00, article: "Article 12 (Royalties)" },
  CA: { rate: 0.00, article: "Article XII (Royalties)" },
  DE: { rate: 0.00, article: "Article 12 (Royalties)" },
  FR: { rate: 0.00, article: "Article 12 (Royalties)" },
  JP: { rate: 0.00, article: "Article 12 (Royalties)" },
  AU: { rate: 0.05, article: "Article 12 (Royalties)" },
  SG: { rate: 0.10, article: "Tax Treaty Provisions" },
  NL: { rate: 0.00, article: "Article 13 (Royalties)" },
  SE: { rate: 0.00, article: "Article 12 (Royalties)" },
  CH: { rate: 0.00, article: "Article 12 (Royalties)" },
};

/**
 * Resolves the applicable tax withholding rate based on tax form type,
 * country of tax residency, and tax treaty election.
 */
export function resolveWithholdingRate(params: {
  formType: TaxFormType;
  taxCountry: string;
  treatyBenefitClaimed?: boolean;
  treatyCountry?: string;
}): { rate: number; article: string | null } {
  // US Persons/Entities under W-9: 0% upfront withholding (reported on Form 1099)
  if (params.formType === "w9") {
    return { rate: 0.00, article: null };
  }

  // Indonesian domestic creators under NPWP: 0% upfront withholding (reported via SPT)
  if (params.formType === "npwp") {
    return { rate: 0.00, article: null };
  }

  // International creators under W-8BEN
  if (params.formType === "w8ben") {
    if (params.treatyBenefitClaimed) {
      const country = (params.treatyCountry || params.taxCountry).toUpperCase();
      const treaty = US_TAX_TREATY_RATES[country];
      if (treaty) {
        return { rate: treaty.rate, article: treaty.article };
      }
      // Default fallback treaty rate for recognized bilateral partner
      return { rate: 0.10, article: "Bilateral Tax Treaty" };
    }

    // Standard statutory foreign rate for US-sourced royalties without treaty
    return { rate: 0.30, article: null };
  }

  return { rate: 0.00, article: null };
}

/**
 * Validates whether a country code conforms to ISO 3166-1 alpha-2 (2 uppercase ASCII letters).
 */
export function isValidCountryCode(code: unknown): code is string {
  return typeof code === "string" && /^[A-Z]{2}$/.test(code.trim().toUpperCase());
}

/**
 * Validates tax ID format based on form type.
 */
export function validateTaxId(formType: TaxFormType, rawTaxId: string): { isValid: boolean; cleanId: string; error?: string } {
  const cleanId = rawTaxId.replace(/[\s.-]/g, "").trim();

  if (!cleanId) {
    return { isValid: false, cleanId: "", error: "Tax ID is required" };
  }

  if (formType === "npwp") {
    // Indonesian NPWP / NIK: 15 or 16 digits
    if (!/^\d{15,16}$/.test(cleanId)) {
      return { isValid: false, cleanId, error: "NPWP must be 15 or 16 digits" };
    }
    return { isValid: true, cleanId };
  }

  if (formType === "w9") {
    // US SSN or EIN: 9 digits
    if (!/^\d{9}$/.test(cleanId)) {
      return { isValid: false, cleanId, error: "US SSN / EIN must be exactly 9 digits" };
    }
    return { isValid: true, cleanId };
  }

  if (formType === "w8ben") {
    // Foreign Tax Identification Number: 6 to 20 alphanumeric characters
    if (cleanId.length < 6 || cleanId.length > 20) {
      return { isValid: false, cleanId, error: "Foreign Tax ID must be between 6 and 20 characters" };
    }
    return { isValid: true, cleanId };
  }

  return { isValid: true, cleanId };
}

/**
 * Retrieves a creator's sanitized tax profile.
 */
export async function getCreatorTaxProfile(creatorId: string): Promise<CreatorTaxProfile | null> {
  const [profile] = await dbRead
    .select()
    .from(creatorTaxProfiles)
    .where(eq(creatorTaxProfiles.creatorId, creatorId))
    .limit(1);

  if (!profile) return null;

  return {
    id: profile.id,
    creatorId: profile.creatorId,
    formType: profile.formType,
    taxCountry: profile.taxCountry,
    taxIdLast4: profile.taxIdLast4,
    legalName: profile.legalName,
    signatureName: profile.signatureName,
    signerIpAddress: profile.signerIpAddress,
    treatyBenefitClaimed: profile.treatyBenefitClaimed,
    treatyCountry: profile.treatyCountry,
    treatyArticle: profile.treatyArticle,
    withholdingRate: profile.withholdingRate,
    certifiedAt: profile.certifiedAt,
    expiresAt: profile.expiresAt,
    status: profile.status,
    failureReason: profile.failureReason,
    createdAt: profile.createdAt,
  };
}

/**
 * Saves and certifies a creator's tax profile.
 * Encrypts sensitive Tax ID and calculates tax treaty withholding rate.
 * Supports updating an existing profile without re-submitting the full Tax ID.
 * Enforces blind index Sybil checks to prevent duplicate registrations.
 */
export async function saveCreatorTaxProfile(
  creatorId: string,
  request: SaveTaxProfileRequest
): Promise<SaveTaxProfileResponse> {
  const { formType, taxCountry, taxId, legalName, signatureName, signerIpAddress, treatyBenefitClaimed, treatyCountry } = request;

  // 1. Validate inputs
  if (!legalName || legalName.trim().length < 2) {
    throw new Error("Full legal name is required for tax certification");
  }

  if (!taxCountry || !isValidCountryCode(taxCountry)) {
    throw new Error("Valid ISO 3166-1 alpha-2 country code is required for tax country");
  }

  const normalizedTaxCountry = taxCountry.trim().toUpperCase();

  // Validate form-to-country jurisdictional compatibility
  if (formType === "npwp" && normalizedTaxCountry !== "ID") {
    throw new Error("Indonesian NPWP is only applicable for Indonesian tax residence (ID)");
  }

  if (formType === "w9" && normalizedTaxCountry !== "US") {
    throw new Error("Form W-9 is only applicable for US tax persons (US)");
  }

  if (formType === "w8ben" && normalizedTaxCountry === "US") {
    throw new Error("US tax residents cannot file Form W-8BEN (Form W-9 required)");
  }

  let normalizedTreatyCountry: string | null = null;
  if (treatyBenefitClaimed && treatyCountry) {
    if (!isValidCountryCode(treatyCountry)) {
      throw new Error("Valid ISO 3166-1 alpha-2 country code is required for treaty country");
    }
    normalizedTreatyCountry = treatyCountry.trim().toUpperCase();
  }

  // 2. Query existing profile if any
  const [existingProfile] = await dbRead
    .select()
    .from(creatorTaxProfiles)
    .where(eq(creatorTaxProfiles.creatorId, creatorId))
    .limit(1);

  let taxIdEncrypted = existingProfile?.taxIdEncrypted || null;
  let taxIdLast4 = existingProfile?.taxIdLast4 || null;
  let taxIdBlindIndex = existingProfile?.taxIdBlindIndex || null;

  if (taxId && taxId.trim()) {
    const { isValid, cleanId, error } = validateTaxId(formType, taxId);
    if (!isValid) {
      throw new Error(error || "Invalid tax identification number");
    }

    const [encrypted, blindIdx] = await Promise.all([
      encryptPII(cleanId),
      generateBlindIndex(cleanId),
    ]);

    taxIdEncrypted = encrypted;
    taxIdBlindIndex = blindIdx;
    taxIdLast4 = extractLast4(cleanId);
  } else if (!existingProfile || !existingProfile.taxIdEncrypted) {
    throw new Error("Tax identification number is required");
  }

  // 3. Sybil / Duplicate detection via blind index
  if (taxIdBlindIndex) {
    const [duplicate] = await dbRead
      .select({ id: creatorTaxProfiles.id, creatorId: creatorTaxProfiles.creatorId })
      .from(creatorTaxProfiles)
      .where(
        and(
          eq(creatorTaxProfiles.taxIdBlindIndex, taxIdBlindIndex),
          sql`${creatorTaxProfiles.creatorId} != ${creatorId}`
        )
      )
      .limit(1);

    if (duplicate) {
      throw new Error("TAX_ID_ALREADY_REGISTERED_BY_ANOTHER_CREATOR");
    }
  }

  // 4. Resolve withholding rate
  const { rate: withholdingRate, article: treatyArticle } = resolveWithholdingRate({
    formType,
    taxCountry: normalizedTaxCountry,
    treatyBenefitClaimed,
    treatyCountry: normalizedTreatyCountry || undefined,
  });

  // 5. Compute expiration date (W-8BEN valid until Dec 31 of 3rd year following signature; W-9/NPWP indefinite)
  let expiresAt: Date | null = null;
  if (formType === "w8ben") {
    const now = new Date();
    const expirationYear = now.getUTCFullYear() + 3;
    expiresAt = new Date(Date.UTC(expirationYear, 11, 31, 23, 59, 59, 999));
  }

  const effectiveSignature = signatureName?.trim() || legalName.trim();
  const effectiveSignerIp = signerIpAddress?.trim() || null;

  // 6. Upsert tax profile record
  const [saved] = await dbWrite
    .insert(creatorTaxProfiles)
    .values({
      creatorId,
      formType,
      taxCountry: normalizedTaxCountry,
      taxIdEncrypted,
      taxIdLast4,
      taxIdBlindIndex,
      legalName: legalName.trim(),
      signatureName: effectiveSignature,
      signerIpAddress: effectiveSignerIp,
      treatyBenefitClaimed: Boolean(treatyBenefitClaimed),
      treatyCountry: normalizedTreatyCountry,
      treatyArticle,
      withholdingRate,
      certifiedAt: new Date(),
      expiresAt,
      status: "verified" as TaxProfileStatus,
    })
    .onConflictDoUpdate({
      target: creatorTaxProfiles.creatorId,
      set: {
        formType,
        taxCountry: normalizedTaxCountry,
        taxIdEncrypted,
        taxIdLast4,
        taxIdBlindIndex,
        legalName: legalName.trim(),
        signatureName: effectiveSignature,
        signerIpAddress: effectiveSignerIp,
        treatyBenefitClaimed: Boolean(treatyBenefitClaimed),
        treatyCountry: normalizedTreatyCountry,
        treatyArticle,
        withholdingRate,
        certifiedAt: new Date(),
        expiresAt,
        status: "verified" as TaxProfileStatus,
        failureReason: null,
        updatedAt: new Date(),
      },
    })
    .returning();

  return {
    success: true,
    taxProfileId: saved.id,
    withholdingRate: saved.withholdingRate,
    status: saved.status,
    message: "Tax profile verified and certified successfully",
  };
}
