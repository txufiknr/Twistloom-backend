# Twistloom AI Provider Config Audit — `ai-clients.config.ts`

Fact-check of `AI_RATE_LIMITS` and `AI_MAX_PROMPT_LENGTH` for the **existing
7 providers** (github, gemini, cohere, mistral, groq, cerebras, nvidia),
verified against provider documentation and 2026 reporting as of June 2026.

**Read this before relying on Phase 1 (`canUseAIToday`) from the previous
roadmap.** That phase makes the daily-quota gate *active* — which means any
provider where the configured `rpd` is too high (relative to the real limit)
will now silently keep getting tried well past its actual daily ceiling,
producing repeated 429s instead of a clean skip. Several providers below fall
into exactly that trap.

## TL;DR — severity ranking

| # | Provider | Issue | Severity |
|---|---|---|---|
| 1 | **Cohere** | Configured `rpd: 10_000`; trial keys are documented at **1,000 calls/month** (~33/day) | 🔴 Critical — ~300x overestimate |
| 2 | **Groq** | 3 of 4 models in `AI_CHAT_MODELS_WRITING.groq` are **deprecated/removed** (`mixtral-8x7b-32768`, `gemma2-9b-it`, `deepseek-r1-distill-llama-70b`) | 🔴 Critical — fallback chain is mostly dead |
| 3 | **Cerebras** | The *only* configured model (`llama-3.3-70b`) was reportedly **scheduled for deprecation Feb 16, 2026** — already past | 🔴 Critical — possible total provider failure |
| 4 | **Gemini** | Google cut free-tier quotas **50–80% in Dec 2025**; `rpd: 1_500` likely overestimates `gemini-2.5-flash` by ~6x | 🟠 High |
| 5 | **Groq** (rate limits) | `rpd: 14_400` may now be `1_000` for `llama-3.3-70b-versatile` per recent (June 2026) reporting | 🟠 High |
| 6 | **Mistral / Cerebras / NVIDIA** | `rpd` values look like `rpm × 1440` placeholders, not real published daily caps — real ceilings are **token-budget-based** (monthly/daily token caps), which `canUseAIToday` doesn't track at all | 🟡 Medium (structural) |
| 7 | **GitHub** | `rpm: 15` vs documented `10` for GPT-4o ("High" tier); `rpd: 150` matches gpt-4o-**mini**, not gpt-4o (the first model tried) | 🟡 Medium |
| 8 | **Gemini** | `gemini-1.5-flash-8b` (used in `AI_CHAT_MODELS_THEME`) is on Google's deprecation track | 🟡 Medium |

---

## 1. Cohere — 🔴 most urgent

```ts
// Current
cohere: { rpm: 100, rpd: 10_000 },
```

Cohere's own developer docs state plainly:

> Trial keys (and prod keys on newer Chat model variants) are limited to
> **1,000 API calls a month**.

1,000/month is roughly **33/day** — `rpd: 10_000` is off by close to **300x**.
The `rpm: 100` figure may still be approximately right for short bursts (it's
a separate, older-style limit), but the binding constraint by far is the
monthly total, which:

- resets **monthly**, not daily — the entire `canUseAIToday`/`usage`-table
  daily-reset model doesn't represent this correctly
- applies to **trial keys generally**, and the doc's "newer Chat model
  variants" caveat means it's worth confirming whether `command-r-08-2024`
  (your configured model) is subject to the 1,000/month cap or an older,
  looser limit

**Action:**
1. Check `dashboard.cohere.com/api-keys` → your trial key's usage page for
   the actual current monthly cap and remaining quota.
2. If 1,000/month is confirmed, treat Cohere as a **scarce, last-resort**
   fallback rather than a workhorse — at ~33/day average you'll want to
   reserve it for high-value tasks (e.g. final evaluation pass) rather than
   routine generation.
3. Interim config (until you build monthly tracking — see structural note
   below):

```ts
// Conservative interim — approximates the monthly cap spread evenly.
// This is still imperfect: a burst of 33 calls on day 1 exhausts the
// *entire month*, not just "today". True enforcement requires a monthly
// counter, not a daily one.
cohere: { rpm: 100, rpd: 33 },
```

