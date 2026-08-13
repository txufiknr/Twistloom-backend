# Twistloom Prompt-Token Savings — Fact-Check & Roadmap

**Date:** August 12, 2026
**Scope:** Fact-checks Gemini's answer about Wexa.ai and its suggested free-tier alternatives, then lays out a roadmap grounded specifically in your actual `ai-chat.ts` / `ai-chat-stream.ts` code (the `geminiPrompt`/`geminiStreamGenerator` explicit-caching path, the `promptWithFallback` wrapper, and `formatSystemPromptWithDocuments` as the one place every provider's prompt gets assembled).

---

## Part 1 — Fact-Checking Gemini's Answer

Gemini's overall instinct — skip Wexa, use what your providers already give you for free, consider a caching proxy — is directionally reasonable. But several specific claims don't hold up, and one of them (Helicone's free-tier size) is off by 10x. Here's the point-by-point:

| Claim | Verdict | What's actually true |
|---|---|---|
| "Wexa has no free tier, no developer sandbox" | ❌ **Wrong** | Wexa's own pricing FAQ says plainly: *"Yes. You can start with our Free plan, which gives you access to core features."* |
| "Wexa is the wrong fit" | ✅ Right conclusion, wrong reason | Wexa isn't an enterprise-vs-indie pricing mismatch — it's a **different product category entirely**. It's an "AI Coworker" / business-process-automation platform that builds a context graph across Gmail, Slack, Salesforce, Jira, etc. It's not a prompt-token-compression SDK you'd call from inside a story-generation pipeline. The specific "200K→2,600 tokens" Graph RAG benchmark Gemini cited isn't something I could independently verify anywhere in Wexa's public materials — treat it as unconfirmed. |
| "Gemini context caching... completely free to implement... slashes input costs by 50-90%" | ⚠️ **Misleading** | The *cache read* is genuinely 90% cheaper. But explicit caching (what `getOrCreateGeminiCache` in your code actually uses) also bills a **separate hourly storage fee** — $1.00/1M tokens/hour on Flash models, $4.50/1M tokens/hour on Pro models — regardless of whether the cache gets read. This is the single biggest gap in Gemini's answer, and it's not a minor footnote — see Part 3 below for why. |
| "Anthropic (Prompt Caching) and OpenAI" support this too | ❌ **Not relevant to your stack** | Your waterfall doesn't include Anthropic or direct OpenAI at all (GitHub Models, which proxied `gpt-4o`, was fully retired July 30, 2026). Citing them as reasons to adopt caching in Twistloom is advice for a different codebase. |
| Helicone free tier: "100,000 requests per month" | ❌ **Wrong — it's 10,000** | Confirmed against two independent, detailed pricing breakdowns (both cross-checked against Helicone's own $79/mo Pro-tier figure): Free tier is 10,000 requests/month, 7-day retention, 1 seat. (One aggregator page did say 100K, but it's inconsistent with Helicone's own documented tier structure elsewhere — 10K is the number to plan around.) |
| Helicone caching = "semantic caching" that would serve Reader B the same page Reader A got | ⚠️ **Overstated** | What I found describes Helicone's caching as standard proxy-layer **exact-match** caching ("if the same prompt comes in again, it returns the cached response") — not fuzzy/semantic matching. Portkey is the one more consistently described as offering genuine semantic caching, and even there it's listed as a feature of Portkey's **paid** $49/mo tier, not the free Developer tier. More on why this distinction barely matters for your actual use case in Part 4. |
| Portkey free tier: "10,000 requests per month" | ✅ Confirmed accurate | Matches Portkey's own "Developer tier free forever" plan. |
| DIY Graph RAG via LlamaIndex/LangChain + pgvector | ✅ Reasonable, and partially moot | Correct that Neon supports `pgvector` natively — and worth knowing you likely already have vector-embedding infrastructure in play for Twistloom's memory system, so this wouldn't be starting from zero. Scoped as a Phase 3 idea below, not urgent. |

---

## Part 2 — What Your Providers Actually Offer (researched provider-by-provider, since Gemini only checked three)

This is the part Gemini's answer skipped almost entirely: **most of your 19 providers have some form of prompt caching, and most of it is free, automatic, and requires zero new tools** — just prompt discipline. Confirmed as of August 12, 2026:

