import { describe, expect, it } from "bun:test";
import {
  validateTaxId,
  resolveWithholdingRate,
  isValidCountryCode,
  saveCreatorTaxProfile,
  US_TAX_TREATY_RATES,
} from "../src/services/tax.js";

describe("Creator Global Tax Onboarding Engine", () => {
  describe("validateTaxId", () => {
    it("validates Indonesian NPWP format (15 or 16 digits)", () => {
      // 15 digits
      const res15 = validateTaxId("npwp", "12.345.678.9-012.000");
      expect(res15.isValid).toBe(true);
      expect(res15.cleanId).toBe("123456789012000");

      // 16 digits (NIK format)
      const res16 = validateTaxId("npwp", "3171012345678901");
      expect(res16.isValid).toBe(true);
      expect(res16.cleanId).toBe("3171012345678901");

      // Invalid length
      const resShort = validateTaxId("npwp", "12345");
      expect(resShort.isValid).toBe(false);
      expect(resShort.error).toBeDefined();
    });

    it("validates US W-9 SSN / EIN format (9 digits)", () => {
      const resSsn = validateTaxId("w9", "123-45-6789");
      expect(resSsn.isValid).toBe(true);
      expect(resSsn.cleanId).toBe("123456789");

      const resEin = validateTaxId("w9", "12-3456789");
      expect(resEin.isValid).toBe(true);
      expect(resEin.cleanId).toBe("123456789");

      const resInvalid = validateTaxId("w9", "12345678");
      expect(resInvalid.isValid).toBe(false);
    });

    it("validates global W-8BEN foreign TIN format (6-20 characters)", () => {
      const resValid = validateTaxId("w8ben", "AB123456C");
      expect(resValid.isValid).toBe(true);
      expect(resValid.cleanId).toBe("AB123456C");

      const resTooShort = validateTaxId("w8ben", "123");
      expect(resTooShort.isValid).toBe(false);
    });
  });

  describe("resolveWithholdingRate", () => {
    it("returns 0% withholding for domestic Indonesian NPWP", () => {
      const res = resolveWithholdingRate({ formType: "npwp", taxCountry: "ID" });
      expect(res.rate).toBe(0.00);
      expect(res.article).toBeNull();
    });

    it("returns 0% withholding for US W-9 persons", () => {
      const res = resolveWithholdingRate({ formType: "w9", taxCountry: "US" });
      expect(res.rate).toBe(0.00);
      expect(res.article).toBeNull();
    });

    it("returns 30% statutory withholding for W-8BEN without treaty election", () => {
      const res = resolveWithholdingRate({
        formType: "w8ben",
        taxCountry: "ID",
        treatyBenefitClaimed: false,
      });
      expect(res.rate).toBe(0.30);
      expect(res.article).toBeNull();
    });

    it("returns reduced 10% withholding for Indonesia with US tax treaty election", () => {
      const res = resolveWithholdingRate({
        formType: "w8ben",
        taxCountry: "ID",
        treatyBenefitClaimed: true,
        treatyCountry: "ID",
      });
      expect(res.rate).toBe(0.10);
      expect(res.article).toBe("Article 13 (Royalties)");
    });

    it("returns reduced 0% withholding for United Kingdom with US tax treaty election", () => {
      const res = resolveWithholdingRate({
        formType: "w8ben",
        taxCountry: "GB",
        treatyBenefitClaimed: true,
        treatyCountry: "GB",
      });
      expect(res.rate).toBe(0.00);
      expect(res.article).toBe("Article 12 (Royalties)");
    });

    it("returns reduced 5% withholding for Australia with US tax treaty election", () => {
      const res = resolveWithholdingRate({
        formType: "w8ben",
        taxCountry: "AU",
        treatyBenefitClaimed: true,
        treatyCountry: "AU",
      });
      expect(res.rate).toBe(0.05);
      expect(res.article).toBe("Article 12 (Royalties)");
    });
  });

  describe("isValidCountryCode", () => {
    it("validates valid ISO 3166-1 alpha-2 country codes", () => {
      expect(isValidCountryCode("ID")).toBe(true);
      expect(isValidCountryCode("US")).toBe(true);
      expect(isValidCountryCode("gb")).toBe(true);
      expect(isValidCountryCode("AU")).toBe(true);
      expect(isValidCountryCode("jp")).toBe(true);
    });

    it("rejects invalid country codes", () => {
      expect(isValidCountryCode("")).toBe(false);
      expect(isValidCountryCode("USA")).toBe(false);
      expect(isValidCountryCode("INDONESIA")).toBe(false);
      expect(isValidCountryCode("12")).toBe(false);
      expect(isValidCountryCode("U$")).toBe(false);
      expect(isValidCountryCode(null)).toBe(false);
      expect(isValidCountryCode(undefined)).toBe(false);
      expect(isValidCountryCode(123)).toBe(false);
    });
  });

  describe("saveCreatorTaxProfile input validations", () => {
    it("rejects invalid country code format", async () => {
      expect(
        saveCreatorTaxProfile("creator_1", {
          formType: "npwp",
          taxCountry: "INVALID",
          taxId: "123456789012345",
          legalName: "Test Author",
        })
      ).rejects.toThrow("Valid ISO 3166-1 alpha-2 country code is required");
    });

    it("enforces NPWP must be from Indonesia (ID)", async () => {
      expect(
        saveCreatorTaxProfile("creator_1", {
          formType: "npwp",
          taxCountry: "US",
          taxId: "123456789012345",
          legalName: "Test Author",
        })
      ).rejects.toThrow("Indonesian NPWP is only applicable for Indonesian tax residence (ID)");
    });

    it("enforces W-9 must be US person (US)", async () => {
      expect(
        saveCreatorTaxProfile("creator_1", {
          formType: "w9",
          taxCountry: "ID",
          taxId: "123456789",
          legalName: "Test Author",
        })
      ).rejects.toThrow("Form W-9 is only applicable for US tax persons (US)");
    });

    it("enforces W-8BEN cannot be US person", async () => {
      expect(
        saveCreatorTaxProfile("creator_1", {
          formType: "w8ben",
          taxCountry: "US",
          taxId: "AB123456C",
          legalName: "Test Author",
        })
      ).rejects.toThrow("US tax residents cannot file Form W-8BEN");
    });

    it("rejects invalid treaty country code when treaty benefit is claimed", async () => {
      expect(
        saveCreatorTaxProfile("creator_1", {
          formType: "w8ben",
          taxCountry: "GB",
          taxId: "AB123456C",
          legalName: "Test Author",
          treatyBenefitClaimed: true,
          treatyCountry: "UNITED_KINGDOM",
        })
      ).rejects.toThrow("Valid ISO 3166-1 alpha-2 country code is required for treaty country");
    });
  });
});

