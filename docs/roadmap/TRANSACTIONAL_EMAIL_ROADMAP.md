# Transactional & Engagement Email — Completeness & Enhancement Roadmap

**Status:** ✅ Core phases implemented (security, billing, feedback ops, preferences UIX, engagement crons + admin announcements)  
**Companion architecture doc:** [docs/architecture/TRANSACTIONAL_EMAILS.md](../architecture/TRANSACTIONAL_EMAILS.md)  
**Stack:** Resend · `src/utils/email.ts` · `src/config/emails/*` · `src/services/email-preferences.ts`  
**Last reviewed:** Jul 2026 (implementation pass)

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Current state scorecard](#2-current-state-scorecard)
3. [Implementation CHANGELOG](#3-implementation-changelog)
4. [Phased roadmap (status)](#4-phased-roadmap-status)
5. [Open questions (decided)](#5-open-questions-decided)
6. [Remaining / future](#6-remaining--future)
7. [File touch map](#7-file-touch-map)

---

## 1. Executive summary

| Area | Verdict |
|------|---------|
| Auth (verify + reset) | ✅ |
| Welcome | ✅ Onboarding (`isNewUser` → false) |
| Security alerts | ✅ Password / email change / account delete |
| Billing | ✅ Trial ending, payment failed, refund, sub canceled |
| Support (user ack + team) | ✅ Team via `FEEDBACK_INBOX` |
| Preferences + unsubscribe | ✅ Backend + frontend UIX |
| Weekly / monthly digests | ✅ Cron scripts |
| Admin announcements | ✅ `POST /admin/email/announcements` (super-admin) |
| Bounce webhooks / i18n templates | ❌ Deferred |

---

## 2. Current state scorecard

| Email | Template | Send API | Call site |
|-------|----------|----------|-----------|
| Verification | ✅ | ✅ | Signup, resend, email change (new) |
| Password reset | ✅ | ✅ | Forgot password |
| Password changed | ✅ | ✅ | PUT password, POST reset-password |
| Email changed (old) | ✅ | ✅ | PUT email |
| Welcome | ✅ | ✅ | POST /user onboarding |
| Account deleted | ✅ | ✅ | DELETE /user |
| Trial ending | ✅ | ✅ | Stripe trial_will_end |
| Payment failed | ✅ | ✅ | Stripe invoice.payment_failed |
| Refund | ✅ | ✅ | Stripe charge.refunded (packs) |
| Sub canceled | ✅ | ✅ | Stripe subscription.deleted |
| Feedback ack | ✅ | ✅ | POST /user/feedbacks |
| Feedback internal | ✅ | ✅ | Same + `FEEDBACK_INBOX` |
| Weekly might-like | ✅ | ✅ | `pnpm dev:cron:email-weekly` |
| Monthly activity | ✅ | ✅ | `pnpm dev:cron:email-monthly` |
| Announcement | ✅ | ✅ | POST /admin/email/announcements |

---

## 3. Implementation CHANGELOG

### Jul 2026 — full roadmap implementation pass

**Infrastructure**

- `sendEmailSafe` fire-and-forget helper; `formatSecurityDetailHtml`, `maskEmail`
- All new templates under `src/config/emails/` + barrel export
- `users.email_preferences` jsonb (migration `0038_spooky_raider.sql`)
- `src/services/email-preferences.ts` — defaults, sanitize, HMAC unsubscribe
- Public `src/routes/email.ts` unsubscribe
- Env: `FEEDBACK_INBOX`, `EMAIL_UNSUBSCRIBE_SECRET` documented in `.env.local.example`

**Phase 1 — Security**

- Password changed after in-app change + reset success (IP/UA/time in body)
- Email change: alert old address + verification to new (Q3 soft)
- Account deleted confirmation (capture email before cascade)

**Phase 3 — Billing**

- Payment failed → branded email + dashboard subscription deep link
- Refund → email after credit clawback
- Subscription deleted → canceled email with period end when available
- Trial ending uses `sendEmailSafe`

**Phase 4 — Ops**

- Internal feedback alert when `FEEDBACK_INBOX` set
- Feedback + welcome use `sendEmailSafe`

**Phase 5 — Preferences**

- GET/PATCH `/user/email-preferences`
- Defaults at onboarding + lazy ensure on GET
- Frontend: Preferences → Notifications email card, optimistic PATCH, always-on block
- Public unsubscribe page `/[locale]/email/unsubscribe`

**Phase 6 — Engagement**

- Weekly cron: trending public books, prefs-gated
- Monthly cron: prior-month create/complete/likes aggregates, empty skip
- Admin announcements: super-admin only, `dryRun` support, prefs-gated audience

**Open questions:** all product decisions locked to recommendations (see §5).

---

## 4. Phased roadmap (status)

| Phase | Status |
|-------|--------|
| 0 Hygiene / welcome | ✅ |
| 1 Security emails | ✅ |
| 2 Welcome wiring | ✅ |
| 3 Billing complements | ✅ |
| 4 Ops + non-blocking send | ✅ (bounce webhooks still open) |
| 5 Preferences foundation + UIX | ✅ |
| 6 Engagement suite | ✅ v1 (no ML ranking, no send-log table) |

### Run commands

```bash
pnpm db:migrate                    # apply email_preferences column
pnpm dev:cron:email-weekly
pnpm dev:cron:email-monthly
# Super-admin:
# POST /api/admin/email/announcements
# { "title", "bodyHtml", "cta"?, "dryRun"? }
```

---

## 5. Open questions (decided)

| Q | Decision | Implemented as |
|---|----------|----------------|
| **Q1** Welcome when? | Onboarding `isNewUser`→false | POST /user |
| **Q2** Security detail | Timestamp + IP + UA | `formatSecurityDetailHtml` |
| **Q3** Email change | Soft update + verify new + alert old | PUT /auth/email |
| **Q4** Pack receipts | Stripe for card; no duplicate Twistloom receipt | — |
| **Q5** Feedback ack | Always send | POST feedbacks |
| **Q6** Internal feedback | Email to `FEEDBACK_INBOX` | Optional env |
| **Q7** Trial ending | Dual Stripe + Twistloom | keep both |
| **Q8** Prefs timing | Before engagement (Phase 5) | done |
| **Q9** OTP strength | Keep 6-digit + rate limits | unchanged |
| **Q10** Engagement suite | All three | weekly + monthly + announce |
| **Q11** Default opt-in | Opt-out after onboarding | DEFAULT_EMAIL_PREFERENCES all true |
| **Q12** Weekly time | Fixed UTC cron (ops schedule) | cron scripts |
| **Q13** Who announces | Super-admin only | requireSuperAdmin |
| **Q14** Toggle save | Optimistic PATCH per flag | useEmailPreferences |
| **Q15** Deep link | `?tab=notifications` | Preferences client |

---

## 6. Remaining / future

| Item | Priority | Notes |
|------|----------|-------|
| Resend bounce/complaint webhooks + suppression | P2 | Domain reputation |
| Template i18n (`en`/`id`) | P3 | UI already bilingual |
| Send log / period idempotency table | P3 | Safer cron retries |
| Richer weekly ranking (affinity) | P3 | v1 = trending only |
| Admin UI for announcements (frontend) | P3 | API ready |
| In-app notification prefs API | P3 | Still local stub |

---

## 7. File touch map

### Backend

| Area | Files |
|------|--------|
| Templates | `src/config/emails/*` |
| Send | `src/utils/email.ts` |
| Prefs | `src/services/email-preferences.ts`, `src/types/email-preferences.ts` |
| Schema | `src/db/schema.ts` · `drizzle/0038_spooky_raider.sql` |
| Auth | `src/routes/auth.ts` |
| User | `src/routes/user.ts` |
| Email public | `src/routes/email.ts` |
| Payments | `src/routes/payments.ts` |
| Subscription | `src/services/subscription.ts` |
| Admin announce | `src/routes/admin.ts` |
| Crons | `src/cron/email-weekly-recommendations.ts`, `email-monthly-summary.ts` |
| Scripts | `package.json` `dev:cron:email-*` / `start:cron:email-*` |

### Frontend

| Area | Files |
|------|--------|
| Preferences UIX | `DashboardAccountPreferencesClient.tsx` |
| Hook | `useEmailPreferences.ts` |
| API | `users-api.ts` · types in `api/user.ts` |
| Unsubscribe | `app/[locale]/email/unsubscribe/page.tsx` |
| i18n | `messages/en.json`, `id.json` |

---

*Update this doc only when shipping remaining items in §6 or changing product decisions.*