| Provider | Caching type | Discount | Setup needed |
|---|---|---|---|
| **Gemini** | Explicit (what you use) + implicit (automatic, free, since May 2025) | 90% off cached reads | Explicit: what `getOrCreateGeminiCache` does. Implicit: nothing — but only helps if you're *not* forcing explicit caching for the same content |
| **Groq** | Automatic, exact-prefix-match | 50% off cached input tokens | **Zero code changes.** Works automatically on supported models as long as static content (system rules) comes before dynamic content (game state) in the prompt |
| **Mistral** | Explicit, via a `prompt_cache_key` parameter | 90% off cached tokens (10% of base price) | Requires passing `prompt_cache_key` in the request — worth checking whether your `mistralPrompt` implementation currently sets this |
| **Cerebras** | Native prompt caching (confirmed to exist; exact discount not published) | Unconfirmed % | Worth checking their docs directly for your specific models |
| **DeepSeek-family models** (reachable via OpenRouter/Chutes in your waterfall) | Automatic, exact-prefix-match | ~90% off cache hits | Nothing on your end — but OpenRouter's "sticky routing" (keeps repeat requests on the same backend to preserve the warm cache) is what actually makes this work reliably across calls |
| **Z.ai (GLM)** | Cached reads at ~20% of standard price | ~80% off | Automatic on supported tiers; moot for `glm-4.7-flash` specifically since that model is already $0 |
| **Cohere, NVIDIA, OVHcloud, SambaNova, Cloudflare Workers AI, and the rest of the newer 9** | Not confirmed | — | I could not find documented prompt-caching support for these in this pass — don't assume it exists |

