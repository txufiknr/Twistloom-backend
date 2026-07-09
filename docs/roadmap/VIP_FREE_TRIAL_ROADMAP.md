# VIP Free Trial (1-Month) — Implementation Roadmap

**Status:** ✅ Fully implemented (Backend & Frontend complete), including Q1–Q6 design decisions (see CHANGELOG below)
**Depends on:** The Stripe payment audit fixes (idempotency, `subscriptions.userId` FK, VIP expiration cron scheduling) — these were landed prior to this implementation.
**Model:** LinkedIn-style — card required upfront, full VIP benefits during trial, auto-converts to paid unless canceled.

---

## Implementation CHANGELOG

### Implemented (Jul 2026, round 2) — Q1–Q6 decisions + two bug fixes

Design rationale for all six open questions is now documented in §9.2 as resolved decisions, not open questions. Summary of what changed in code:

- **Q1, Q2, Q3 — no code changes.** All three were reviewed against the current implementation and the recommendation was to keep behavior as-is; see §9.2 for the reasoning specific to why Twistloom's trial economics don't actually need LinkedIn's stricter versions of these.
- **Q4 — implemented.** `cancelSubscription()` in `subscription.services.ts` now records a `trial_expired` transaction (new `subscriptionTransactions.type` value, new `metadata` jsonb column on that table) snapshotting the user's credit balance when a trial ends without converting. No clawback — this is purely an analytics capture so the "is this a real cost problem" question can be answered with data later instead of a guess. **Schema change:** `subscriptionTransactions.metadata` (jsonb, nullable) added.
- **Q5 — implemented.** `handleTrialWillEnd()` now also sends a branded reminder email via Resend, non-blocking (a send failure can't break the in-app notification or fail the webhook). The actual `sendTrialEndingEmail()` function is delivered separately as `email.trial-ending-addition.ts` since your real `src/utils/email.ts` wasn't available to edit directly — merge it in following your existing `sendWelcomeEmail`/`sendPasswordResetEmail` conventions (sender identity, shared template/layout if you have one).
- **Q6 — implemented.** New env vars documented in `env.trial-addition.example`, to merge into your real `.env.example`.
- **Bug fix (pre-existing, not introduced by trial work):** `GET /payments/subscription` joined `subscriptions` to `users` on a bare `userId` match with `.limit(1)` and no ordering — for any user with more than one `subscriptions` row over their lifetime (cancel-then-resubscribe, a lapsed trial followed by a real signup), this had no guarantee of returning the *current* row. Fixed to join on `users.subscriptionId`, the canonical current-subscription pointer `createSubscription()`/`downgradeUserFromVip()` already maintain.
- **Hardening:** Same "which row" pattern in `GET /payments/subscription/portal`'s customer lookup — lower risk (recall `stripeCustomerId` should be stable across a user's history) but given an `orderBy(desc(createdAt))` for defense-in-depth anyway.

### Implemented (Jul 2026, round 1)

- **Schema:** `vipTrialUsedAt` (users), `isTrial` + `trialEnd` (subscriptions) — already present before this work
- **Types:** `'trial_started'` transaction type, `'trialing'` / `'paused'` statuses — already present before this work
- **Config:** `VIP_TRIAL` config block with `enabled`, `trialPeriodDays`, `endBehavior` (see `src/config/subscription.ts:36`)
- **Service layer:**
  - `isTrialEligible(userId)` — one-trial-per-user, no active sub check
  - `handleTrialWillEnd(stripeSubscriptionId)` — creates `trial_ending_soon` notification (now also sends email, round 2)
  - `createSubscription()` already branches on `isTrial` — no changes needed
  - `updateSubscription()` already clears `isTrial` when status leaves `trialing` — no changes needed
- **Routes:**
  - `GET /payments/subscription/trial-eligibility` — new endpoint
  - `POST /payments/create-trial-checkout-session` — new endpoint with server-side eligibility re-check
  - `GET /payments/subscription` — now includes `isTrial`/`trialEnd` in response, accepts `trialing` status (query fixed round 2)
  - `POST /payments/subscription/cancel` — accepts `trialing` status via `inArray`
- **Webhooks:**
  - `customer.subscription.trial_will_end` — new handler creates in-app notification (now also sends email, round 2)
  - Wired into webhook event switch

### Implemented (Jul 2026, round 3 — frontend, `twistloom-web` repo)

