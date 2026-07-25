# Transactional Email — Completeness & Enhancement Roadmap

**Status:** Partial — core auth + trial + feedback ack live; several security/billing gaps and one unwired template  
**Companion architecture doc:** [docs/architecture/TRANSACTIONAL_EMAILS.md](../architecture/TRANSACTIONAL_EMAILS.md)  
**Stack:** Resend · `src/utils/email.ts` · `src/config/emails/*`  
**Last reviewed:** Jul 2026

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Current state scorecard](#2-current-state-scorecard)
3. [Incomplete implementations & issues](#3-incomplete-implementations--issues)
4. [Recommended new emails](#4-recommended-new-emails)
5. [Infrastructure & quality improvements](#5-infrastructure--quality-improvements)
6. [Phased roadmap](#6-phased-roadmap)
7. [Open questions (with recommendations)](#7-open-questions-with-recommendations)
8. [Out of scope (for now)](#8-out-of-scope-for-now)
9. [File touch map](#9-file-touch-map)

---

## 1. Executive summary

Email is **production-capable for a subset of journeys** (signup verification, password reset, VIP trial nudge, feedback thank-you) and has a solid shared layout + Resend wrapper. It is **not complete** as a security/billing notification surface.

| Area | Verdict |
|------|---------|
| Auth (verify + reset) | ✅ Working |
| Welcome | ⚠️ Template exists, **never sent** |
| Security alerts (password/email/account change) | ❌ Missing |
| Billing beyond trial-ending | ❌ Mostly Stripe Dashboard + in-app only |
| Support (user ack) | ✅ Working |
| Support (team alert) | ❌ Missing |
| Preferences / unsubscribe / bounce handling | ❌ Missing |
| i18n | ❌ English only |

**Highest-value next steps (recommended order):**

1. ~~**Wire welcome**~~ ✅ on `POST /api/user` when `isNewUser` → false  
2. **Security alert emails** after password change/reset, email change, account deletion  
3. **Re-verify after email change** (currently clears `emailVerified` with no new verification mail)  
4. **Payment / VIP lifecycle emails** where Stripe does not already cover UX  
5. **Internal feedback alert** to the team inbox  
6. **Delivery observability** (Resend webhooks, bounce hygiene)

---

## 2. Current state scorecard

| Email | Template | Send API | Call site | Quality notes |
|-------|----------|----------|-----------|---------------|
| Email verification | ✅ | ✅ | Signup + resend | OTP is 6-digit; also embedded in URL |
| Password reset | ✅ | ✅ | Forgot password | Enumeration-safe; 1h expiry |
| Welcome | ✅ | ✅ | ✅ `POST /api/user` (onboarding) | Once via `isNewUser` → false SSOT |
| VIP trial ending | ✅ | ✅ | Stripe `trial_will_end` | Non-blocking; dual with in-app + Stripe |
| Feedback acknowledgment | ✅ | ✅ | `POST /user/feedbacks` | Non-blocking try/catch; still awaits send before `201` |

**In-app only (no email today):** payment success, first-purchase bonus, referral bonus, payment refund notification, subscription past_due (handler exists without branded email).

**Provider-native (out of band):** Stripe Checkout/Customer receipts, invoices, dunning — configured in Stripe Dashboard, not Twistloom templates.

---

## 3. Incomplete implementations & issues

### 3.1 Welcome email — ✅ **wired (Q1 decided)**

- Trigger: `POST /api/user` when onboarding sets `isNewUser` `true` → `false`.
- Once-only via existing `isNewUser` guard (no extra DB column).
- Non-blocking: onboarding still succeeds if Resend fails.

---

### 3.2 Email change does not re-verify or notify — **P0 security gap**

`PUT /api/auth/email`:

1. Updates `users.email`
2. Sets `userAuth.emailVerified = null`
3. **Does not** send verification to the **new** address  
4. **Does not** notify the **old** address that the login email changed  

Impact: attacker with password can move the account to an email they control without the victim learning; new address may stay unverified indefinitely unless the user manually hits resend-verification.

**Recommended fix:**

1. Email old address: “Your login email was changed to … If this wasn’t you, reset password / contact support.”  
2. Email new address: standard verification flow (token + link).  
3. Optionally require verification of new email before treating it as the canonical login identity (stricter; see Q3).

---

### 3.3 Password change / reset has no confirmation email — **P1 security gap**

| Action | Route | Email today |
|--------|-------|-------------|
| Forgot → reset | `POST /auth/reset-password` | None after success |
| In-app change | `PUT /auth/password` | None |

Industry baseline (Google, GitHub, etc.): always email “your password was changed” with timestamp + device/IP hint + “if not you, reset now.”

---

### 3.4 Account deletion has no confirmation email — **P2 compliance / UX**

`DELETE /user` hard-deletes with cascade. No email confirmation of deletion (GDPR “right to erasure” is satisfied by deletion itself, but a **confirmation receipt** is good UX and reduces “did it work?” support load).

Send **before** delete (while email is still known), non-blocking relative to delete success if send fails.

---

### 3.5 Billing emails incomplete vs product events — **P1–P2**

| Event | Backend today | Email |
|-------|---------------|-------|
| Credit pack purchase success | In-app notification | ❌ (Stripe receipt may exist) |
| First purchase bonus | In-app | ❌ |
| Charge refunded / credit clawback | In-app | ❌ |
| Invoice payment failed / past_due | Status update | ❌ branded email |
| VIP canceled / ends | Webhook handlers | ❌ |
| Trial converted to paid | Implicit via Stripe | ❌ Twistloom-branded |

Stripe covers receipts/invoices if Dashboard settings are correct — **do not duplicate receipts** unless branding or multi-gateway (Xendit) requires it.

---

### 3.6 Feedback: user ack only; team never notified — **P2 ops**

User gets thank-you. Ops must poll DB/admin UI. No `FEEDBACK_INBOX` / internal Resend send.

---

### 3.7 Latency: feedback (and similar) await Resend on the request path — **P3**

Feedback handler `await`s send inside try/catch before returning `201`. Failure-safe, but adds Resend RTT to API latency on serverless.

**Improvement:** fire-and-forget with logging, or queue (Vercel `waitUntil` / background job) once available in the Hono/Vercel adapter.

---

### 3.8 No delivery / bounce / complaint pipeline — **P2 reliability**

- No Resend webhook for `email.delivered` / `bounced` / `complained`
- No suppression list for hard bounces
- Failed sends only appear in app logs

---

### 3.9 No user email preferences — **P3 product**

Acceptable while only security/billing/transactional mail exists. Becomes required if welcome digests, tips, or marketing are added (CAN-SPAM / GDPR soft expectations).

---

### 3.10 English-only templates — **P3**

App has `en` / `id` locales on the web client; emails ignore user language.

---

### 3.11 Verification OTP vs link dual path — **P3 UX clarity**

Token is a **6-digit numeric OTP** stored as `emailVerificationToken`, passed both as `otpCode` in the template and as `token` query param on the link.

Works, but:

- Subject/body say “code” and “link” interchangeably  
- 6-digit space is weaker than a long random token (mitigated by rate limits + 24h expiry; still worth reviewing for high-value accounts)

Not broken; document and optionally strengthen token entropy later.

---

### 3.12 OAuth-only users and “email verified” semantics — **P3 consistency**

OAuth paths often mark email verified via provider. Welcome / verification rules should not re-spam OAuth users with verify mail. Any new welcome trigger must branch on `isNewUser` / provider.

---

## 4. Recommended new emails

Priority: **P0** must-have · **P1** should-have soon · **P2** nice · **P3** later

### 4.1 Security & account (highest ROI)

| Email | Priority | Trigger | Mandatory? | Notes |
|-------|----------|---------|------------|-------|
| **Password changed** | P1 | After successful `PUT /auth/password` and `POST /auth/reset-password` | Yes | Include approximate time, IP/UA if available; CTA: reset if unrecognized |
| **Email changed (old address)** | P0 | After `PUT /auth/email` | Yes | Alert to previous email |
| **Email verification (new address)** | P0 | After `PUT /auth/email` | Yes | Reuse `sendVerificationEmail` |
| **Account deleted confirmation** | P2 | Immediately before/after `DELETE /user` | Yes (transactional) | Keep copy short; no sensitive residual data |
| **New device / session** (optional) | P3 | New session row / first login from new UA | Optional prefs | Only if session list is productized |

### 4.2 Product lifecycle

| Email | Priority | Trigger | Mandatory? | Notes |
|-------|----------|---------|------------|-------|
| **Welcome** | P1 | First verified email/password signup **or** first OAuth create | Optional product | Wire existing template; prefer after verify for email users so bounce rate stays clean |
| **Onboarding nudge** (day 2–3, no book created) | P3 | Cron | Preference-gated | Only after welcome works and prefs exist |

### 4.3 Billing & VIP (complement Stripe, don’t clone it)

| Email | Priority | Trigger | Mandatory? | Notes |
|-------|----------|---------|------------|-------|
| **Payment failed / past_due** | P1 | `invoice.payment_failed` | Yes | Soft CTA to Customer Portal; Stripe may also email |
| **Subscription canceled / VIP ending** | P2 | Cancel webhook / vip-expiration cron | Yes transactional | Confirm access end date |
| **Trial converted to paid** | P2 | First paid invoice after trial | Optional | “Welcome to full VIP” |
| **Credit pack purchase receipt (branded)** | P3 | Checkout complete | Optional | Prefer Stripe receipt unless Xendit needs Twistloom HTML |
| **Refund processed** | P2 | `charge.refunded` for credit packs | Yes transactional | Align with credit clawback UX |

### 4.4 Support & ops

| Email | Priority | Trigger | Mandatory? | Notes |
|-------|----------|---------|------------|-------|
| **Internal new feedback alert** | P2 | `POST /user/feedbacks` | Ops only | To `FEEDBACK_INBOX` or Slack via email bridge; include category, message excerpt, userId, screenshot URL |
| **Feedback resolved** (future) | P3 | Admin marks feedback done | Optional | Requires admin workflow |

### 4.5 Explicitly not recommended yet

| Idea | Why wait |
|------|----------|
| Weekly “stories you might like” digests | Needs prefs + content ranking; spam risk |
| Achievement unlock emails | Noisy; in-app unnotified flow already exists |
| Marketing campaigns | Different compliance + tooling |

---

## 5. Infrastructure & quality improvements

| Improvement | Priority | Description |
|-------------|----------|-------------|
| **Shared non-blocking send helper** | P2 | `void sendX().catch(log)` or `waitUntil` wrapper used by feedback, trial, security alerts |
| **Resend webhooks** | P2 | Persist delivery status; suppress hard bounces |
| **Reply-To policy** | P3 | Support emails: `reply-to: support@…`; security: keep no-reply |
| **Template snapshot tests** | P2 | Golden HTML or smoke render for each template (catch layout regressions) |
| **Locale-aware templates** | P3 | Pass `locale` from user profile / Accept-Language |
| **Idempotency keys** | P3 | Avoid double-send on webhook retries (trial ending already somewhat guarded by Stripe delivery id) |
| **Admin preview route** | P3 | Dev-only HTML preview of templates |
| **Metrics** | P3 | Counts: sent / failed / bounced per template type |

---

## 6. Phased roadmap

### Phase 0 — Hygiene (0.5–1 day)

- [ ] Decide welcome: **wire** vs **delete** dead code (see Q1)
- [ ] Document Stripe Dashboard emails enabled (receipts, failed payment, trial) so product doesn’t double-build
- [ ] Confirm `RESEND_FROM_EMAIL` domain SPF/DKIM/DMARC on production

### Phase 1 — Security completeness (2–4 days) 🔴

- [ ] Password-changed email (in-app change + reset-password success)
- [ ] Email-change: notify old email + send verification to new email
- [ ] (Optional same phase) Soft-block login features until new email verified — see Q3
- [ ] Account-deleted confirmation email

### Phase 2 — Product wiring (0.5–1 day) ✅ **Q1 done**

- [x] Wire `sendWelcomeEmail` on onboarding complete (`POST /api/user`, `isNewUser` → false)
- [x] Once-only for all providers via `isNewUser` SSOT (no extra column)

### Phase 3 — Billing complements (2–3 days)

- [ ] Payment failed / past_due branded email
- [ ] Refund confirmation for credit packs
- [ ] Subscription canceled / VIP expired confirmation
- [ ] Skip full purchase receipts if Stripe already sends them (Q4)

### Phase 4 — Ops & reliability (2–3 days)

- [ ] Internal feedback alert email
- [ ] Background/non-blocking send pattern on hot paths
- [ ] Resend bounce webhook + simple suppression table

### Phase 5 — Preferences & growth (later)

- [ ] `users.emailPreferences` or dedicated table (product tips, digests)
- [ ] Onboarding nudge cron
- [ ] i18n templates (`en` / `id`)

---

## 7. Open questions (with recommendations)

### Q1 — When should the welcome email fire? ✅ **DECIDED**

| Option | Pros | Cons |
|--------|------|------|
| A. Immediately on signup (email/password) | Simple | Unverified / typo emails waste reputation |
| B. After successful email verification | Clean list; better deliverability | OAuth path needs separate branch |
| C. On first login after account creation (any provider) | One place for OAuth + password | Slightly later; need `welcomeEmailSentAt` flag |
| D. Don’t send; delete template | Less maintenance | Loses creator-led onboarding moment |
| **E. When onboarding completes (`isNewUser` → false)** | **Once only; no extra column; same path for OAuth + email** | User must finish onboarding to get mail |

**Decision (product): E — onboarding complete**

- **Trigger:** `POST /api/user` after a successful flip of `isNewUser` from `true` → `false` (onboarding endpoint; not `PUT /user`).
- **SSOT:** `isNewUser` already enforces once-only (`Onboarding already completed` if false). No `welcomeEmailSentAt` column.
- **Implementation:** `sendWelcomeEmail` in `src/routes/user.ts` (non-blocking try/catch so Resend failure never fails onboarding).

---

### Q2 — Should security emails include IP / device / location?

| Option | Pros | Cons |
|--------|------|------|
| A. Timestamp only | Simple, private | Weaker forensics for user |
| B. Timestamp + IP + User-Agent | Standard for security mail | Privacy perception; IP ≠ location accuracy |
| C. Timestamp + coarse geo (MaxMind etc.) | User-friendly | Extra dependency, GDPR considerations |

**Recommendation: B** for password/email change emails (data already available on request via `getClientIp` / headers). Skip geo until you have a clear privacy policy line for it.

---

### Q3 — After email change, must the new email be verified before it is used for login?

| Option | Pros | Cons |
|--------|------|------|
| A. Soft: update immediately, `emailVerified=null`, send verify (current DB behavior + new mails) | Minimal friction | Window where login email is unverified |
| B. Hard: keep old email until new verifies (pendingEmail column) | Strongest security | Schema + login complexity |
| C. Soft + force re-login / logout other devices on change | Good middle ground | Needs session invalidation integration |

**Recommendation: A now, C if session infrastructure is ready**

Ship A + old-email alert + new-email verification in Phase 1. Add logout-from-all-other-devices on email/password change when that roadmap item is live. Defer full `pendingEmail` (B) unless abuse appears.

---

### Q4 — Branded credit-pack receipts vs Stripe-only?

| Option | Pros | Cons |
|--------|------|------|
| A. Stripe receipts only | Zero code; tax/legal handled by Stripe | Less brand; Xendit path inconsistent |
| B. Twistloom email for every purchase | Full brand control | Duplicate mail annoyance if Stripe also sends |
| C. Twistloom email only for gateways without good receipts (e.g. Xendit) | Best of both | Branching logic |

**Recommendation: C**

Keep Stripe customer emails enabled for card purchases. Add Twistloom purchase confirmation for Xendit (and any non-Stripe path). Avoid double-emailing Stripe users.

---

### Q5 — Should feedback acknowledgment stay mandatory?

| Option | Pros | Cons |
|--------|------|------|
| A. Always send (current) | Sets expectation; feels professional | Noise for power users filing many bugs |
| B. Only for `bug_report` | Higher signal | “feedback” category feels ignored |
| C. User preference | Flexible | Prefs system not built |

**Recommendation: A** until volume is high. Revisit B only if abuse/spam of the feedback form becomes a cost issue.

---

### Q6 — Internal feedback alert: email vs Slack/Discord?

| Option | Pros | Cons |
|--------|------|------|
| A. Email to `FEEDBACK_INBOX` | Fits existing Resend stack | Inbox noise |
| B. Slack/Discord webhook | Fast triage | Another integration |
| C. Both | Redundant safety | Overkill for early stage |

**Recommendation: A first** (`FEEDBACK_INBOX=you@…`). Add Slack when feedback volume or multi-person ops needs it.

---

### Q7 — Trial-ending email: keep dual Stripe + Twistloom?

| Option | Pros | Cons |
|--------|------|------|
| A. Keep both (current) | Redundancy | Possible double-nudge |
| B. Twistloom only | Brand control | Must maintain reliability |
| C. Stripe only | Less code | Weaker brand; less control of copy |

**Recommendation: A** for VIP trial economics. Copy should stay short so dual-send is not spammy. Do not add a third channel (SMS) for this.

---

### Q8 — Build email preferences in Phase 1–3?

| Option | Pros | Cons |
|--------|------|------|
| A. Now | Future-proof | Over-engineering while only transactional mail exists |
| B. When first non-mandatory product email ships | Right time | Must not allow opt-out of security/billing |
| C. Never | Simple | Blocks growth mail |

**Recommendation: B**

Ship Phase 1–3 as non-optional transactional. Introduce prefs only when onboarding digests or tips are scheduled. Hard-code: security + billing never preference-gated.

---

### Q9 — Strengthen verification tokens beyond 6-digit OTP?

| Option | Pros | Cons |
|--------|------|------|
| A. Keep 6-digit + rate limits | Easy mobile entry | Brute-force surface (mitigated) |
| B. Long random token in link only | Stronger | Harder manual entry |
| C. Both: long link token + separate short OTP | Best UX/security | Two fields to store |

**Recommendation: A short-term** (already rate-limited). Move to **B or C** if you see enumeration/OTP guessing attempts in logs. Not blocking for email roadmap Phase 1.

---

## 8. Out of scope (for now)

- Full marketing automation / ESP migration away from Resend  
- SMS / push parity for every email  
- Multi-language legal templates for every jurisdiction  
- User-to-user messaging emails  
- Replacing Stripe’s invoice PDFs  

---

## 9. File touch map

| Work item | Primary files |
|-----------|----------------|
| New templates | `src/config/emails/*.ts`, `index.ts` |
| Send APIs | `src/utils/email.ts` |
| Password / email change hooks | `src/routes/auth.ts` |
| Account delete | `src/routes/user.ts` |
| Welcome trigger | `src/routes/user.ts` (`POST /` onboarding, `isNewUser` → false) |
| Billing emails | `src/routes/payments.ts`, `src/services/subscription.ts`, `src/services/credits.ts` / xendit |
| Feedback internal | `src/routes/user.ts` |
| Architecture doc update | `docs/architecture/TRANSACTIONAL_EMAILS.md` |
| Env | `.env.example` — `FEEDBACK_INBOX`, maybe `SUPPORT_REPLY_TO` |

---

## Appendix — Suggested Phase 1 subject lines

| Email | Subject |
|-------|---------|
| Password changed | `Your {APP_NAME} password was changed` |
| Email changed (old) | `Your {APP_NAME} email address was changed` |
| Verify new email | Existing: `Verify Your {APP_NAME} Email` |
| Account deleted | `Your {APP_NAME} account has been deleted` |
| Payment failed | `Action needed: {APP_NAME} payment failed` |
| Internal feedback | `[Feedback] {category} from {username}` |

---

*Update this roadmap when Phase items ship or when open questions are decided. Cross-link decisions into `TRANSACTIONAL_EMAILS.md`.*
