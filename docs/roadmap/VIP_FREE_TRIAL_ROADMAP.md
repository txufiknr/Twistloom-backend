# VIP Free Trial (1-Month) — Implementation Roadmap

**Status:** ✅ Fully implemented (Backend & Frontend complete)
**Depends on:** The Stripe payment audit fixes (idempotency, `subscriptions.userId` FK, VIP expiration cron scheduling) — these were landed prior to this implementation.
**Model:** LinkedIn-style — card required upfront, full VIP benefits during trial, auto-converts to paid unless canceled.

---

## Implementation CHANGELOG

### Implemented (Jul 2026)

- **Schema:** `vipTrialUsedAt` (users), `isTrial` + `trialEnd` (subscriptions) — already present before this work
- **Types:** `'trial_started'` transaction type, `'trialing'` / `'paused'` statuses — already present before this work
- **Config:** `VIP_TRIAL` config block with `enabled`, `trialPeriodDays`, `endBehavior` (see `src/config/subscription.ts:36`)
- **Service layer:**
  - `isTrialEligible(userId)` — one-trial-per-user, no active sub check (see `src/services/subscription.ts:401`)
  - `handleTrialWillEnd(stripeSubscriptionId)` — creates `trial_ending_soon` notification (see `src/services/subscription.ts:442`)
  - `createSubscription()` already branches on `isTrial` — no changes needed
  - `updateSubscription()` already clears `isTrial` when status leaves `trialing` — no changes needed
- **Routes:**
  - `GET /payments/subscription/trial-eligibility` — new endpoint (see `src/routes/payments.ts:638`)
  - `POST /payments/create-trial-checkout-session` — new endpoint with server-side eligibility re-check (see `src/routes/payments.ts:688`)
  - `GET /payments/subscription` — now includes `isTrial`/`trialEnd` in response, accepts `trialing` status (see `src/routes/payments.ts:810`)
  - `POST /payments/subscription/cancel` — accepts `trialing` status via `inArray` (see `src/routes/payments.ts:1417`)
- **Webhooks:**
  - `customer.subscription.trial_will_end` — new handler creates in-app notification (see `src/routes/payments.ts:249`)
  - Wired into webhook event switch at `src/routes/payments.ts:1056`

### Implemented (frontend — `twistloom-web` repo)

- Frontend types (`UserSubscription.isTrial`, `TrialEligibilityResponse`) in `types/api/subscription.ts`
- API service methods (`getTrialEligibility`, `createTrialSession`) in `services/subscription-api.ts`
- `useTrialEligibility` hook in `hooks/query/useTrialEligibility.ts`
- `useVipActions.handleStartTrial` hook action in `vip/useVipActions.ts`
- `SubscriptionManagement` trial-aware status display and trial cancellation in `subscription/SubscriptionManagement.tsx`
- Trial CTA inline notice and actions in `VipUpgradeModal.tsx` and `DashboardAccountSubscriptionClient.tsx`
- Post-checkout trial-specific success copy in `SubscriptionStatusMessage.tsx` and localization files `messages/en.json` & `messages/id.json`

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

### 3.3 `subscriptionTransactions` — new transaction type ✅

Present in `src/types/subscription.ts:10`:

```ts
export type SubscriptionTransactionType =
  | 'activation'
  | 'renewal'
  | 'cancellation'
  | 'trial_started';   // NEW
```

### 3.4 Migration note ✅

The `subscriptions.userId` FK fix was landed prior to this implementation.

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

### 5.3–5.10 Frontend work — ✅ Completed (in `twistloom-web` repo)

The sections below have been fully implemented in the `twistloom-web` repository.

**Summary of frontend work completed:**

| Section | Component | Status |
|---------|-----------|--------|
| 5.3 | Frontend types (`UserSubscription.isTrial`, `TrialEligibilityResponse`) | ✅ Completed |
| 5.4 | API service methods (`getTrialEligibility`, `createTrialSession`) | ✅ Completed |
| 5.5 | `useTrialEligibility` hook | ✅ Completed |
| 5.6 | `useVipActions.handleStartTrial` | ✅ Completed |
| 5.7 | `SubscriptionManagement` trial-aware status + countdown | ✅ Completed |
| 5.8 | Trial CTA components | ✅ Completed |
| 5.9 | Post-checkout trial-specific success copy | ✅ Completed |
| 5.10 | Notification center handles `trial_ending_soon` type (zero-code) | ✅ Completed |