- **Types:** `UserSubscription.isTrial` + `UserSubscription.trialEnd`, `TrialEligibilityResponse`, `CreateTrialSessionRequest`, `CreateTrialSessionResponse` (see `src/lib/types/api/subscription.ts`)
- **API service:** `getTrialEligibility()` + `createTrialSession()` on `SubscriptionApi` (see `src/lib/services/subscription-api.ts:93-110`)
- **Hook:** `useTrialEligibility()` — TanStack Query with auth guard, no retry, 2-min stale time (see `src/lib/hooks/query/useTrialEligibility.ts`)
- **Actions:** `handleStartTrial` on `useVipActions` — creates trial checkout session and redirects (see `src/components/vip/useVipActions.ts:115-128`)
- **Subscription management:** `SubscriptionManagement` trial-aware status display with blue-themed banner, days-remaining countdown, distinct cancel copy for trials (see `src/components/subscription/SubscriptionManagement.tsx`)
- **Trial CTA:** `VipUpgradeModal` + `DashboardAccountSubscriptionClient` — trial eligibility banner (`Rocket` icon), "Start 1-Month Free Trial" primary CTA when eligible, trial-specific status labels (see `src/components/modals/vip/VipUpgradeModal.tsx`, `src/components/dashboard/DashboardAccountSubscriptionClient.tsx`)
- **Post-checkout:** `SubscriptionStatusMessage` — `successTrial.title`/`successTrial.description` locale keys when returning from trial checkout (see `src/components/subscription/SubscriptionStatusMessage.tsx:116-118`)
- **Localization:** Full `en.json` and `id.json` coverage — all trial keys present in both locales (successTrial, trialEligibleTitle/Notice, trialCta, trialActiveLabel, trialEnds, cancelTrialButton, trialWillCancel)

---

## 1. Why this shape

LinkedIn's trial works because friction is front-loaded (card required) and value is front-loaded too (full features immediately). That combination is what drives conversion — a card-optional trial gets more signups but converts far worse, and mostly attracts people who never intended to pay. Stripe's Checkout defaults already match this model: `payment_method_collection` defaults to `always` for subscription-mode sessions, so a card-required trial is actually *less* configuration than a card-optional one.

Recommended shape:
- Card required at signup (Stripe default — no special config needed)
- Full VIP benefits (badge, 2x check-in, monthly credits) unlocked immediately
- 30 days via `trial_period_days`, not a calendar-month toggle — simpler to reason about, no month-length edge cases
- One trial per user, ever, enforced independent of whether they still have the same Stripe customer/subscription record
- Auto-converts to paid at day 30 unless canceled; if the card is declined at conversion, cancel rather than pause (simpler v1 — see §2)

---

## 2. Decisions this roadmap assumes (flag if you want different answers)

| Decision | Recommendation | Why |
|---|---|---|
| Card required upfront? | **Yes** | Matches Stripe default; the entire reason LinkedIn's model converts well |
| Trial length mechanism | **`trial_period_days: 30`** | Calendar-month trials have length edge cases (28–31 days); day-count is unambiguous |
| Credits during trial | **Full `VIP_BENEFITS.monthlyCredits` on trial start** | This *is* the trial's value prop — a gutted trial won't move conversion. Abuse risk is mitigated by card-required + one-trial-per-user (§4.3) |
| End-of-trial behavior with no valid card | **`missing_payment_method: 'cancel'`** for v1 | `'pause'` is more forgiving (lets users resume later) but adds a `paused` state your downgrade/notification logic needs to handle. Ship `cancel` first, revisit `pause` once the simple path is stable |
| Trial eligibility scope | **Anyone who has never had a VIP subscription (trial or paid)** | Simplest rule to reason about and to explain to a support-ticket-filing user |
| Re-trial after cancellation | **Not allowed** | The eligibility flag is sticky on `users`, independent of subscription/cancellation history |

Everything below assumes these answers. Sections that change materially under different answers are called out.

---

## 3. Database schema changes ✅ (already in place)

Three additive changes. None require backfilling — new nullable columns, existing rows are simply `NULL`/`false`.

### 3.1 `users` — sticky trial-eligibility flag ✅

Present in `src/db/schema.ts:226`:

```ts
vipTrialUsedAt: timestamp("vip_trial_used_at", { withTimezone: true }), // null = never used trial
```

