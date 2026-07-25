# Email Internationalization (i18n) Roadmap

**Status:** ✅ Implemented (C+D hybrid) — Jul 2026  
**Depends on:** Transactional email stack ([TRANSACTIONAL_EMAILS.md](../architecture/TRANSACTIONAL_EMAILS.md))  
**UI locales:** `en`, `id`  
**Model:** `preferredLocale` (account) + optional `emailLocale` override (`null` = same as app)  
**Last reviewed:** Jul 2026

---

## Decision (locked)

| Item | Choice |
|------|--------|
| Architecture | **Option C + light D** |
| Account language | `users.preferred_locale` default `en` |
| Email override | `email_preferences.emailLocale`: `en` \| `id` \| `null` |
| Resolve order | explicit → `emailLocale` → `preferredLocale` → `en` |
| UI language sync | Fire-and-forget `PATCH /user/preferred-locale` on Appearance language change |
| Onboarding | `POST /user` accepts `preferredLocale` from UI cookie |
| Catalogs | `src/config/emails/locales/en.json` + `id.json` via `t(locale, key, vars)` |
| Ops mail | Internal feedback stays **English** |

---

## Implementation CHANGELOG

### Jul 2026 — shipped

**Backend**

- Migration `0039_bumpy_sally_floyd.sql`: `users.preferred_locale`
- Types: `email-locale.ts`, extended `EmailPreferences` with `emailLocale`
- `resolveEmailLocale` / `resolveEmailLocaleByEmail` / `updatePreferredLocale`
- `src/config/emails/i18n.ts` + full EN/ID catalogs
- All user-facing templates take `locale` first; `email.ts` resolves locale per send
- Routes: `PATCH /user/preferred-locale`, onboarding + email prefs accept locale fields
- GET `/user` includes `preferredLocale` (enriched select)

**Frontend**

- Appearance language → navigate + fire-and-forget preferredLocale PATCH
- Email card: language select (Same as app / en / id)
- Onboarding sends `preferredLocale` from `useLocale()`
- Types + `UsersApi.updatePreferredLocale`

**Docs**

- This roadmap marked complete; architecture doc updated

---

## How it works

```text
Cookie preferred-language ──fire-and-forget PATCH──► preferredLocale
Email prefs select ──PATCH email-preferences───────► emailLocale (nullable)
                                                              │
                         resolveEmailLocale(userId) ◄──────────┘
                              = emailLocale ?? preferredLocale ?? 'en'
                                                              │
                         t(locale, key) + templates ──────────┘
```

---

## Runbook

```bash
pnpm db:migrate   # preferred_locale column
```

**API**

| Method | Path | Body |
|--------|------|------|
| PATCH | `/user/preferred-locale` | `{ preferredLocale: "en" \| "id" }` |
| PATCH | `/user/email-preferences` | `{ emailLocale: "en" \| "id" \| null, ...toggles }` |
| GET | `/user/email-preferences` | includes `emailLocale` |
| GET | `/user` | includes `preferredLocale` |

---

## Remaining / optional

| Item | Priority |
|------|----------|
| Force UI from backend on multi-device mismatch | P3 |
| Crowdin / more locales | P3 |
| Snapshot tests per locale | P3 |
| Professional ID copy review for engagement noir | P2 |

---

*Implementation complete for v1 en/id. Extend catalogs when adding locales.*

---

## Table of contents