Each section below remains as originally written — use them as a direct implementation guide for the frontend work.

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
| 6. Frontend implementation (see §5.3–5.10) | ✅ Complete |
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

## 9. Post-Implementation Review — alignment analysis, open questions & gaps

### 9.1 Alignment with LinkedIn's real-world trial model

The roadmap claimed a "LinkedIn-style" model. After researching LinkedIn's actual implementation, here is the alignment assessment:

| Aspect | LinkedIn | Twistloom (current) | Aligned? |
|--------|----------|--------------------|----------|
| **Card required upfront** | Yes — valid card mandatory to start trial | Yes — `payment_method_collection: "always"` | ✅ |
| **Full features during trial** | Yes — full Premium access | Yes — full VIP benefits (badge, 2x credits, check-in) | ✅ |
| **Trial duration** | 1 month (exact days vary by region) | `trial_period_days: 30` | ✅ |
| **Auto-convert to paid** | Yes — unless canceled before trial end | Yes — Stripe handles at trial end | ✅ |
| **In-app trial-end reminder** | Yes — notifications before trial ends | Yes — `trial_ending_soon` via `userNotifications` | ✅ |
| **Email trial-end reminder** | Yes — sends to primary email before trial end and before charge | 🔲 **Not implemented** — Stripe's own email exists but Twistloom doesn't send its own via Resend | ⚠️ Gap |
| **Cancellation behavior** | Cancel early → **immediate loss of Premium access** | Cancel early → VIP continues until trial end (`cancel_at_period_end: true`) | ❌ Mismatch |
| **Failed payment at conversion** | 5-day grace period to update billing before downgrade | Immediate cancellation via `end_behavior: 'cancel'` | ❌ Mismatch |
| **Re-trial eligibility** | Cooldown period ("at least 12 months" if canceled) | Permanent one-trial-per-user (never eligible again) | ⚠️ Different approach |
| **Cancel deadline** | Must cancel at least 1 day before billing date | Can cancel up to the last minute | ⚠️ More permissive |
| **Trial-eligible scope** | Multiple factors (region, promotions, history) | Simple: never had trial + no active sub | ⚠️ Simpler |
| **Notification type** | Email + in-app | In-app only (trial_will_end webhook → userNotifications) | ⚠️ Gap |

**Key divergence 1 — Cancellation = immediate downgrade (LinkedIn model):**
LinkedIn cancels Premium access the moment you cancel during trial. Our implementation lets the user keep VIP until trial end via `cancel_at_period_end: true`. LinkedIn's approach is stricter: if you cancel, the value proposition for converting later is gone, which disincentivizes trial-period gaming.

**Key divergence 2 — Grace period on failed payment (LinkedIn model):**
LinkedIn gives 5 days to update billing before downgrading. Our `end_behavior: 'cancel'` terminates immediately on failed payment. LinkedIn's approach is more forgiving and likely converts more users who simply have expired cards rather than unwillingness to pay.

### 9.2 Open questions requiring your decision

#### Q1: Cancel mid-trial — immediate downgrade or end-of-trial?

**Current behavior:** Mid-trial cancellation sets `cancel_at_period_end: true` → user keeps VIP until trial end.

**LinkedIn behavior:** Canceling during trial immediately revokes Premium access.

**Trade-off:**
- Immediate downgrade is stricter; prevents users from gaming the system by canceling and still getting the full trial period
- End-of-period is more generous and matches the non-trial cancellation UX (paid subscribers keep access until period end)

**→ Is the current "keep until trial ends" behavior acceptable, or should canceling mid-trial immediately downgrade?**

#### Q2: Failed payment at conversion — grace period or immediate cancel?

**Current behavior:** `end_behavior: 'cancel'` → Stripe cancels immediately if card fails at trial end. The cron job (vip-expiration.ts) downgrades the user on next run.

**LinkedIn behavior:** 5-day grace period to update billing info before downgrade.

**Trade-off:**
- Immediate cancel is simpler (no paused state to handle), cleaner for v1
- Grace period likely recovers more users who just have expired cards

**→ Is the current immediate-cancel acceptable for v1, or should we switch to `end_behavior: 'pause'` with a grace period?**

#### Q3: Re-trial eligibility — permanent lockout or cooldown?