Set once, at trial start, never cleared. A boolean would work too, but the timestamp is free and useful for support/analytics ("when did this user's trial start").

### 3.2 `subscriptions` — mirror trial state locally ✅

Present in `src/db/schema.ts:1335-1336`:

```ts
isTrial: boolean("is_trial").notNull().default(false),
trialEnd: timestamp("trial_end", { withTimezone: true }),
```

`subscriptionStatuses` in `src/types/subscription.ts:17-26` already includes `'trialing'` and `'paused'`.

### 3.3 `subscriptionTransactions` — new transaction types + metadata column ✅

Present in `src/types/subscription.ts:10` (both backend and frontend):

```ts
export type SubscriptionTransactionType =
  | 'activation'
  | 'renewal'
  | 'cancellation'
  | 'trial_started'    // trial-start credit allocation
  | 'trial_expired';   // NEW (round 2) — trial ended without converting; see §9.2 Q4
```

Round 2 also added a `metadata` column to `subscriptionTransactions` (jsonb, nullable, matching the pattern already used on `subscriptions.metadata`), so the `'trial_expired'` row can carry `{ creditsRemainingAtCancellation, trialEnd }` without needing new dedicated columns:

```ts
metadata: jsonb("metadata"),
```

### 3.4 Migration note ✅

The `subscriptions.userId` FK fix was landed prior to this implementation. The round-2 `subscriptionTransactions.metadata` column is additive and nullable — safe to migrate without backfill.

---

## 4. Backend implementation ✅ (fully implemented)

### 4.1 New config ✅

Implemented in `src/config/subscription.ts:36-60`:

```ts
export const VIP_TRIAL = {
  enabled: process.env.VIP_TRIAL_ENABLED === 'true',
  trialPeriodDays: parseInt(process.env.VIP_TRIAL_PERIOD_DAYS || "30"),
  endBehavior: (process.env.VIP_TRIAL_END_BEHAVIOR || "cancel") as 'cancel' | 'pause',
} as const;
```

Gate the whole feature behind `VIP_TRIAL.enabled` so it can be killed instantly via env var/config without a deploy if conversion or abuse numbers look wrong post-launch.

### 4.2 Eligibility check endpoint ✅

Implemented in `src/routes/payments.ts:638-663`:

```
GET /payments/subscription/trial-eligibility
```

Returns `{ eligible: boolean }`. Checks, in order:
1. `users.vipTrialUsedAt IS NULL` for the requesting user
2. `!hasActiveVipSubscription(userId)` (already VIP → not trial-eligible)

Call this before showing any trial CTA in the frontend. **Defense in depth:** at checkout-session creation time (§4.3), re-checks eligibility server-side regardless of what the frontend showed.

### 4.3 Checkout session endpoint ✅

Implemented in `src/routes/payments.ts:688-830`:

```
POST /payments/create-trial-checkout-session
```

- Separate endpoint (not a param on `create-subscription-checkout`) — cleaner validation branching
- Server-side eligibility re-check via `isTrialEligible()`
- Rate-limited: 1 session per 10 seconds per user
- `metadata.isTrial` set on **both** the session and `subscription_data.metadata`
- Reuses the same `?subscription=success` redirect contract as regular checkout

### 4.4 Webhook handling additions ✅

**a) `handleSubscriptionCreated` trial branching ✅** — already present in `src/routes/payments.ts:112-143`. Reads `trial_end` and `status === 'trialing'` from the Subscription object directly (source of truth), not checkout session metadata.

**b) `customer.subscription.trial_will_end` handler ✅** — implemented in:
- Service: `handleTrialWillEnd()` in `src/services/subscription.ts:442-467`
- Webhook handler: `handleTrialWillEndEvent()` in `src/routes/payments.ts:249-256`
- Wired into event switch at `src/routes/payments.ts:1056`

Creates a `trial_ending_soon` notification in `userNotifications`.

**c) `customer.subscription.updated` clears `isTrial` ✅** — already present in `src/services/subscription.ts:199`:

```ts
...(params.status !== 'trialing' && { isTrial: false }),
```

**d) `billing_reason` fix for invoice handling ✅** — already present in `src/routes/payments.ts:206-211`. The `invoice.payment_succeeded` handler only processes `billing_reason === 'subscription_cycle'` (genuine renewals), skipping `subscription_create` (initial invoice). This prevents the double-credit bug for both trial and non-trial subscriptions.

