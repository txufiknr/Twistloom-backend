# Referral Rewards Architecture

## Overview

Twistloom’s referral system attributes a new user to an existing user via
`users.referrer_id`, then pays a **mutual credit bonus** (`REFERRAL_BONUS`)
only after the referred user has a **verified email**.

This document describes:

- Current data model and state machine
- Link vs pay split (attribution vs reward)
- End-to-end flows (form signup, Google OAuth, onboarding)
- Anti-abuse rules (verified referrer, idempotent payout)
- Comparison with common patterns at large platforms
- Counter alignment with payout (`referred_users`)
- Future hardening options

Related code:

| Area | Location |
|------|----------|
| Link referrer | `setReferrerForNewUser` in `src/services/user-controller.ts` |
| Pay bonus | `tryAwardReferralBonus` in `src/services/user-controller.ts` |
| Signup | `POST /auth/signup` in `src/routes/auth.ts` |
| Email verify | `POST /auth/verify-email` in `src/routes/auth.ts` |
| Onboarding | `POST /user` in `src/routes/user.ts` |
| Bonus amount | `REFERRAL_BONUS` in `src/config/credits.ts` |
| Counter trigger | `users_referral_trigger` in `src/db/triggers.ts` |

---

## Design goals

1. **Capture attribution early** — store `referrerId` as soon as the user
   enters a code (signup or onboarding), even if email is not verified yet.
2. **Do not pay freeloaders** — throwaway / unverified emails must not mint
   free credits for either side.
3. **Pay exactly once** — concurrent verify, re-verify, Google link-after-form
   must not double-pay.
4. **Google is already trusted** — OAuth users with `email_verified` from
   Google are treated as verified immediately.
5. **Invite graph hygiene** — only verified users may act as referrers.

---

## Data model

### Columns on `users`

| Column | Role |
|--------|------|
| `referrer_id` | UUID of the referring user. Set once (NULL → value). Never reassigned. |
| `referral_rewarded_at` | Timestamp when mutual credits were paid. Null = not paid yet. **Idempotency claim.** |

### Columns on `user_auth`

| Column | Role |
|--------|------|
| `email_verified` | Timestamp when email became trusted. Null = unverified. |

### Derived / side effects

| Artifact | When it fires |
|----------|----------------|
| `user_counters.referred_users` | DB trigger on `referral_rewarded_at` NULL → set (payout claim, same TX as credits) |
| Credit `transactions` + in-app notifications | Inside `tryAwardReferralBonus` when claim succeeds |
| Activity `referrer_set` | On successful link in `setReferrerForNewUser` |

### State machine (per referred user)

```
                    ┌──────────────────────┐
                    │  No referrer         │
                    │  referrer_id = NULL  │
                    │  rewarded_at = NULL  │
                    └──────────┬───────────┘
                               │ setReferrerForNewUser
                               │ (valid + verified referrer)
                               ▼
                    ┌──────────────────────┐
         ┌──────────│  Linked, unpaid       │
         │          │  referrer_id = set   │
         │          │  rewarded_at = NULL  │
         │          └──────────┬───────────┘
         │                     │
         │   email not verified│   email already verified
         │   (form signup)     │   (Google / already verified)
         │                     │
         │                     ▼
         │          tryAwardReferralBonus
         │                     │
         │   POST /verify-email│
         │   (or Google sign-in│
         │    sets verified)   │
         │                     ▼
          │          ┌──────────────────────┐
          └─────────▶│  Linked + paid       │
                     │  referrer_id = set   │
                     │  rewarded_at = set   │
                     │  (+1 referred_users  │
                     │   on referrer)       │
                     └──────────────────────┘
                                │
                                │ email change resets email_verified
                                │ but does NOT clear rewarded_at
                                ▼
                     Still “paid” — no second payout / no second +1
```

---

## Core API split

### 1. `setReferrerForNewUser` — **link only** (+ opportunistic pay)

Responsibilities:

1. Validate: user exists, `isNewUser`, no existing `referrerId`
2. Resolve referrer by username
3. **Reject if referrer’s `email_verified` is null** (same client message as not found)
4. Reject self-referral
5. Write `referrer_id`
6. Call `tryAwardReferralBonus` (pays immediately only if referred user is already verified)
7. Log activity, invalidate caches

Does **not** flip `isNewUser` (onboarding owns that).