`AI_MAX_PROMPT_LENGTH.cohere = 500_000` (≈128K tokens) is **accurate** —
Command R 08-2024's 128K context window is well-documented and stable. No
change needed there.

---

## 2. Groq — 🔴 dead models in the fallback chain

### 2a. Model roster

```ts
// Current — AI_CHAT_MODELS_WRITING.groq
groq: [
  'llama-3.3-70b-versatile',       // ✅ still active
  'deepseek-r1-distill-llama-70b', // ❌ deprecated Sept 2, 2025
  'mixtral-8x7b-32768',            // ❌ deprecated March 5, 2025
  'gemma2-9b-it',                  // ❌ deprecated Aug 8, 2025
],
```

Per Groq's own [deprecations page](https://console.groq.com/docs/deprecations),
**three of your four configured Groq models no longer exist**. Calls to them
will fail immediately with a model-not-found error, burning a step in your
fallback loop every single time Groq is tried with those models. In practice,
your "4-model Groq fallback" has been a **1-model fallback** for months.

Groq's own recommended replacements:

```ts
// Suggested replacement
groq: [
  'llama-3.3-70b-versatile',  // Cinematic, fast-paced action, snappy dialogue.
  'openai/gpt-oss-120b',      // Groq's recommended replacement for deepseek-r1-distill-llama-70b — strong reasoning/structure.
  'llama-3.1-8b-instant',     // Groq's recommended replacement for gemma2-9b-it — fast, distinct voice for erratic/poetic internal monologue.
],
```