**e) Cancel-on-missing-payment-method ✅** — no code changes needed. With `end_behavior: 'cancel'`, Stripe fires `customer.subscription.deleted`, which the existing `handleSubscriptionDeleted` → `cancelSubscription()` already handles.

### 4.5 Abuse prevention ✅ (partially implemented)

- ✅ **Card-required**: Stripe default for subscription-mode Checkout — `payment_method_collection: "always"` is set explicitly in the trial checkout endpoint
- ✅ **One-trial-per-user**: `vipTrialUsedAt` flag set once, never cleared
- ✅ **Rate limiting**: Trial checkout endpoint has the same 1-per-10-seconds rate limit as regular subscription checkout
- 🔲 **Stripe-side cross-check** (fast-follow, not v1 blocker)

### 4.6 Expiration/downgrade path ✅ (no code changes needed)

No changes needed to `vip-expiration.ts` — it already keys off `tier = 'vip' AND vipExpiresAt < now()`, and `createSubscription()` sets `vipExpiresAt` to `trialEnd` for trial subscriptions. An abandoned trial is caught by the same cron job that handles expired paid subscriptions.

---

## 5. Frontend implementation (separate `twistloom-web` repo)

This section was updated after auditing the actual frontend code (`useVipActions`, `SubscriptionManagement`, `subscription-api.ts`, etc.) against the backend above. The good news: the existing frontend/backend contract is solid — checkout redirect params match exactly, the origin-validated portal flow lines up, cancel-at-period-end reflects immediately via `refetch()` rather than waiting on a webhook.

Everything below is new, additive work for the trial feature specifically.

### 5.1 Backend readiness — two existing endpoints need a trial-aware update first ✅ (completed in backend)

**`GET /payments/subscription`** and **`POST /payments/subscription/cancel`** both historically hard-gated on `status === 'active'`. This has been fixed:

- `GET /subscription` now includes `isTrial`/`trialEnd` in its response and accepts `'trialing'` as a valid active status (`src/routes/payments.ts:810`)
- `POST /subscription/cancel` now queries `inArray(status, ['active', 'trialing'])` (`src/routes/payments.ts:1417`)
- `cancel_at_period_end: true` on a trialing Stripe subscription behaves correctly out of the box

### 5.2 New backend endpoints the frontend needs ✅ (completed in backend)

Two new endpoints are live in `src/routes/payments.ts`:

- `GET /payments/subscription/trial-eligibility` (`:638`) — returns `{ eligible: boolean }`
- `POST /payments/create-trial-checkout-session` (`:688`) — creates Stripe trial checkout with server-side eligibility re-check

Both reuse the same `?subscription=success` redirect contract, meaning **`SubscriptionStatusMessage.tsx` needs zero changes**.

### 5.3–5.10 Frontend work ✅ (completed in `twistloom-web` repo)

All frontend work is complete. The sections below reflect what was built — file paths point to the actual implementation.

**Summary of frontend work completed:**

| Section | Component | File(s) | Status |
|---------|-----------|---------|--------|
| 5.3 | Frontend types | `src/lib/types/api/subscription.ts` | ✅ `UserSubscription.isTrial` + `trialEnd`, `TrialEligibilityResponse`, `CreateTrialSessionRequest`, `CreateTrialSessionResponse` |
| 5.4 | API service methods | `src/lib/services/subscription-api.ts:93-110` | ✅ `getTrialEligibility()` + `createTrialSession()` on `SubscriptionApi` class |
| 5.5 | `useTrialEligibility` hook | `src/lib/hooks/query/useTrialEligibility.ts` | ✅ TanStack Query, `enabled: isAuthReady`, `retry: false`, `staleTime: 2min`, `gcTime: 5min` |
| 5.6 | `handleStartTrial` action | `src/components/vip/useVipActions.ts:115-128` | ✅ Creates trial session + redirects, fallback URL chain via `overrides`/`params`/`origin` |
| 5.7 | `SubscriptionManagement` trial display | `src/components/subscription/SubscriptionManagement.tsx` | ✅ Blue-themed banner, `isTrial` + `trialing` detection, `trialDaysLeft` countdown, distinct cancel/warning messages |
| 5.8 | Trial CTA (inline, not separate component) | `src/components/modals/vip/VipUpgradeModal.tsx` + `src/components/dashboard/DashboardAccountSubscriptionClient.tsx` | ✅ Trial eligibility banner with `Rocket` icon, "Start 1-Month Free Trial" primary CTA, `useTrialEligibility()` + `useVipActions.handleStartTrial` integrated |
| 5.9 | Post-checkout success copy | `src/components/subscription/SubscriptionStatusMessage.tsx:116-118` | ✅ `isTrial` detection on redirect → `successTrial.title`/`description` locale keys |
| 5.10 | Notification center (zero-code) | N/A | ✅ `trial_ending_soon` type is handled automatically by the existing `userNotifications` rendering pipeline — no changes needed |