1. [Current state (confirmed)](#1-current-state-confirmed)
2. [The problem](#2-the-problem)
3. [How established products handle email language](#3-how-established-products-handle-email-language)
4. [Options for Twistloom](#4-options-for-twistloom)
5. [Recommendation](#5-recommendation)
6. [Target design](#6-target-design)
7. [Phased implementation](#7-phased-implementation)
8. [Copy & noir voice under i18n](#8-copy--noir-voice-under-i18n)
9. [Open questions](#9-open-questions)
10. [Success criteria](#10-success-criteria)
11. [Out of scope](#11-out-of-scope)

---

## 1. Current state (confirmed)

### 1.1 Frontend (`twistloom-web`) — locale is **client-local**, not on the user profile

| Mechanism | Detail |
|-----------|--------|
| Library | `next-intl` |
| Supported locales | `en`, `id` (`LOCALES` in `src/lib/config/i18n.ts`) |
| Persistence | Cookie **`preferred-language`** (`LOCALE_COOKIE_NAME`) — 1 year, path `/` |
| Negotiation order | URL prefix → cookie → browser `Accept-Language` → default `en` |
| Preferences UI | Dashboard → Appearance → language select calls `router.replace(pathname, { locale })` — **does not call the backend** |
| Backend user row | **No** `preferredLocale` / `uiLanguage` / similar on `users` |

**Conclusion:** Your memory is correct. UI language lives in a **browser cookie** (and URL). It is **not** stored in Twistloom’s API database. Server-side email jobs (webhooks, crons) **cannot** read that cookie.

### 1.2 Backend (`twistloom-backend`) — language signals exist, but not for UI/email

| Signal | Purpose | Usable for email? |
|--------|---------|-------------------|
| `Accept-Language` → `headerLanguage` middleware | Book/page **content translation** at request time | Only on interactive HTTP calls, not crons/webhooks |
| `books.language`, `story_prompts.language` | Content locale of a story | Not the user’s UI preference |
| `users.email_preferences` | Engagement opt-in flags | No locale field |
| Email templates (`src/config/emails/*`) | Hardcoded **English** strings | — |

### 1.3 Email stack today

- Subjects + HTML bodies are English string literals inside template functions.
- Dates use `toLocaleDateString('en-US', …)` in a few templates.
- No message catalogs, no `locale` parameter on `send*Email`, no per-user language column.

---

## 2. The problem

| Scenario | What happens today | What users expect |
|----------|-------------------|-------------------|
| Indonesian user sets UI to `id` | App is Indonesian; **emails stay English** | Security + product mail in Indonesian |
| Stripe webhook / weekly cron | No browser, no cookie | Need a **server-side SSOT** for locale |
| User changes language on phone only | Cookie updates; backend never learns | Email language should follow (or be independently set) |
| Guest / multi-device | Each device has its own cookie | Account-level preference is safer for email |

**Bottom line:** Email i18n **requires a backend-stored preferred locale** (or an equivalent server-readable source). Relying only on the frontend cookie is **not enough** for Twistloom’s architecture (serverless + webhooks + crons).

---

## 3. How established products handle email language

Patterns below are industry-common (Wattpad-class consumer apps, creative tools like Suno, Spotify, Notion, Duolingo, Reddit, etc.). Exact internal implementations vary; the **product patterns** are stable.

### 3.1 Pattern matrix

| Product class | Typical approach | Notes |
|---------------|------------------|--------|
| **Wattpad / Webtoon / fanfic apps** | Account **language / region** setting (profile or settings) separate from story language; marketing + transactional mail follow **account language** | Story content language ≠ UI language is normal |
| **Suno / Midjourney / creative AI** | App UI language + account locale; system emails follow **account/app language**; often fewer locales than UI | Security mail always localized when UI is |
| **Spotify / Netflix** | Strong **account language** (and region); emails match account, not “last browser cookie” alone | Cookie may bootstrap account language at signup |
| **Notion / Linear / B2B SaaS** | Workspace or user **language preference** stored server-side; email templates from i18n catalogs | Often start with 2–5 locales |
| **Duolingo / language apps** | Explicit UI language on account; email fully catalog-driven | Highest investment in i18n |
| **Stripe / banks** | Transactional mail often follows **billing country / dashboard language**; very conservative copy | Clarity > brand voice |

### 3.2 Shared industry principles

1. **Server-side language of record** — Email senders never depend on browser cookies alone.  
2. **Separate “content language” from “UI/email language”** — A user can write English thrillers and still want Indonesian emails (or the reverse).  
3. **Bootstrap from UI at signup / first preference change** — Cookie or `Accept-Language` seeds the account field once.  
4. **User-visible control** — Settings toggle for “Email / app language” (sometimes the same control as UI).  
5. **Safe fallback** — Unknown locale → default (`en`); never fail the send.  
6. **Security mail always localized** when catalogs exist — Users under attack must understand the message.  
7. **Marketing/engagement can lag** — Some products ship security i18n first, digests later.  
8. **Legal/billing** — Refunds, payment failed: localized + plain facts (matches our Tier A/B voice rules).

### 3.3 What they *don’t* do

| Anti-pattern | Why it fails |
|--------------|--------------|
| Infer email language only from `Accept-Language` on every API call | Cron/webhook has no reliable header; bots vary |
| Translate emails with live LLM on each send | Cost, latency, brand/voice drift, security risk |
| One English template forever for ID market | Churn + support load in Indonesia |
| Couple email language to `books.language` of last read book | Oscillates; wrong for multi-language readers |

---

## 4. Options for Twistloom

### Option A — Frontend cookie only (status quo + hope)

Pass `preferred-language` cookie on API requests; backend reads it for interactive sends only.

| Pros | Cons |
|------|------|
| No schema change | **Crons/webhooks still English** |
| Quick for password reset while user is logged in | Cookie not sent cross-site to API unless carefully configured |
| | Multi-device inconsistency |

**Verdict:** Insufficient as sole solution.

### Option B — `Accept-Language` only

| Pros | Cons |
|------|------|
| Already parsed as `headerLanguage` | Same cron/webhook gap |
| | Browser language ≠ chosen UI language (user picked `id` while OS is `en`) |

**Verdict:** Good **bootstrap**, bad SSOT.

### Option C — Backend `users.preferredLocale` (recommended core)

Persist `en` | `id` (extensible) on the user row. All `send*Email` resolve locale from this field.

| Pros | Cons |
|------|------|
| Works for webhooks, crons, admin blasts | Schema + migration + sync from frontend |
| Clear SSOT; matches Spotify/Notion pattern | Must keep in sync when UI language changes |
| Can power future in-app defaults | |

### Option D — Separate “email language” vs “app language”

Two fields: `uiLocale` + `emailLocale`.

| Pros | Cons |
|------|------|
| Power-user flexibility | Extra UI complexity for little gain at 2 locales |
| | Support burden |

**Verdict:** Overkill for v1; revisit if users request it.

### Option E — ESP-side templates (Resend multi-language / external CMS)

Store translations in Resend or a CMS; backend only passes `locale` + variables.

| Pros | Cons |
|------|------|
| Non-dev copy edits | Diverges from code-reviewed noir voice |
| | Harder DRY with `buildEmailHtml` |
| | Another system to secure |

**Verdict:** Optional later; keep catalogs in-repo for v1 (brand control).

### Option F — Machine-translate at send time

| Pros | Cons |
|------|------|
| Infinite locales | Breaks noir consistency; unsafe for security wording; cost |

**Verdict:** Reject for product email.

---

## 5. Recommendation

### Best approach for Twistloom (aligned with Wattpad/Suno-class apps)

> **Store preferred locale on the user in the backend, bootstrap it from the frontend cookie / language picker, and render emails from locale-keyed catalogs with English fallback.**

```text
┌─────────────────┐     sync on login / language change      ┌──────────────────┐
│ preferred-language │ ───────────────────────────────────► │ users.preferredLocale │
│ cookie (UI)        │     PATCH /user or /user/locale        │ (email + future UI)│
└─────────────────┘                                         └─────────┬────────┘
                                                                      │
                         send*Email(userId) / send*Email(email, locale)
                                                                      ▼
                                                            catalogs en.json / id.json
                                                                      ▼
                                                                 Resend HTML
```

### Why this is best *here*

1. **Architecture fit** — Welcome, trial ending, weekly cron, refunds all run **without** a browser.  
2. **Matches your UI locales** — Start with `en` + `id` only; same set as `next-intl`.  
3. **Doesn’t fight the cookie** — Cookie remains source of truth for **web rendering**; backend field is source of truth for **email** (and optionally later for SSR defaults).  
4. **Industry-standard** — Account language for mail is what large consumer apps do.  
5. **Voice tiers preserved** — Security stays plain in each language; engagement noir is hand-translated, not machine-translated.  
6. **Low complexity** — One column, one sync path, message catalogs next to templates.

### Explicit non-recommendation

- Do **not** make email language depend only on `books.language` or last story language.  
- Do **not** block email i18n on full “move next-intl catalogs to backend.” Email catalogs can be **smaller and separate**.

---

## 6. Target design

### 6.1 Schema

```typescript
// users.preferred_locale  text  not null  default 'en'
// constrained to supported set: 'en' | 'id'
preferredLocale: text('preferred_locale').$type<SupportedEmailLocale>().notNull().default('en'),
```

Optional later: store inside `email_preferences` jsonb — **prefer a top-level column** so non-email features can reuse it without loading prefs.

### 6.2 Supported locales

```typescript
export const EMAIL_LOCALES = ['en', 'id'] as const;
export type EmailLocale = (typeof EMAIL_LOCALES)[number];
export const DEFAULT_EMAIL_LOCALE: EmailLocale = 'en';
```

Must stay in lockstep with frontend `LOCALES` (document in both repos).

### 6.3 Resolution order at send time

```text
1. Explicit locale argument (tests / admin preview)
2. users.preferredLocale (if valid)
3. DEFAULT_EMAIL_LOCALE ('en')
```

Never throw on missing translation key → fall back to English string + log once.

### 6.4 Catalog structure (backend)

Keep catalogs **in the backend repo** (email is server-owned):

```text
src/config/emails/
  locales/
    en.json      # flat or nested keys
    id.json
  i18n.ts        # t(locale, key, vars), formatDate(locale, date)
  *.ts           # templates call t() instead of English literals
```

Example keys:

```json
{
  "passwordChanged.subject": "Your {{appName}} password was changed",
  "passwordChanged.heading": "Password updated, {{name}}.",
  "weekly.subject": "This week's dossiers — {{appName}}",
  "weekly.heading": "We've been watching what you read, {{name}}."
}
```

Use a tiny interpolator (`{{name}}`) — no need for full ICU unless plurals get painful; for plurals prefer simple branches or `Intl.PluralRules`.

### 6.5 API / sync

| Endpoint | Behavior |
|----------|----------|
| `PATCH /user` or `PUT /user/locale` | Accept `preferredLocale: 'en' \| 'id'` |
| `GET /user` | Return `preferredLocale` so client can reconcile |
| Onboarding `POST /user` | Set from body `preferredLocale` if provided, else leave default |

**Frontend:** When language select changes (Preferences appearance), also:

```typescript
await usersApi.updatePreferredLocale(newLocale);
// then router.replace(..., { locale })
```

**Bootstrap (once):** On login / app shell mount, if `user.preferredLocale !== cookie`, either:

- **A (recommended):** Cookie wins for logged-in session → PATCH backend to cookie value (UI is what user last chose on this device), or  
- **B:** Backend wins → force next-intl to account locale (stricter multi-device consistency).

**Recommendation:** **B for email-critical consistency** after first explicit choice; **A only on first-ever account** when backend is still `en` default and cookie is `id`.

Practical hybrid:

```text
if (user.preferredLocale was never explicitly set) // e.g. null until first sync
  PATCH from cookie
else
  optional: show mismatch banner "Your account language is ID; this browser is EN"
```

v1 simpler path: **always PATCH backend when user changes language in Preferences** + **on onboarding complete send current cookie locale**. Accept that old sessions keep English until they change language once.

### 6.6 Sender API shape

```typescript
// Prefer userId-based helpers for authenticated lifecycle:
await sendPasswordChangedEmail({ userId, detailHtml });

// Or pass locale when only email is known:
await sendPasswordChangedEmail(email, name, detailHtml, locale);
```

Internal:

```typescript
const locale = await resolveEmailLocale(userId);
const html = getPasswordChangedTemplate(locale, APP_NAME, name, detailHtml);
```

### 6.7 Dates & numbers

Replace hardcoded `en-US` with:

```typescript
date.toLocaleDateString(locale === 'id' ? 'id-ID' : 'en-US', { ... });
```

### 6.8 Deep links

Keep paths locale-aware where the web app uses prefixes:

- `en`: `/dashboard/account/preferences?tab=notifications`  
- `id`: `/id/dashboard/account/preferences?tab=notifications`  

Build with `FRONTEND_URL` + locale prefix helper shared with unsubscribe links.

---

## 7. Phased implementation

### Phase 0 — Inventory (0.5 day)

- [ ] List every user-facing string in `src/config/emails/*` + subjects in `email.ts`
- [ ] Mark Tier A/B/C (security plain vs engagement noir) for translator notes
- [ ] Confirm `en` / `id` only for v1

### Phase 1 — Backend locale SSOT (1–2 days)

- [ ] Migration: `users.preferred_locale` default `'en'`
- [ ] Types + validation (`en` | `id` only)
- [ ] `GET /user` includes `preferredLocale`
- [ ] `PATCH` path (profile or dedicated) to update it
- [ ] `resolveEmailLocale(userId)` helper
- [ ] Onboarding: accept optional `preferredLocale` from client

### Phase 2 — Frontend sync (0.5–1 day)

- [ ] On language change in Preferences → API update then navigate
- [ ] On onboarding complete → send cookie locale
- [ ] Optional: after login, one-time sync if backend still default and cookie is `id`

### Phase 3 — Catalog extraction (2–4 days)

- [ ] `locales/en.json` — move all English strings (subjects + bodies + buttons)
- [ ] `locales/id.json` — professional translation (human, not raw MT for security)
- [ ] Templates take `locale` and use `t(locale, key, vars)`
- [ ] Date formatting helper
- [ ] English fallback + missing-key log

**Priority order for catalogs:**

1. Security (password/email change, reset, verify) — **highest**  
2. Billing (payment failed, refund, trial, cancel)  
3. Lifecycle (welcome, account deleted)  
4. Feedback ack  
5. Engagement (weekly, monthly, announcement chrome)

### Phase 4 — Wire all send paths (1 day)

- [ ] Auth, user, payments, subscription, crons, admin announcements resolve locale
- [ ] Unsubscribe / prefs pages: already next-intl; ensure email links use account locale prefix

### Phase 5 — QA & polish (1 day)

- [ ] Snapshot or golden HTML for `en` + `id` per template
- [ ] Manual Resend test to real inboxes
- [ ] Translator review for noir engagement tone in Indonesian

### Phase 6 — Optional later

- [ ] Unify app language: backend `preferredLocale` drives first paint (SSR)  
- [ ] More locales (`es`, …)  
- [ ] Crowdin/Lokalise for non-dev translation workflow  
- [ ] Separate email language setting (Option D)

---

## 8. Copy & noir voice under i18n

Follow [TRANSACTIONAL_EMAILS.md §3 Voice](../architecture/TRANSACTIONAL_EMAILS.md#3-voice--copy-guidelines):

| Tier | i18n note |
|------|-----------|
| **A Security / feedback** | Hire/translate for **clarity**; avoid idioms that don’t exist in ID |
| **B Billing / auth** | Keep facts literal; mild metaphor OK if it translates cleanly |
| **C Engagement** | Best-effort creative ID copy — not word-for-word English noir; preserve mood |

Provide translators a short **glossary**: dossier, trail, chapter, VIP, credits, Twistloom (brand untranslated).

---

## 9. Open questions

### Q1 — Should changing UI language always change email language?

| Option | Recommendation |
|--------|----------------|
| Always sync (same control) | **Yes for v1** — one “Language” control, less confusion |
| Independent email language | Later if users complain |

### Q2 — Backend wins vs cookie wins on mismatch?

| Option | Recommendation |
|--------|----------------|
| PATCH backend whenever Preferences language changes | **Yes** |
| Force UI to backend on every load | Optional Phase 6 |
| Silent cookie-only | No |

### Q3 — Default for existing users?

| Option | Recommendation |
|--------|----------------|
| All `en` until they change language once | **Yes** (safe, no wrong-language surprise) |
| Infer from last `Accept-Language` seen | Risky; skip |
| Infer from country / phone | No reliable signal |

### Q4 — Indonesian engagement copy: professional translator vs bilingual founder?

| Option | Recommendation |
|--------|----------------|
| Human review required for Tier A/B | **Yes** |
| Founder/community pass for Tier C | Acceptable for v1 |

### Q5 — Store locale in `email_preferences` jsonb?

| Option | Recommendation |
|--------|----------------|
| Top-level `preferred_locale` | **Yes** — reusable beyond email |
| Inside jsonb | No for v1 |

---

## 10. Success criteria

- [ ] User with `preferredLocale: 'id'` receives password-changed and weekly digest in Indonesian  
- [ ] User with `en` unchanged  
- [ ] Stripe refund webhook still sends correct language with no browser  
- [ ] Missing ID key falls back to English without failing the send  
- [ ] Language change in Preferences updates backend within same action  
- [ ] Architecture doc updated when catalogs land  

---

## 11. Out of scope

- RTL languages  
- Per-email-type language overrides  
- LLM auto-translation of templates  
- Localizing **admin-authored** announcement body (author writes language they want; chrome can still be localized)  
- Localizing internal `FEEDBACK_INBOX` ops emails (keep English for the team unless ops asks otherwise)  

---

## Appendix A — Why not “just read the cookie on the API”?

Even if every browser request sent `preferred-language`:

| Job | Has cookie? |
|-----|-------------|
| `PUT /auth/password` | Sometimes |
| `customer.subscription.trial_will_end` | **No** |
| `pnpm dev:cron:email-weekly` | **No** |
| `POST /admin/email/announcements` | **No** (batch) |

Hence **account-level locale is mandatory** for a complete solution.

## Appendix B — Minimal sync snippet (illustrative)

```typescript
// Frontend: on language select
async function handleLanguageChange(newLocale: Locale) {
  await usersApi.updatePreferredLocale(newLocale); // PATCH backend first
  router.replace(pathname, { locale: newLocale }); // then UI cookie + URL
}
```

```typescript
// Backend: resolve
async function resolveEmailLocale(userId: string): Promise<EmailLocale> {
  const [row] = await dbRead
    .select({ preferredLocale: users.preferredLocale })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1);
  return isEmailLocale(row?.preferredLocale) ? row.preferredLocale : DEFAULT_EMAIL_LOCALE;
}
```

---

*This roadmap is the SSOT for email language strategy. Implement after security/billing email stack is stable (already done); Phase 1–3 are the critical path.*