> Verify these two replacement IDs are callable on your account at
> [console.groq.com/docs/models](https://console.groq.com/docs/models) before
> shipping — Groq's catalog continues to evolve and `openai/gpt-oss-120b` in
> particular may have its own rate-limit tier (see below).

### 2b. Rate limits

```ts
// Current
groq: { rpm: 30, rpd: 14_400 },
```

`rpm: 30` is consistently reported as correct for the free tier. `rpd` is
murkier — multiple April-2026 sources report `14,400 RPD` as the longstanding
free-tier default, but at least one source dated **June 4, 2026** reports
`llama-3.3-70b-versatile` specifically now at **1,000 RPD / 12K TPM / 100K
TPD** — a 14x cut from the older number. Given Groq publishes limits
**per-model**, and your `RateLimiter` applies one `rpd` to the whole provider
regardless of which of the (now 3) models gets selected, this single number
was always an approximation — but if the June figure is accurate for your
account, `14_400` is now wildly optimistic.

**Action:** check `console.groq.com/settings/limits` directly — it shows
your account's *actual current* per-model RPM/RPD/TPM/TPD, which is the only
authoritative source (Groq explicitly says published numbers are "high level
... there may be exceptions"). If `llama-3.3-70b-versatile` shows `1,000`
RPD, update to:

```ts
groq: { rpm: 30, rpd: 1_000 },
```

`AI_MAX_PROMPT_LENGTH.groq = 24_000` (6K tokens) matches the *older* 6K TPM
figure. If your account shows the newer 12K TPM for `llama-3.3-70b-versatile`,
you could raise this to `~48_000` — but also note the **100K TPD** (tokens
per day) cap is a *new* dimension this config doesn't track at all (see
structural note below). At 100K TPD, even a handful of near-max-length
requests exhausts the day's token budget well before 1,000 RPD would.

---

## 3. Cerebras — 🔴 possible total failure of the only configured model

```ts
// Current — both AI_CHAT_MODELS_WRITING.cerebras and AI_CHAT_MODELS_THEME.cerebras
cerebras: [
  'llama-3.3-70b', // Instantaneous generation. Action-oriented, direct, punchy pulp fiction.
],
```

This is your **only** Cerebras model in **both** the writing and theme
fallback maps. At least one March 2026 source reports `llama-3.3-70b` (along
with `qwen-3-32b`) was **"scheduled for deprecation on February 16, 2026"** —
a date that has already passed as of today (June 16, 2026). If that
deprecation went through as scheduled, **every Cerebras call in your fallback
chain has been failing for four months**, silently, with `aiPrompt` just
falling through to the next provider each time.

**Action — verify immediately** at `cloud.cerebras.ai` whether
`llama-3.3-70b` still resolves. If it's gone, Cerebras's own recommended
production models are `llama3.1-8b` (`llama3.1-8b`) and `gpt-oss-120b`:

```ts
// Suggested replacement if llama-3.3-70b is confirmed dead
cerebras: [
  'gpt-oss-120b',  // Production model, strong general quality
  'llama3.1-8b',   // Fast, punchy — closest in spirit to the old llama-3.3-70b pick
],
```

### Rate limits & prompt length

```ts
// Current
cerebras: { rpm: 30, rpd: 14_400 },
```
```ts
// AI_MAX_PROMPT_LENGTH
cerebras: 32_000, // 8K Tokens
```

`rpm: 30` ✅ and the **8,192-token context cap → 32,000 chars** ✅ are both
accurate per Cerebras's documentation — no change needed for either of those.

`rpd: 14_400` is the same pattern as Groq/Mistral: Cerebras's real free-tier
ceiling is **1,000,000 tokens/day**, not a request count. At your configured
`32_000`-char (~8K token) max prompt length, the token budget alone caps you
at roughly `1,000,000 / 8,000 ≈ 125` max-size requests/day — nowhere near
`14,400`. The request-count `rpd` will essentially never be the binding
constraint; the unrepresented token budget will bind first. See the
structural note below.

---

## 4. Gemini — 🟠 likely overestimated after Dec 2025 cuts

```ts
// Current
gemini: { rpm: 15, rpd: 1_500 },
```

Multiple independent sources (Jan, March, May 2026) consistently report that
**Google cut Gemini API free-tier quotas by 50–80% on December 7, 2025**.
Post-cut, the commonly reported numbers for the non-preview workhorse model
are:

- `gemini-2.5-flash`: **10 RPM / 250 RPD** (down from the old 15 RPM / 1,500 RPD — which is exactly your current config)
- `gemini-2.5-flash-lite`: 15 RPM / 1,000 RPD
- `gemini-2.5-pro`: 5 RPM / 50–100 RPD (one source says moved fully behind billing as of May 2026)

Your config's `{ rpm: 15, rpd: 1_500 }` matches the **pre-cut** numbers almost
exactly — a strong signal it hasn't been updated since the cut.

The complication: `gemini-3-flash-preview` is the **first** model in every
one of your fallback arrays (`AI_CHAT_MODELS_WRITING`, `_THEME`,
`_TRANSLATION`, `_EVALUATION`), and one (less corroborated) source claims
Gemini 3 Flash specifically gets **10 RPM / 1,500 RPD** on the free tier —
closer to your current config. But:

- it's a **preview** model — preview-model quotas are documented as separate
  from GA quotas and can change without the same notice as GA models
- if `gemini-3-flash-preview` ever loses preview status and gets a new GA
  model ID (common Google pattern), your hardcoded string stops resolving
  entirely, and `aiPrompt` would silently fall through to `gemini-2.5-flash`
  — which **is** subject to the tighter post-cut limits

**Action:** check your project's actual limits in AI Studio (Settings →
Usage). Given the uncertainty, a defensible interim config that's correct for
the *fallback* model even if the preview model is currently more generous:

```ts
gemini: { rpm: 10, rpd: 250 },
```