---

## 6. Testing plan

Stripe **test clocks** are the right tool here — they let you advance simulated time so a 30-day trial plays out in minutes instead of a month of manual waiting:

```bash
stripe test_helpers test_clocks create --frozen-time <now>
# create the trial subscription against a customer attached to this clock
stripe test_helpers test_clocks advance --clock <id> --frozen-time <now+30d>
```

Minimum scenarios to cover before shipping:
1. Trial starts → credits allocated once, `vipTrialUsedAt` set, `vipExpiresAt` = trial end
2. `trial_will_end` fires → notification created
3. Trial converts (card valid) → status flips to `active`, `isTrial` clears, first post-trial invoice processed correctly per your §4.4d decision
4. Trial ends with no/invalid card → subscription canceled, user downgraded, `vipTrialUsedAt` **stays set** (no re-trial)
5. User cancels mid-trial → same downgrade path as a canceled paid subscription
6. Ineligible user (already used trial) hits the checkout endpoint directly (bypassing frontend) → rejected server-side
7. Duplicate webhook delivery for `customer.subscription.created` on a trial → idempotent (this is exactly what the `isUniqueViolation` handling from the payment audit protects)

Use the Stripe CLI (`stripe trigger customer.subscription.trial_will_end`, etc.) to fire individual events in isolation before running the full test-clock timeline.

---

## 7. Analytics — worth tracking from day one

Because `subscriptionTransactions.type = 'trial_started'` is distinct from `'activation'`, these are straightforward queries against existing tables — no new analytics infra needed for v1:

