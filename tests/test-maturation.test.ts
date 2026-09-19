import { describe, expect, it } from "bun:test";
import { THANKS_CONFIG, calculatePlatformFee, calculateCreatorAmount } from "../src/config/thanks.js";
import { payoutEventActorTypes, payoutMethodTypes, kycVerificationStatuses } from "../src/types/wallet.js";

describe("Settlement Hold & Maturation Engine", () => {
  it("enforces 14-day risk settlement hold constant in THANKS_CONFIG", () => {
    expect(THANKS_CONFIG.maturationHoldDays).toBe(14);
    expect(THANKS_CONFIG.platformFeePercent).toBe(5);
  });

  it("calculates platform fees and creator net amounts consistently", () => {
    // USD $10.00 (1000 cents) -> 5% fee = 50 cents, creator gets 950 cents
    expect(calculatePlatformFee(1000)).toBe(50);
    expect(calculateCreatorAmount(1000)).toBe(950);

    // IDR Rp 100.000 -> 5% fee = Rp 5.000, creator gets Rp 95.000
    expect(calculatePlatformFee(100_000)).toBe(5_000);
    expect(calculateCreatorAmount(100_000)).toBe(95_000);
  });

  it("exports valid payout event actor types", () => {
    expect(payoutEventActorTypes).toContain("system");
    expect(payoutEventActorTypes).toContain("admin");
    expect(payoutEventActorTypes).toContain("webhook");
    expect(payoutEventActorTypes).toContain("creator");
  });

  it("exports valid payout method types", () => {
    expect(payoutMethodTypes).toContain("bank_transfer");
    expect(payoutMethodTypes).toContain("e_wallet");
    expect(payoutMethodTypes).toContain("stripe_connect");
  });

  it("exports valid kyc verification statuses", () => {
    expect(kycVerificationStatuses).toContain("pending");
    expect(kycVerificationStatuses).toContain("verified");
    expect(kycVerificationStatuses).toContain("rejected");
    expect(kycVerificationStatuses).toContain("requires_manual_review");
  });
});