### 2. `tryAwardReferralBonus` — **pay once**

Qualification (all required):

1. `referrer_id IS NOT NULL`
2. `user_auth.email_verified IS NOT NULL`
3. `referral_rewarded_at IS NULL`

Execution:

1. Open a DB transaction
2. **Atomic claim**: `UPDATE users SET referral_rewarded_at = NOW() WHERE … AND referral_rewarded_at IS NULL`
3. If zero rows → another worker already claimed / ineligible → abort
4. `awardCredits` to referrer and referred user (same `tx`)
5. Commit; invalidate both profile caches

If credit award fails, the transaction rolls back and `referral_rewarded_at`
stays null so a later call can retry.

### Call sites

```
setReferrerForNewUser
  ├─ POST /auth/signup          (body.referrer)
  └─ POST /user                 (onboarding body.referrer)

tryAwardReferralBonus
  ├─ setReferrerForNewUser      (if already verified)
  ├─ POST /auth/verify-email    (after verifyEmailToken)
  └─ createOrUpdateOAuthUser    (existing user path after COALESCE emailVerified)
```

---

## Flow diagrams

### A. Form signup with referrer (typical)

```
User                    Frontend                 Backend
 │                         │                        │
 │  fill form + referrer   │                        │
 │────────────────────────▶│                        │
 │                         │  POST /auth/signup     │
 │                         │───────────────────────▶│
 │                         │                        │  insert users + user_auth
 │                         │                        │  (email_verified = null)
 │                         │                        │  setReferrerForNewUser
 │                         │                        │    → referrer_id set
 │                         │                        │    → tryAward → SKIP
 │                         │  201 created           │
 │                         │◀───────────────────────│
 │                         │                        │
 │  enter OTP / open link  │                        │
 │────────────────────────▶│  POST /auth/verify-email
 │                         │───────────────────────▶│
 │                         │                        │  email_verified = NOW()
 │                         │                        │  tryAwardReferralBonus
 │                         │                        │    → claim + pay both
 │                         │  200 verified          │
 │                         │◀───────────────────────│
```

**Skip OTP path:** user can sign in without verifying. Credits stay deferred
until they eventually verify (or later sign in with Google on the same email,
which marks verified and runs `tryAwardReferralBonus`).

### B. Google OAuth / One Tap + onboarding referrer

```
User                    Frontend                 Backend
 │                         │                        │
 │  Google sign-in         │                        │
 │────────────────────────▶│  POST /auth/google-*   │
 │                         │───────────────────────▶│
 │                         │                        │  createOrUpdateOAuthUser
 │                         │                        │  email_verified = NOW()
 │                         │                        │  (Google email_verified required)
 │                         │  user + isNewUser      │
 │                         │◀───────────────────────│
 │                         │                        │
 │  onboarding + referrer  │                        │
 │────────────────────────▶│  POST /user            │
 │                         │───────────────────────▶│
 │                         │                        │  setReferrerForNewUser
 │                         │                        │    → referrer_id set
 │                         │                        │    → tryAward → PAY NOW
 │                         │  onboarding complete   │
 │                         │◀───────────────────────│
```

### C. Timing matrix

| Entry | When `referrer_id` set | When credits paid |
|-------|------------------------|-------------------|
| Form signup + referrer field | Signup | Email verify (or later Google verify) |
| Form signup, referrer at onboarding | Onboarding (`isNewUser`) | Email verify if not yet verified; else immediate |
| Google new user + referrer at onboarding | Onboarding | Immediate (already verified) |
| Google existing user (was form, had pending referrer) | Earlier | On Google login when `emailVerified` is set |

---

## Anti-abuse rules

### 1. Referred user must verify email before payout

Prevents bulk disposable signups from minting credits for a referrer farm.

Form signup already blocks many temp domains via `tempmail-checker`; email
verification is the second gate.

### 2. Referrer must already be email-verified

**Policy:** usernames of unverified accounts are **not eligible** as
`referrer`. `setReferrerForNewUser` rejects them with the same outward error
as “referrer not found” (no account-state leak).

**Rationale:**