- Trial starts per week
- Trial → paid conversion rate (`activation`/`renewal` rows where the subscription's `isTrial` history shows a prior `trial_started`)
- Time-to-cancel distribution for trials that don't convert
- Credits consumed during trial vs. after conversion (useful signal for whether the "full credits upfront" decision in §2 is being abused or is genuinely driving engagement)

---

## 8. Rollout sequencing

| Step | Status |
|------|--------|
| 1. Land the payment-audit fixes first (idempotency, FK, expiration cron scheduling) | ✅ Complete |
| 2. Schema migration (§3) — additive columns already present | ✅ Complete |
| 3. Backend implementation behind `VIP_TRIAL.enabled` flag | ✅ Complete (`src/config/subscription.ts`, `src/services/subscription.ts`, `src/routes/payments.ts`) |
| 4. Internal testing with Stripe test clocks (§6) in test mode | 🔲 Pending |
| 5. Flip `VIP_TRIAL.enabled = true` in test mode | 🔲 Pending |
| 6. Frontend implementation (types, hooks, API service, components, localization — see §5.3–5.10) | ✅ Complete (ships with the backend in `twistloom-web` repo) |
| 7. Soft launch: enable for a small % of eligible users | 🔲 Pending |
| 8. Monitor conversion rate + `webhookDeliveries` failure rate | 🔲 Pending |
| 9. Full rollout once cohort completes a full cycle cleanly | 🔲 Pending |

---

## Open decisions recap (from §2)

These are the decisions that were made during implementation. If any change, the section they affect is noted:

| Decision | Chosen value | Implemented as |
|----------|-------------|----------------|
| Card required upfront | **Yes** | `payment_method_collection: "always"` in trial checkout endpoint (`:808`) |
| Trial length mechanism | **`trial_period_days: 30`** | `VIP_TRIAL.trialPeriodDays` config (`config/subscription.ts:43`) |
| Credits during trial | **Full `VIP_BENEFITS.monthlyCredits`** | `createSubscription()` branches on `isTrial` (`services/subscription.ts:128`) |
| End-of-trial behavior (no valid card) | **`missing_payment_method: 'cancel'`** | `VIP_TRIAL.endBehavior` config, passed to `trial_settings` (`:817`) |
| Trial eligibility scope | **One trial per user, ever** | `vipTrialUsedAt` checked in `isTrialEligible()` (`services/subscription.ts:415`) |
| Re-trial after cancellation | **Not allowed** | `isTrialEligible()` checks `vipTrialUsedAt` which is set once, never cleared |

**If you want to change any of these:**
- Card-optional → change `payment_method_collection: 'if_required'` in the trial checkout endpoint
- `pause` instead of `cancel` → update `VIP_TRIAL.endBehavior`, revisit downgrade path for paused state
- Reduced credits → change the `addCredits` amount in `createSubscription()`'s trial branch
- Allow re-trial → remove the `vipTrialUsedAt` check from `isTrialEligible()`, add Stripe-side cross-check

---

## 9. Post-Implementation Review — alignment analysis, design rationale & gaps

### 9.1 Alignment with LinkedIn's real-world trial model

The roadmap claimed a "LinkedIn-style" model. After researching LinkedIn's actual implementation, here is the alignment assessment:

| Aspect | LinkedIn | Twistloom (current) | Aligned? |
|--------|----------|--------------------|----------|
| **Card required upfront** | Yes — valid card mandatory to start trial | Yes — `payment_method_collection: "always"` | ✅ |
| **Full features during trial** | Yes — full Premium access | Yes — full VIP benefits (badge, 2x credits, check-in) | ✅ |
| **Trial duration** | 1 month (exact days vary by region) | `trial_period_days: 30` | ✅ |
| **Auto-convert to paid** | Yes — unless canceled before trial end | Yes — Stripe handles at trial end | ✅ |
| **In-app trial-end reminder** | Yes — notifications before trial ends | Yes — `trial_ending_soon` via `userNotifications` | ✅ |
| **Email trial-end reminder** | Yes — sends to primary email before trial end and before charge | ✅ Implemented (round 2) — `sendTrialEndingEmail()` via Resend, non-blocking alongside in-app notification | ✅ |
| **Cancellation behavior** | Cancel early → **immediate loss of Premium access** | Cancel early → VIP continues until trial end (`cancel_at_period_end: true`) | ✅ Intentional divergence — see Q1 |
| **Failed payment at conversion** | 5-day grace period to update billing before downgrade | Immediate cancellation via `end_behavior: 'cancel'` | ✅ Intentional divergence — see Q2 |
| **Re-trial eligibility** | Cooldown period ("at least 12 months" if canceled) | Permanent one-trial-per-user (never eligible again) | ✅ Intentional divergence — see Q3 |
| **Cancel deadline** | Must cancel at least 1 day before billing date | Can cancel up to the last minute | ⚠️ More permissive |
| **Trial-eligible scope** | Multiple factors (region, promotions, history) | Simple: never had trial + no active sub | ⚠️ Simpler |
| **Notification type** | Email + in-app | Email + in-app — see Q5 | ✅ |

**Key divergence 1 — Cancellation stays "keep until trial end," not LinkedIn's immediate downgrade:**
Resolved in Q1 below — the short version is that Twistloom's trial credits are front-loaded at trial *start*, not metered continuously like LinkedIn's InMail/search access, so there's no incremental gaming risk from letting cancel-at-period-end apply the same way it does for paid subscribers.

**Key divergence 2 — `cancel`, not LinkedIn's 5-day grace period, on failed payment at conversion:**
Resolved in Q2 below — staying with `cancel` for v1 is a "ship simple, revisit with data" call, not a final position.

### 9.2 Design rationale — Q1–Q6 resolved

Each question below is now a documented decision, not an open one. Format: the original question and trade-off, the decision, the reasoning specific to Twistloom (not a generic "it depends"), and what — if anything — changed in code.

---

#### Q1: Cancel mid-trial — immediate downgrade or end-of-trial?

**Trade-off recap:** LinkedIn revokes Premium the instant you cancel during trial. Our implementation lets VIP continue until trial end via `cancel_at_period_end: true`, matching how paid-subscriber cancellation already works.

**Decision: keep current behavior (access continues until trial end). No code change.**

**Why, specifically for Twistloom:** LinkedIn's stricter model defends against continuous metering — InMail credits and search visibility are usable throughout the month, so letting someone cancel-yet-keep-access is genuine ongoing leakage for them. Twistloom's trial credits don't work that way: the full 50 credits land in one lump sum at trial *start*, not doled out over the 30 days. By the time a user could even click "cancel," the credits have already been granted — revoking VIP status doesn't claw anything back, it only stops the 2x check-in multiplier and badge for the remaining trial days.

More importantly: a user can get the *identical* outcome — 50 free credits, never charged — by doing nothing and just letting the trial lapse with no valid card. Cancel-at-period-end isn't an additional exploit on top of that; it's the same outcome reached a different way. Matching LinkedIn here would make cancellation feel punitive and inconsistent with the paid-subscriber mental model, without closing any gap that doesn't already exist regardless.

**If you revisit this:** the trigger would be evidence that users are specifically using cancel-during-trial (vs. just not converting) as a deliberate farming pattern — something the Q4 tracking below would help surface, since both paths end in the same `trial_expired` row.

---

#### Q2: Failed payment at conversion — grace period or immediate cancel?

**Trade-off recap:** LinkedIn gives 5 days to fix billing before downgrading. `end_behavior: 'cancel'` terminates immediately.

**Decision: keep `end_behavior: 'cancel'` for v1. No code change.**

**Why, specifically for Twistloom:** This was always framed as "ship simple, revisit with data" (§2), and that framing hasn't changed — you don't have a launched trial yet, which means you don't have data on how much conversion is actually being lost to expired-vs-abandoned cards. `'pause'` earns its complexity (a `paused` UI state, a resume flow, "update your card" reminder logic) once you can point at real numbers showing that complexity pays for itself. Building it speculatively now is optimizing for a problem you can't yet measure.

**If you revisit this:** once you have a full cohort's worth of trial-conversion data, look specifically at how many failed-conversion cancellations happen within, say, 48 hours of the charge attempt (a strong signal for "the card just expired" vs. "actively didn't want to pay"). That number is what would justify building `pause`.

---

#### Q3: Re-trial eligibility — permanent lockout or cooldown?

**Trade-off recap:** LinkedIn allows a re-trial after a ~12-month cooldown. `vipTrialUsedAt` is currently permanent — set once, never cleared.

**Decision: keep permanent lockout. No code change.**

**Why, specifically for Twistloom:** A cooldown is a re-engagement lever, and re-engagement levers pay off at volume — LinkedIn has enough lapsed-trial users that winning back a meaningful fraction 12 months later is worth the bookkeeping (a `vipTrialCooldownUntil` column, logic to check and clear it, decisions about what counts as "cooldown expired"). At Twistloom's current stage, you don't have enough historical trial users for that lever to move any meaningful number yet. Permanent lockout is simpler, and — importantly — it's the easier direction to change later: loosening a permanent lockout into a cooldown is a straightforward migration; the reverse (tightening a cooldown back to permanent after users have come to expect re-trial eligibility) is the genuinely annoying one.

**If you revisit this:** once you have enough lapsed-trial-user volume that a win-back campaign would be statistically meaningful, not before.

---

#### Q4: Trial credits after failed conversion — keep or claw back?

**Trade-off recap:** Credits granted at trial start are never reclaimed if the trial doesn't convert. LinkedIn has no analog (no in-app currency).

**Decision: no clawback — but capture the data needed to revisit this later. Implemented.**

**Why, specifically for Twistloom:** The abuse surface here is already tightly bounded by Q3's permanent lockout — at most 50 credits, once, ever, per user, with no repeat exploit available. Clawback would also only ever recover *unspent* credits (spent ones already hit the existing refund floor at zero), so the realistic recoverable amount per non-converting trial is somewhere between 0 and 50 credits, one time. Weigh that thin upside against the failure mode on the other side: clawing back credits from someone who just changed their mind about the card reads as punitive, and is exactly the kind of thing that generates a bad review from someone who wasn't trying to abuse anything.

What's genuinely worth having is the *data* — not a policy, a number. `cancelSubscription()` now checks whether a cancelled subscription ever converted (via `subscriptionTransactions` history: has a `'trial_started'` row, has no `'renewal'` row — not the `isTrial` flag, which is usually already cleared by a preceding `customer.subscription.updated` event by the time `.deleted` fires). If it never converted, it logs a `trial_expired` row with the user's credit balance at that moment, in `metadata.creditsRemainingAtCancellation`. Zero UX cost, and if trial-credit abuse ever turns out to be a real cost driver, you'll have the actual numbers instead of a guess.

**Code changes:**
- `subscriptionTransactions.metadata` (jsonb, nullable) — new column
- `SubscriptionTransactionType` — added `'trial_expired'` (both backend and frontend types)
- `cancelSubscription()` in `subscription.services.ts` — the tracking logic described above

**If you revisit this:** query `subscriptionTransactions WHERE type = 'trial_expired'` for the distribution of `metadata.creditsRemainingAtCancellation`. If most non-converters have spent most of their credits by cancellation, clawback wouldn't recover much even if you built it — that alone might settle the question without further debate.

---

#### Q5: Email notifications for trial ending — send via Resend?

**Trade-off recap:** Currently only Stripe's own trial-ending email (Dashboard config) plus an in-app notification. LinkedIn sends its own branded email.

**Decision: yes, add `sendTrialEndingEmail()`. Implemented.**

**Why, specifically for Twistloom:** Stripe's built-in email is a genuine zero-code safety net, but it's generic and Stripe-branded — for an app with its own distinct voice, a user might not immediately parse "billing notification from Stripe" as being from Twistloom specifically, and it competes for attention differently than a branded email would. You already have the Resend pipeline built (`sendWelcomeEmail`, `sendPasswordResetEmail`) and the exact trigger point already exists (`handleTrialWillEnd`, right next to where the in-app notification gets created) — the marginal cost of adding this is small, and it has a direct line to the metric that matters most for the whole feature: conversion rate.

**Code changes:**
- `handleTrialWillEnd()` in `subscription.services.ts` — now fetches `email`/`name` and calls `sendTrialEndingEmail()`, wrapped so a send failure can't break the in-app notification or fail the webhook
- `email.trial-ending-addition.ts` (delivered separately) — the actual send function, written to merge into your real `src/utils/email.ts`, which wasn't available to edit directly. Adjust sender identity and template styling to match your existing emails.

**Sequencing:** land this before full rollout (§8 step 7); it doesn't need to block internal/soft-launch testing.

---

#### Q6: Environment variable documentation

**Decision: document them. Implemented.**

Straightforward hygiene — `env.trial-addition.example` (delivered separately) has all three (`VIP_TRIAL_ENABLED`, `VIP_TRIAL_PERIOD_DAYS`, `VIP_TRIAL_END_BEHAVIOR`) with descriptions, ready to merge into your real `.env.example`.

---

### 9.3 Future implementation gaps (not blockers)

These are non-critical gaps that can be addressed post-launch:

| Item | Priority | Description |
|------|----------|--------------|
| **Trial analytics queries** | Low | §7 describes the queries (trial starts/week, conversion rate, time-to-cancel). No views or SQL written yet. Both `subscriptionTransactions.type = 'trial_started'` and the new `'trial_expired'` (with its credits-remaining snapshot) make these straightforward to write when you actually want the dashboard. |
| **Stripe-side abuse prevention** | Low | §4.5 mentions Stripe Radar rules for repeat-trial card fingerprints. Configured in the Stripe Dashboard, not code — not implemented. |
| **Stripe trial-ending email config** | Low | §4.4b mentions Dashboard → Subscriptions and emails → Manage free trial messaging. Stripe-side config, not code. |
| **Automated tests** | Medium | No test files yet. §6 covers manual Stripe test-clock scenarios. Worth automating `isTrialEligible()`, the eligibility endpoint, the trial checkout endpoint, and now `cancelSubscription()`'s trial-expired branch given the transaction-history logic isn't entirely trivial. |
| **`pause` end behavior** | Low | Deliberately deferred per Q2. `VIP_TRIAL.endBehavior` config is ready for it, but the downgrade/notification path needs the work described in §4.6 before it's safe to flip. |

### Resolution summary

| # | Question | Decision | Status |
|---|----------|----------|--------|
| Q1 | Cancel mid-trial: immediate downgrade or end-of-period? | Keep end-of-period | ✅ No code change — current behavior is correct |
| Q2 | Failed payment at conversion: cancel or grace period? | Keep `cancel` for v1 | ✅ No code change — revisit with real conversion data |
| Q3 | Re-trial: permanent lockout or cooldown? | Keep permanent lockout | ✅ No code change — revisit at higher lapsed-user volume |
| Q4 | Trial credits on failed conversion: keep or claw back? | No clawback, track the data | ✅ Implemented |
| Q5 | Email notifications via Resend for trial ending? | Yes | ✅ Implemented |
| Q6 | Document new env vars? | Yes | ✅ Implemented |