**The one free, zero-risk action item that applies across your entire `formatSystemPromptWithDocuments` call site:** make sure every provider call places static content (system rules, character bible, world rules) *before* dynamic content (current game state, the reader's choice) in the assembled prompt, consistently. Every automatic caching scheme above (Groq, DeepSeek, implicit Gemini) depends on a stable *prefix* — if dynamic state gets interleaved early, you silently lose caching you'd otherwise get for free. Since `formatSystemPromptWithDocuments` is the one function every provider's prompt flows through, this is a single, one-time audit rather than 19 separate changes.

---

## Part 3 — The Math Gemini Skipped: Is Your Existing Gemini Caching Actually Saving You Money?

This is the most consequential finding in this whole document, and it's specific to code you already shipped.

Explicit caching (your `cachedContentId` → `getOrCreateGeminiCache` path) isn't a strict win — it's a bet. You pay the hourly storage fee *whether or not the cache gets read*. The break-even math, from a detailed cost analysis I cross-checked:

> Storing 1M tokens on Gemini 3.1 Pro for one hour costs $4.50 in storage alone — more than **two full fresh reads** of that same content at $2.00/read. Caching only pays off when the cached content gets read frequently within a short window. A cache that mostly sits idle is a meter running regardless.

Concretely, from a worked example in that analysis: a single low-volume user hitting a shared 50K-token context 15 times a day loses money on explicit caching — **it costs 88% more than not caching at all** — because the storage fee eats the whole day whether or not it's touched. The economics only flip positive once you have enough *concurrent* reads against the *same* cache within its lifetime — the same worked example shows a 10-concurrent-user scenario against shared context saving 63%, and a higher-volume scenario saving 85%.

**Why this matters specifically for Twistloom:** your caching is almost certainly scoped per-book (each story's system prompt + character bible + world rules cached once, reused across that book's readers/pages). Whether that's a net win depends entirely on **how many page-generation calls hit a given book's cache within roughly one storage-hour**, which is a question about your actual reader traffic, not your code. For a popular book with many concurrent readers, this is very likely a real win. For a slow-moving story with occasional solo readers, the storage fee may be quietly costing you more than it saves.

**Recommended action, not a code change:** pull your actual Gemini billing line-items for cache storage vs. cache-read savings over the last billing cycle (or instrument it — your `ai-cost.ts` already tracks `cachedTokens` in the usage extraction) and check the ratio. If storage cost is approaching or exceeding what the cached reads saved you, the fix isn't to abandon caching — it's to either (a) shorten the cache TTL so idle caches expire faster, or (b) restrict explicit caching to your genuinely high-traffic books and let low-traffic books fall through to Gemini's free automatic implicit caching instead (which has no storage fee, just no *guaranteed* discount either).

---

## Part 4 — The Recommendation Gemini Didn't Make: You Probably Don't Need Semantic Caching At All

Gemini's Helicone pitch was built around this scenario: *"Reader A clicks 'Open the basement door'... Reader B plays the same story and makes the exact same choice under the exact same game state... Helicone serves the cached page. You pay zero tokens."*

Read that scenario again: **it's an exact match, not a semantic one.** Same book, same page, same choice, same game-state flags. That's not a fuzzy-similarity problem that needs an embedding-based semantic cache — it's a deterministic cache-key problem: `hash(bookId + gameStateFingerprint + choiceId + model)` → cached page. A basic key-value cache (a table in the Neon Postgres you already run, or Vercel KV/Redis if you want it off your primary database) solves this completely, with:

- **No new vendor**, no new account, no new proxy in your request path
- **No added latency** from routing every single call through a third-party gateway
- **No per-request logging costs or free-tier ceiling** to eventually hit (Helicone's 10K/month, Portkey's 10K/month)
- **Full control** over the cache key shape, TTL, and invalidation (e.g., you'd want a way to bust the cache if you ever edit a book's already-published pages)

This is the kind of thing worth building as its own small module (something like `page-cache.ts`) that wraps whichever function currently orchestrates "generate the next page" — I don't have that orchestration file in front of me (only `ai-chat.ts` and `ai-chat-stream.ts`, which are one layer below that), so I've described the shape here rather than writing the drop-in code; happy to write the actual implementation if you share that file.

**Where a gateway like Helicone/Portkey/Cloudflare AI Gateway would still genuinely earn its place:** cross-provider *observability* (one dashboard instead of stitching together 19 providers' own consoles) and centralized rate limiting/fallback — not as your primary token-saving mechanism. See the roadmap below for where that fits.

---

## Part 5 — Roadmap

### Phase 0 — Free, zero new tools, do this first
1. **Audit prompt ordering** in `formatSystemPromptWithDocuments` — confirm static system/character/world content precedes dynamic game-state content, so Groq's and Gemini's *automatic* caching (both free, both already available to you) actually trigger.
2. **Check whether `mistralPrompt` sets `prompt_cache_key`.** If not, this is a small, low-risk change that unlocks a 90%-off cache-hit discount you may not currently be getting at all.
3. **Pull your real Gemini cache storage-vs-savings ratio** (Part 3) and decide per-book whether explicit caching is actually paying for itself, or whether some books should fall back to free implicit caching.

### Phase 1 — Small build, highest leverage for your actual use case
4. **Build the exact-match page cache** described in Part 4 — `hash(bookId + gameStateFingerprint + choiceId + model)` → cached generated page. This is the direct, correctly-scoped version of what Gemini was gesturing at with Helicone, minus the new vendor dependency. This is the single highest-leverage item in this document for a choice-driven interactive fiction platform specifically, since the same (book, state, choice) tuple can legitimately recur across many different readers.

### Phase 2 — Consider once you have real scale or observability pain
5. **Cloudflare AI Gateway**, not Helicone or Portkey, if you eventually want a caching/observability proxy. Reasoning: you're already a Cloudflare customer (Workers AI is one of your 19 providers), core features (caching, rate limiting, dashboard analytics) are free with no request-count ceiling I could find documented (unlike Helicone's 10K/month or Portkey's 10K/month), and since May 2026 it exposes OpenAI-compatible/Anthropic-compatible/universal endpoints — meaning adoption is a base-URL swap in whichever file constructs your provider clients, not a rewrite. **Caveat to verify before committing:** Cloudflare's gateway has first-class support for major providers (OpenAI, Anthropic, Google, Groq, Mistral, and similar) — I could not confirm it has native integration for several of your newer, more niche providers (ModelScope, SiliconFlow, Chutes, LLM7, Aion Labs). Check Cloudflare's supported-provider list against your actual 19 before assuming full-waterfall coverage; it may only cover a subset cleanly.

### Phase 3 — Exploratory, not urgent
6. **Graph-RAG-style character/plot memory compression** (LlamaIndex or a hand-rolled equivalent over your existing `pgvector` setup) — this is the legitimate version of what Wexa claims to do, buildable for free on infrastructure you already have. Worth revisiting once you have a concrete pain point (e.g., recap prompts genuinely ballooning past what flat JSON plot-flags can keep lean), not before — it's real engineering effort for a problem you may not have yet given you're already passing structured JSON state rather than prose recaps.

---

## What I'd explicitly *not* do
- **Wexa** — wrong product category, not a token-optimization tool for this use case, regardless of its free tier.
- **Adopt Helicone or Portkey specifically *for* caching** — your caching need (Part 4) doesn't require what they're selling, and you'd be taking on a new request-path dependency and a request-count ceiling to solve a problem a `hash()` and a database table already solve.
- **Treat "cache everything on Gemini" as a free win** — Part 3's storage-fee math means it needs a per-book decision, not a blanket policy.