**Current behavior:** `vipTrialUsedAt` is set once, never cleared → permanent one-trial-per-user.

**LinkedIn behavior:** Cooldown period ("at least 12 months" if you canceled your trial; possibly longer if you converted and then canceled).

**Trade-off:**
- Permanent lockout is simpler and prevents abuse
- Cooldown is friendlier for users who genuinely forgot to cancel; gives them a second chance after a long period
- LinkedIn's model prevents re-trials but brings users back after 12+ months — potentially valuable for user retention

**→ Should we keep permanent lockout, or implement a cooldown (e.g., 12 months) via an additional `vipTrialCooldownUntil` column?**

#### Q4: Trial credits after failed conversion — keep or claw back?

**Current behavior:** If a trial doesn't convert (card fails), `downgradeUserFromVip()` clears tier/vipExpiresAt/subscriptionId but does **not** deduct the 50 trial credits. The user keeps them.

**LinkedIn behavior:** N/A (LinkedIn doesn't have an in-app currency tied to subscriptions).

**Trade-off:**
- Keeping credits is generous; the user effectively got 50 free credits for trying VIP (positive UX, may convert later via credit pack purchase)
- Clawing back is more protection against abuse (users who repeatedly find ways to get trials and keep credits)
- Stripe's `end_behavior: 'cancel'` means the subscription is gone — there's no webhook we can easily hook into for clawback without tracking trial start↔end state explicitly

**→ Should trial credits be clawed back on failed conversion, or does the card-required gate make this acceptable?**

#### Q5: Email notifications for trial ending — should we send via Resend?

**Current behavior:** Only in-app notification via `userNotifications` table + Stripe's own trial-ending email (Dashboard config).

**LinkedIn behavior:** Sends email reminders before trial end AND before charging.

**Context:** The codebase already has Resend integration (`src/utils/email.ts`) — `sendPasswordResetEmail()`, `sendWelcomeEmail()`, etc.

**→ Do you want to add a `sendTrialEndingEmail()` function, or rely on Stripe's own email for v1?**

#### Q6: Environment variable documentation

Three new env vars were introduced:
- `VIP_TRIAL_ENABLED` (default: `false`)
- `VIP_TRIAL_PERIOD_DAYS` (default: `30`)
- `VIP_TRIAL_END_BEHAVIOR` (default: `cancel`)

**→ Should these be documented in a `.env.example` file or in the project README?**

### 9.3 Future implementation gaps (not blockers)

These are non-critical gaps that can be addressed post-launch:

| Item | Priority | Description |
|------|----------|-------------|
| **Trial analytics queries** | Low | §7 of the roadmap describes queries (trial starts/week, conversion rate, time-to-cancel). No views or SQL have been written. The `subscriptionTransactions.type = 'trial_started'` distinction makes these trivial to write when needed. |
| **Stripe-side abuse prevention** | Low | §4.5 mentions Stripe Radar rules for repeat-trial card fingerprints. Not implemented — can be configured directly in the Stripe Dashboard. |
| **Stripe trial-ending email config** | Low | §4.4b mentions Dashboard → Subscriptions and emails → Manage free trial messaging. This is a Stripe-side config, not code. |
| **Automated tests** | Medium | No test files were created. The roadmap mentions Stripe test clocks (§6) for manual testing. Consider adding automated tests for `isTrialEligible()`, the eligibility endpoint, and the trial checkout endpoint. |
| **Pause behavior** | Low | If you later want `end_behavior: 'pause'` instead of `cancel`, the `VIP_TRIAL.endBehavior` config is ready, but the downgrade path needs revisiting (paused subscriptions don't trigger `customer.subscription.deleted`). |

### Summary: decisions needed before launch

| # | Question | Impact if not decided |
|---|----------|---------------------|
| Q1 | Cancel mid-trial: immediate downgrade or end-of-period? | Affects frontend cancellation UX + subscription management display |
| Q2 | Failed payment at conversion: cancel or grace period? | Affects conversion rate + user recovery path |
| Q3 | Re-trial: permanent lockout or cooldown? | Affects long-term user acquisition strategy |
| Q4 | Trial credits on failed conversion: keep or claw back? | Affects abuse surface + credit economy |
| Q5 | Email notifications via Resend for trial ending? | Affects user communication strategy |
| Q6 | Document new env vars? | Affects deployability for other developers |