| Approach | Pros | Cons |
|----------|------|------|
| **A. Reject unverified referrers (chosen)** | Invite graph is trusted; stops “signup → immediately spam invites → farm” loops; aligns with “earn invite rights after proving email” | Slightly fewer successful codes for brand-new form users who share before verifying |
| B. Allow any existing username | Simpler; more referral coverage | Unverified accounts can seed referral trees; circular low-trust farms |
| C. Allow link now, only pay when *both* verified | Captures attribution for early sharers | More state; referrer may never verify; product complexity |

Large platforms almost always require the **inviter** to be a real/verified
account before invite links work (or before rewards accrue to them).

**Product implication:** invite UI (`/invite/{username}`, copy link on
dashboard) is still shown by username today; an unverified user’s link simply
**fails at apply time**. Optional frontend polish: hide/disable invite copy
until `emailVerified` is set (not required for backend correctness).

### 3. One referrer per user, forever

`referrer_id` is write-once (NULL → value). No transfer, no stack of codes.

### 4. One payout per referred user, forever

`referral_rewarded_at` is write-once. Email change that clears
`email_verified` does **not** re-open payout.

### 5. Self-referral blocked

Username resolution must not equal the referred user’s id.

---

## Comparison with common industry patterns

| Platform style | Typical gates | Twistloom |
|----------------|---------------|--------------|
| **Dropbox** (classic) | Both parties get space; often required install / activity | Credits both sides; gate = email verify only |
| **Uber / rideshare** | First completed trip (or similar qualified action) | Not yet — no activity qualification |
| **Revolut / fintech** | KYC + first card spend / top-up | Email verify ≈ light KYC; no spend gate |
| **Robinhood** | Account funding / first trade | N/A |
| **Discord Nitro / game keys** | Friend must complete install + often time/activity | Verify only |
| **Airbnb** | Booking completed (high-value event) | N/A for credits product |

### Industry consensus

1. **Attribution early, reward late** — store the code at signup; pay on a
   “qualified” event. Twistloom’s qualified event is **email verification**.
2. **Pay both sides** (viral loop) or referrer-only (cost control). We pay
   both (`REFERRAL_BONUS` each).
3. **Hard anti-fraud** on high-value programs: device fingerprint, IP
   velocity, graph analysis, chargebacks. We use email trust + temp-mail block
   + rate limits as a lightweight stack.
4. **Idempotent ledger** — rewards are one-shot with a durable marker.
   We use `referral_rewarded_at` + transactional claim.

### Recommended future gates (if abuse appears)

Ordered from cheapest to strongest:

1. Require referred user `isNewUser = false` (completed onboarding) before pay
2. Require first reading session / first book open
3. Cap referrals per referrer per day / lifetime
4. Delay payout N hours after verify (reduce burn-and-delete)
5. Pay referrer only after referred user’s first purchase (high trust)

---

## `referredUsers` counter (aligned with payout)

The Postgres trigger `users_referral_trigger` increments
`user_counters.referred_users` when `referral_rewarded_at` goes **NULL →
non-NULL** on the referred user, using `NEW.referrer_id` as the counter
owner.

```sql
-- Conceptual condition (see src/db/triggers.ts)
IF TG_OP = 'UPDATE'
   AND OLD.referral_rewarded_at IS NULL
   AND NEW.referral_rewarded_at IS NOT NULL
   AND NEW.referrer_id IS NOT NULL THEN
  -- +1 user_counters.referred_users for NEW.referrer_id
END IF;
```

**Why this (not app-level increment):**

| Approach | Verdict |
|----------|---------|
| Trigger on `referral_rewarded_at` (chosen) | Same SSOT pattern as other Type A counters; fires in the same TX as the payout claim; hard to skip on new call paths |
| Increment inside `tryAwardReferralBonus` | Diverges from counter-trigger convention; easy to forget on admin/backfill paths |

Consequences:

- Achievement progress (`referredUsers`) only advances for **qualified**
  referrals (verified + paid).
- Bare `referrer_id` link alone does **not** move the counter.
- Rollback of the payout TX also rolls back the counter +1.

Deploy note: re-run `pnpm db:triggers` (or prod equivalent) so
`CREATE OR REPLACE FUNCTION` / trigger redefinition takes effect. Then
recompute historical counters if pre-v2 data inflated counts (see Backfill).

---

## Error / response behavior

