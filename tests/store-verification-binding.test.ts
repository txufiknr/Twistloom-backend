/**
 * Store account binding on the grant path (audit F2, binding half).
 *
 * Row ownership (`foreignOwnershipDenial`) only protects a `subscriptions`
 * row that already exists — the *first* claimant of a leaked purchase token
 * would still become the owner. Play's own answer closes that hole: it echoes
 * `externalAccountIdentifiers.obfuscatedExternalAccountId`, which our client
 * sets to the presenting user id when it starts the purchase, so
 * `storeAccountBindingMatches` can refuse the proof before any read or write.
 *
 * These cases are deliberately pure/no-DB: the binding gate runs before the
 * first query, so a mismatch is asserted end-to-end (`grantVipFromStore`
 * answers `store_account_binding_mismatch`) without a database, while the
 * absent-binding policy is pinned as a unit.
 */

import { describe, expect, it } from "bun:test";

const { grantVipFromStore, storeAccountBindingMatches } = await import("../src/services/store-verification/grant.js");

const USER_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_USER_ID = "22222222-2222-2222-2222-222222222222";

function playReceipt(metadata: Record<string, string | number | boolean> = {}) {
  return {
    platform: "google_play",
    kind: "subscription",
    productId: "vip_monthly",
    purchaseKey: "tok_binding",
    orderId: "GPA.5555-6666-7777-88888",
    entitlementStart: new Date(Date.now() - 86_400_000),
    entitlementEnd: new Date(Date.now() + 25 * 86_400_000),
    autoRenewing: true,
    entitled: true,
    state: "ACTIVE",
    environment: "PRODUCTION",
    metadata: { autoRenewing: true, ...metadata },
  } as any;
}

describe("store account binding (Play obfuscated account id)", () => {
  it("refuses a purchase the store bound to another account", async () => {
    const outcome = await grantVipFromStore(USER_ID, playReceipt({ obfuscatedAccountId: OTHER_USER_ID }));
    expect(outcome).toEqual({ status: "denied", reason: "store_account_binding_mismatch" });
  });

  it("refuses before the lapsed-period cleanup can run for a foreign proof", async () => {
    const outcome = await grantVipFromStore(
      USER_ID,
      // Not entitled anymore: the binding gate must still answer first, so a
      // foreign caller cannot trigger `cancelSubscription` on someone's row.
      playReceipt({ obfuscatedAccountId: OTHER_USER_ID, entitled: false, state: "EXPIRED" }),
    );
    expect(outcome).toEqual({ status: "denied", reason: "store_account_binding_mismatch" });
  });

  it("accepts the account the store bound the purchase to", () => {
    expect(storeAccountBindingMatches(USER_ID, playReceipt({ obfuscatedAccountId: USER_ID }))).toBe(true);
  });

  it("falls through to the row-ownership gates when the store reports no binding", () => {
    // Apple returns none, and Play may omit it — absent must not mean "deny",
    // or every App Store purchase would stop working.
    expect(storeAccountBindingMatches(USER_ID, playReceipt())).toBe(true);
    expect(storeAccountBindingMatches(USER_ID, playReceipt({ obfuscatedAccountId: "" }))).toBe(true);
  });
});
