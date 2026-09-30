# Owner & Client Gates Register (`OG-n`)

**Status:** Living registry. `OG-1` … `OG-5` are stable ids; a gate is *cleared* only when its "Cleared by" condition is true in production, never because code landed.

---

## Why this file exists

Store verification and store push notifications are blocked on prerequisites that **no backend code change can satisfy** — a person must publish something (product ids, credentials, notification endpoints) or a second repository must change (the Flutter client). Each such prerequisite gets a stable `OG-n` id so a code comment, a test name, a roadmap row and a review finding can all name the same blocker without re-describing it.

This file is the SSOT for what each id means. Referenced from:

- [`PAYMENTS_ARCHITECTURE_BACKEND.md`](../architecture/PAYMENTS_ARCHITECTURE_BACKEND.md) §19 (store purchase verification)
- [`PAYMENTS_API_DOCUMENTATION.md`](../api/PAYMENTS_API_DOCUMENTATION.md) (endpoint-level `503` / `400` notes)
- [`src/config/store-verification.ts`](../../src/config/store-verification.ts) (`@see … OG-2`)
- [`src/config/credits.ts`](../../src/config/credits.ts) / [`src/types/credits.ts`](../../src/types/credits.ts) (`storeProductId`)

---

## Register

| Id | Gate | Held by | Blocks until cleared |
|---|---|---|---|
| **OG-1** | Store product ids published | Owner | `resolveStoreProduct` answers `400 unknown_product` — no VIP or credit-pack proof can resolve |
| **OG-2** | Store credentials | Owner | `storeVerificationReady()` is `false` → `503 store_verification_unavailable` on both verify endpoints |
| **OG-3** | *(unassigned)* | — | Not referenced anywhere in this repository; reserve before use |
| **OG-4** | Store push notifications | Owner | Entitlement refresh is client-poll only (no RTDN / App Store Server Notifications) |
| **OG-5** | Purchase finalization — Play server-side, Apple client-side | Server + client (Flutter repo) | Credit pack stays un-consumed (never re-buyable) or unacknowledged (auto-refunded in 3 days); App Store finish never sent |

---

## OG-1 — Store product ids published

`CREDIT_PACKS[].storeProductId` is `null` for all three packs and the VIP product must be published under exactly `vip_monthly` to match `VIP_SUBSCRIPTION.id`.

**Cleared by:** every pack has a real Play/App Store product id filled into `src/config/credits.ts`, and `vip_monthly` exists in the store catalogue. After that, any unknown id is a genuine `400 unknown_product` instead of a configuration gap.

## OG-2 — Store credentials

`GOOGLE_PLAY_ENABLED` + `GOOGLE_PLAY_PACKAGE_NAME` + `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON[_PATH]`, or `APP_STORE_ENABLED` + `APP_STORE_BUNDLE_ID` + `APP_STORE_ISSUER_ID` + `APP_STORE_KEY_ID` + `APP_STORE_PRIVATE_KEY[_PATH]`. Cleared per platform — Play can be open while Apple is still gated.

**Cleared by:** publishing the credentials and setting the matching `*_ENABLED=true`. `storeVerificationReady(platform)` then returns `true`. Credentials are server-side only and must never reach the client, source or logs.

**Mis-ordering is safe by design:** `*_ENABLED=true` before the keys arrive degrades to `503 store_verification_unavailable` — never to a crash, never to a denial, never to a grant.

## OG-4 — Store push notifications

Google Real-time Developer Notifications / App Store Server Notifications. Until they exist, `entitled` refreshes only when the client verifies (resume, pull-to-refresh, foreground pass) — correct but reactive, so a revocation is noticed on the next verify instead of pushed.

## OG-5 — Purchase finalization (the terminal store write)

**Applies to:** both verify endpoints. The **Play half ships server-side**; the **Apple half remains a client obligation**.

A purchase is not finished when the grant commits — it is finished when the *store* is told. Play auto-refunds an unacknowledged purchase after three days, and a Play consumable stays `PURCHASED` (and therefore un-rebuyable) until it is consumed. The invariant that governs both facts:

```
verify    read    purchases.subscriptionsv2.get / purchases.products.get
grant     commit  Postgres transaction, idempotent on (gateway, provider id)
finalize  write   :acknowledge (subscription) | :consume (credit pack)
```

`finalize` runs **only after** the grant committed, and **never** when the grant was refused. Acknowledging first would destroy Play's auto-refund safety net for money this server may never have delivered. Implemented by `finalizeStorePurchase` in [`src/services/store-verification/index.ts`](../../src/services/store-verification/index.ts), called from both routes in [`src/routes/payments.ts`](../../src/routes/payments.ts).