This is conservative for `gemini-3-flash-preview` (if its 1,500 RPD claim is
true, you'll under-use it slightly) but **correct** for `gemini-2.5-flash`
once the preview model is exhausted or deprecated — which matters a lot once
`canUseAIToday` is active, since an over-generous `rpd` here means Gemini
keeps getting tried (and 429ing) long after the real per-model quota for
whichever model actually answers is gone.

`AI_MAX_PROMPT_LENGTH.gemini = 3_600_000` (1M tokens) — the 1M-token context
window is well-documented and stable for the 2.5 Flash/Pro family and is very
likely unchanged for Gemini 3 Flash too. **No change recommended**, though if
you want to be extra careful, confirm `gemini-3-flash-preview`'s context
window specifically (preview models occasionally ship with reduced windows
during the preview period).

### Also: `gemini-1.5-flash-8b`

```ts
// AI_CHAT_MODELS_THEME.gemini
gemini: [
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-1.5-flash-8b' // <- check this
],
```

The Gemini 1.5 series has been on Google's deprecation track for a while now.
By June 2026 it's plausible `gemini-1.5-flash-8b` is no longer callable for
new projects. As a last entry in a 4-model fallback it's low-risk even if
dead (you'd just fall through), but it's worth swapping for a second
`gemini-2.5-flash-lite`-class entry or `gemini-2.0-flash` if you want that
4th slot to actually do something.

---

## 5. Mistral — 🟡 structural mismatch, context window unverified

```ts
// Current
mistral: { rpm: 60, rpd: 86_400 },
```
```ts
// AI_MAX_PROMPT_LENGTH
mistral: 1_000_000, // 256K Tokens
```

`rpm: 60` (≈ 1 req/sec) matches Mistral's documented free "Experiment" tier
exactly — ✅ accurate, no change.

`rpd: 86_400` is `60 × 1440` — i.e., "what if you sustained 1 req/sec for a
full day." Mistral doesn't publish a request-based daily cap; the real
free-tier ceiling is **~1 billion tokens/month**. At your configured
1,000,000-char (~250K token) max prompt length, even a small number of
near-max requests per day would burn through the monthly token budget long
before 86,400 requests/day became relevant. This `rpd` value is **not wrong
exactly — it's just never going to be the thing that stops you**, which means
`canUseAIToday` provides no real protection for Mistral. See the structural
note below.

**Context window — please verify before relying on it.** The 256K figure in
your comment couldn't be confirmed in current sources; Mistral Large 2
(`mistral-large-2407`, the lineage `mistral-large-latest` has historically
pointed to) has been documented at **128K context** in multiple places, and
the only 2026 figure I could confirm directly was Pixtral Large at 128K. If
`mistral-large-latest` is still 128K rather than 256K, your
`AI_MAX_PROMPT_LENGTH.mistral = 1_000_000` is **2x too generous** — a prompt
near that ceiling would get a `400 Bad Request` for exceeding context, not a
graceful fallback. Check the current model card at
`console.mistral.ai` or `docs.mistral.ai/getting-started/models` for
whatever model ID `mistral-large-latest` currently aliases to.

```ts
// If mistral-large-latest is confirmed at 128K (not 256K):
mistral: 500_000, // 128K Tokens
```

---

## 6. NVIDIA NIM — 🟡 RPM solid, RPD and "free tier" type both unclear

```ts
// Current
nvidia: { rpm: 40, rpd: 57_600 },
```
```ts
// AI_MAX_PROMPT_LENGTH
nvidia: 480_000, // 128K Tokens
```

`rpm: 40` ✅ — this is the consistently reported default for NVIDIA's
developer tier. `AI_MAX_PROMPT_LENGTH` at 128K (480,000 chars) is also
accurate and stable for the Llama 3.3 70B / Qwen 2.5 72B-class models you've
configured.

`rpd: 57_600` is, again, `40 × 1440` — a theoretical ceiling, not a number
NVIDIA publishes anywhere. More importantly, there's real ambiguity in
current reporting about **what kind of "free" this even is**:

- One framing: a renewable **40 RPM** rate limit, indefinitely — which is
  what your `rpd`-based config assumes (a generous daily allowance derived
  from a per-minute rate)
- Another framing: a **finite credit pool** — 1,000 inference credits on
  signup, up to 5,000 total on request, that does **not** renew

These are fundamentally different for "perpetual free fallback" planning. If
your account is on the credit-based model, `rpd: 57_600` is meaningless — the
real constraint is "how many credits do you have left, total, ever," which
`canUseAIToday`'s daily-reset model can't represent at all.

**Action:** check the usage/credits panel at `build.nvidia.com` for your
account specifically — NVIDIA states the per-account limit is visible there
and is the only authoritative source. If you're on the credit-based plan,
treat NVIDIA NIM the same way as the one-time-credit providers from the
OpenRouter/Cloudflare roadmap (DeepSeek, Nscale, etc.) — useful capacity that
depletes, not a renewable daily quota.

Also worth a quick check: `mistralai/mixtral-8x22b-instruct-v0.1` is in your
`AI_CHAT_MODELS_WRITING.nvidia` list. Given Mixtral variants have been
deprecated across multiple providers (Groq removed `mixtral-8x7b-32768` in
March 2025), confirm this NVIDIA-hosted Mixtral variant is still in the NIM
catalog at `build.nvidia.com`.

---

## 7. GitHub Models — 🟡 minor, but the binding model is tighter than configured

```ts
// Current
github: { rpm: 15, rpd: 150 },
```
```ts
// AI_CHAT_MODELS_OPENAI
export const AI_CHAT_MODELS_OPENAI: AIModelSelection = {
  github: ['openai/gpt-4o', 'openai/gpt-4o-mini']
};
```

GitHub Models documents per-model "rate limit tiers." For `gpt-4o`
("High" tier — the **first** model in your list, tried first every time):

- **10 RPM, 50 RPD, 8,000 input / 4,000 output tokens**

For `gpt-4o-mini` ("Low" tier): **150 RPD** is the commonly cited number —
which matches your configured `rpd: 150` suspiciously well, suggesting the
config may have been written against gpt-4o-mini's limits rather than
gpt-4o's, even though gpt-4o is tried first.

Since `RateLimiter` applies one `rpm`/`rpd` to the whole `github` provider
regardless of which of the two models is currently being attempted, and
`gpt-4o` (the tighter one) is tried first, the realistic binding constraint
for most of your GitHub traffic is **10 RPM / 50 RPD**, not 15/150.

```ts
// Suggested
github: { rpm: 10, rpd: 50 },
```

`AI_MAX_PROMPT_LENGTH.github = 30_000` (≈8K tokens) lines up well with
gpt-4o's documented 8,000-input-token limit — ✅ accurate, no change needed.

One more wrinkle worth noting: GitHub's docs explicitly say Copilot
Business/Enterprise accounts get higher limits than the figures above. If the
`GITHUB_API_KEY` you're using belongs to such an account, the tighter numbers
above may be unnecessarily conservative — but `{ rpm: 10, rpd: 50 }` is the
safe default for a standard/free GitHub account.

---

## Structural note: "request-budget" vs. "token-budget" providers

Across this audit, **Cohere, Mistral, Groq, Cerebras, and possibly NVIDIA**
all have a real free-tier ceiling that is expressed in **tokens** (per
minute, per day, or per month) rather than (or in addition to) a clean
**requests-per-day** number. Your current architecture — `AI_RATE_LIMITS`
as `{ rpm, rpd }`, enforced via `RateLimiter.throttle()` (RPM) and (once
Phase 1 lands) `canUseAIToday()` (RPD) — has no representation for a token
budget at all.

The practical effect: for these providers, a request-count-based `rpd`
either (a) is set so high it never binds, while the real token budget gets
exhausted first and produces 429s `canUseAIToday` won't predict, or (b), if
set conservatively low to *approximate* the token budget (like the Cohere
interim fix above), it's still wrong in the opposite direction — a single
oversized request can blow the "budget" that a request-count number can't
capture.

This isn't something you need to fix today, but it's worth flagging as a
**future structural improvement**: extending `AI_RATE_LIMITS` with an
optional `tpd` (tokens per day) or `tpm` (tokens per minute) field, and having
`incrementDailyUsageCount` / `canUseAIToday` track *estimated tokens consumed*
(you already compute `estimateTokens(promptChars)` for telemetry in the
streaming path) rather than only request counts. That would make the daily
gate meaningful for Cohere, Mistral, Groq, Cerebras, and NVIDIA — the five
providers where "requests per day" isn't actually the real constraint.

---

## Suggested verification order

Given limited time, prioritize in this order — roughly severity-weighted and
"things that are currently silently broken" first:

1. **Cerebras**: is `llama-3.3-70b` still callable? (possible total provider
   outage in your fallback chain)
2. **Groq**: confirm `llama-3.3-70b-versatile` still works (it should — only
   the *other three* models are the problem) and replace the three dead
   model IDs
3. **Cohere**: check your trial key's actual monthly quota at
   `dashboard.cohere.com/api-keys`
4. **Gemini**: check current per-model RPM/RPD in AI Studio, especially for
   `gemini-3-flash-preview` vs `gemini-2.5-flash`
5. **Mistral**: confirm `mistral-large-latest`'s actual context window
6. **GitHub / NVIDIA**: lower-urgency tightening, mostly affects how quickly
   `canUseAIToday` correctly skips an exhausted provider