| Situation | `setReferrer` result | Credits |
|-----------|----------------------|---------|
| Unknown username | false / not found | none |
| Unverified referrer | false / not found (same message) | none |
| Self-referral | false / validation | none |
| Already has referrer | false / validation | none (or already paid earlier) |
| Valid link, unverified referred | true | deferred |
| Valid link, verified referred | true | paid now |
| Verify email, pending referrer | n/a | paid once |
| Verify email, no referrer | n/a | none |
| Double verify / race | n/a | second claim no-ops |

Signup/onboarding use `{ handleResponse: false }` so a bad referrer does not
fail account creation — only `referralApplied` / silent skip.

---

## Operational notes

### Migration

```sql
ALTER TABLE "users" ADD COLUMN "referral_rewarded_at" timestamp with time zone;
```

(`drizzle/0040_deep_talon.sql`)

### Backfill (if needed after deploy)

#### A. Historical credits without `referral_rewarded_at`

Existing users who already received referral credits before this column
existed may have `referral_rewarded_at = NULL` while already paid. Options:

1. **Leave null** — **risky** if any path re-runs award.
2. **Safe backfill** (recommended):

```sql
-- Mark rewarded if a referral_bonus transaction exists for the referred user
UPDATE users u
SET referral_rewarded_at = COALESCE(
  (SELECT MIN(t.created_at) FROM transactions t
   WHERE t.user_id = u.user_id
     AND t.context = 'referral_bonus'),
  u.created_at
)
WHERE u.referrer_id IS NOT NULL
  AND u.referral_rewarded_at IS NULL
  AND EXISTS (
    SELECT 1 FROM transactions t
    WHERE t.user_id = u.user_id AND t.context = 'referral_bonus'
  );
```

Setting `referral_rewarded_at` via this UPDATE will also fire
`users_referral_trigger` (+1 per row). If counters were already inflated from
the old link-time trigger, prefer **B** after this, or run the UPDATE with
the trigger disabled for the session.

#### B. Recompute `referred_users` after payout-aligned trigger (v2)

If production ran the old link-time trigger, counters may be higher than
qualified referrals. Reconcile from SSOT:

```sql
-- Rebuild referred_users from qualified (paid) referrals only
UPDATE user_counters uc
SET referred_users = COALESCE(sub.cnt, 0),
    updated_at = NOW()
FROM (
  SELECT referrer_id AS user_id, COUNT(*)::int AS cnt
  FROM users
  WHERE referrer_id IS NOT NULL
    AND referral_rewarded_at IS NOT NULL
  GROUP BY referrer_id
) sub
WHERE uc.user_id = sub.user_id;

-- Zero out referrers who only had unpaid / never-paid links
UPDATE user_counters uc
SET referred_users = 0,
    updated_at = NOW()
WHERE referred_users > 0
  AND NOT EXISTS (
    SELECT 1 FROM users u
    WHERE u.referrer_id = uc.user_id
      AND u.referral_rewarded_at IS NOT NULL
  );
```

Run intentionally after deploy / trigger redeploy.

### Monitoring

Useful logs:

- `[setReferrerForNewUser] ✅ Applied referrer …`
- `[tryAwardReferralBonus] ⏳ Deferred — email not verified yet`
- `[tryAwardReferralBonus] ✅ Paid referral bonus …`
- `[tryAwardReferralBonus] ❌ Failed …`

Metrics to watch:

- Ratio of `referrer_id` set vs `referral_rewarded_at` set (funnel drop-off)
- Referral credits issued / day
- Achievements unlock rate on `referredUsers` vs verified conversions

---

## Frontend touchpoints (informational)

| Surface | Behavior |
|---------|----------|
| Sign-up form `referrer` | Sent on `POST /auth/signup`; may link without pay |
| `?referrer=` / sessionStorage | Persists through OAuth → onboarding |
| Onboarding `POST /user` | Second chance to set referrer if still `isNewUser` |
| Dashboard invite link | `/invite/{username}` — works for payout only if owner is verified when applied |
| OTP skip | Allowed; reward becomes an incentive to verify later |

---

## Summary

```
Link early          →  referrer_id
Qualify on trust    →  email_verified (referred)
Pay once            →  referral_rewarded_at + transactional award
Inviter must be real→  referrer email_verified required
Counter at payout   →  referred_users on referral_rewarded_at NULL→set
```

This matches the industry “attribute early, reward on trust signal” pattern
while keeping implementation simple for Twistloom’s credit economy.