| Product kind | Play write | Why |
|---|---|---|
| Subscription (`vip_monthly`) | `:acknowledge` | Stops the auto-refund of an entitlement we just granted. Consuming a subscription is not a valid Play operation. |
| Credit pack | `:consume` | The only write that makes the pack re-buyable. Deliberately **not** followed by an `:acknowledge` fallback — acknowledging without consuming turns a retryable failure into a permanent one. |
| App Store (either kind) | *none from the server* | StoreKit 1 finish is device-only and the App Store Server API exposes no finish endpoint. Symmetric invariant, deliberately asymmetric mechanism. |

**Retry is replay.** A failed finalize logs and returns `false`, and never fails the HTTP response — the grant is already committed, so a 5xx would lie to a customer who was served. Re-POSTing the verify re-runs finalize because the grant is idempotent: no new endpoint, no new state.

**Status:** the Play server half is implemented and covered by `tests/store-verification-parsers.test.ts` and `tests/store-verification.test.ts`. The endpoint still has no production caller (`kStoreCreditGrantConfigured` stays `false`), so nothing here is live yet.

**Cleared by:**

1. The Play questions above that Google does not document are answered in one sandbox pass (before OG-1/OG-2 go live).
2. The client owns its half: App Store `finishTransaction`, and its own consume demoted to a safety net rather than the mechanism.
3. Both Flutter follow-ups below are closed.

### Play semantics — resolved from Google's reference

Both of these were listed as open questions; the published reference settles them, so neither blocks OG-1/OG-2.

1. **Does `:consume` require the purchase to be unacknowledged?** No. Google models consumption as the *one-time-product form of* acknowledgement: the Billing Library reference says "for one-time products ensure you are using `consumeAsync`, **which acts as an implicit acknowledgement**", and states `consumeAsync`'s precondition as "consuming can only be done on an item that's **owned**" — ownership, not acknowledgement state. Consume-only for credit packs therefore matches Google's documented intent; no `:acknowledge`-then-`:consume` sequencing is expected, which is why none is implemented.
2. **Does `purchases.products.get` still resolve a consumed token?** Yes, by construction. `get`'s method summary is "Checks the purchase **and consumption status** of an inapp item", and `ProductPurchase.consumptionState = 1 (Consumed)` is a documented value of the very response in question — a consumed token that stopped resolving would make the field unreachable.

### Play semantics — needs one sandbox run

Not documented anywhere in Google's public reference: both `:consume` and `:acknowledge` pages list path parameters and no preconditions, so the REST surface is silent. A single purchased sandbox item settles both — the same run OG-1/OG-2 already requires.

1. **Does REST `:consume` accept a purchase the *client* already acknowledged?** The server never acknowledges a pack, but the client's own `completePurchase → acknowledgePurchase → consumePurchase` sequence does, and its consumption would then have to happen server-side. Google's model above says it should work; only a real call confirms the REST surface behaves like the client library.
2. **Does `purchaseState` stay `0 (Purchased)` after a consume?** If Play reclassifies the order, a replayed verify answers `denied` for a pack that *was* granted — correct in the ledger, wrong on screen.

### Open follow-ups (Flutter repo)

- **(a) Consume retry is lost once acknowledged.** The `pendingCompletePurchase` filter drops a purchase from the retry set as soon as `acknowledgePurchase` succeeds, so if `consumeAsync` then fails there is no retry on the next launch and the pack stays unconsumed. Lower severity now that the server consumes Play packs, but the Apple half still depends on this path.
- **(b) Consume runs unconditionally.** `completeConfirmedPurchase` calls `consumePurchase` even for subscriptions (VIP), where only acknowledgement is correct. Must be scoped to the product kind.

Both are filed in [`TODO.md`](../../TODO.md).

---

## Rules for adding a gate

1. **Stable id.** Never renumber or reuse a released `OG-n`; retired gates are marked retired, not deleted.
2. **Holder must be explicit.** Owner gates are satisfied by publishing configuration; client gates are satisfied by code in another repository.
3. **A gate is a precondition, not a check.** If the backend can enforce it at runtime, it belongs in the route, not here.
4. **Reference it where it bites.** Every `503`/`400` that exists purely because of a gate should name the id (see `store_verification_unavailable` → OG-2).

---

*Last updated: September 2026 (register created — it was referenced by `PAYMENTS_ARCHITECTURE_BACKEND.md` §19 and `src/config/store-verification.ts` but did not exist; OG-5 added for the Play/App Store consumable consume contract, including the two open Flutter follow-ups. Google's reference subsequently resolved two of the original Play sandbox questions — consume is documented as the one-time-product form of acknowledgement, and `get` exists to report consumption status — leaving two to confirm in one sandbox pass.)*
