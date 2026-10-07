# Netlify Free-Tier Optimization Roadmap

> **Status:** Proposed — research complete and fact-checked; safe-subset implementation pass applied and verified locally (2026-10-07); deployed evidence pending
> **Date:** 2026-10-05 (revised 2026-10-07)
> **Owner:** Backend + Web / Taufik Nur Rahmanda
> **Scope:** `Twistloom-backend` (Hono, Node.js functions) and `Twistloom-web` (Next.js), both deployed on Netlify
> **Evidence boundary:** Platform research plus a **read-only path/source audit of both repositories (2026-10-07)**, followed by a **safe-subset implementation pass (2026-10-07)** — local code edits verified only by typecheck/lint/tests/build. No account access, traffic measurements, deployments, or live verification. Platform claims were re-verified against vendor docs on 2026-10-07 (§8 "Fact-check log"); the implementation pass is logged in §8 "Implementation pass log".

---

## 1. Summary Table

| # | Item | Priority | Status |
|---|------|----------|--------|
| 1 | Confirm plan, ground existing implementation, and measure both sites | P0 | ⏳ In Progress |
| 2 | Establish one credit budget and operational guardrails | P0 | ⬜ Planned |
| 3 | Reduce unnecessary production deploys and preview side effects | P0 | ⏳ In Progress |
| 4 | Reject abusive or invalid traffic before expensive work | P1 | ⏳ In Progress |
| 5 | Reduce image, JavaScript, font, and response bandwidth | P1 | ⏳ In Progress |
| 6 | Avoid routing large uploads and downloads through functions | P1 | ⬜ Planned |
| 7 | Verify and extend safe public backend CDN/durable caching | P1 | ⏳ In Progress |
| 8 | Coordinate invalidation across backend, Next.js, and browser caches | P1 | ⏳ In Progress |
| 9 | Prefer static rendering and deliberate revalidation for public pages | P1 | ⏳ In Progress |
| 10 | Reduce polling, speculative prefetch, and duplicate requests | P1 | ✅ Completed |
| 11 | Remove unnecessary frontend-to-backend proxy and rendering work | P1 | ⏳ In Progress |
| 12 | Reduce database/cache round trips and connection overhead | P1 | ⬜ Planned |
| 13 | Bound timeouts, concurrency, and retries on request paths | P1 | ⏳ In Progress |
| 14 | Choose economical streaming and long-job execution patterns | P1 | ⬜ Planned |
| 15 | Evaluate scheduled, background, and durable workflow alternatives | P2 | ⏳ In Progress |
| 16 | Benchmark selective backend lazy imports and smaller function graphs | P2 | ⏩ Skipped after assessment |
| 17 | Defer optional frontend components and client libraries | P2 | ⏳ In Progress |
| 18 | Consider narrowly scoped Edge Functions where they remove compute | P2 | ⏩ Skipped after assessment |
| 19 | Keep observability useful and inexpensive | P2 | ⏳ In Progress |
| 20 | Validate savings, roll out incrementally, and define capacity limits | P2 | ⏳ In Progress |

**Planned means pending assessment, not proven absent.** The later audit may mark an item completed with evidence, narrow it to a gap, or skip it. The order favors broad savings and low implementation risk; measured dominant costs can move a later item forward after Steps 1–2.

---

## 2. Problem Statement

### Current State

- Both projects target Netlify (`netlify.toml` exists in both repositories). Observed status from the web [`DEPLOYMENT_PLATFORM_LIFECYCLE.md`](../../../Twistloom-web/docs/operations/DEPLOYMENT_PLATFORM_LIFECYCLE.md) "Verified Platform Status (2026-10-05)": the backend answered **401 via Netlify Edge Access Control**, while `https://twistloom-web.netlify.app` answered **404 "site not found"** (site not yet created at that time). The web site's first production build was attempted on 2026-10-07 and failed before deploy (undeclared `jose` import; failed deploys consume 0 credits), so **the web site's existence, URL, and access-gate mechanism must be re-confirmed in Step 1** — "both sites are private" is not established evidence for the web site. This research does not require publishing either site or bypassing its access gate.
- [`NETLIFY_MIGRATION_ROADMAP.md`](NETLIFY_MIGRATION_ROADMAP.md) documents the backend Node.js adapter and an optimization extension in §11. Its Steps 13–15 report cache directives, public durable caching, and tag purging as done. Those are **documented completion claims to verify later**, not newly discovered omissions.
- [`VERCEL_FLUID_ACTIVE_CPU_OPTIMIZATION_ROADMAP.md`](VERCEL_FLUID_ACTIVE_CPU_OPTIMIZATION_ROADMAP.md) records the previous active-CPU optimization approach. This roadmap replaces its hosting economics for Netlify while retaining useful hypotheses about request amplification, dependency loading, and repeated work.
- The web [`OPEN_FINDINGS_REGISTER.md`](../../../Twistloom-web/docs/roadmap/OPEN_FINDINGS_REGISTER.md) is a separate findings/completion register. This research does not reopen its closed findings or override its evidence gates.
- Actual account plan, team ownership, deployed adapter/runtime versions, traffic distribution, and credit consumption have not been inspected. References to source paths below identify future audit candidates only; exact edit locations will be recorded during that audit.
- **Read-only source audit (2026-10-07) — existing controls that already cover part of this plan:**
  - Backend public caching/tag purge shipped per migration Steps 13–15: `src/utils/netlify-cache.ts`, `src/middleware/cache.ts`, `src/services/cache.ts`; app-layer rate limiting already exists via Upstash (`src/middleware/` rate-limit module), so Step 4 adds a *platform* layer rather than a first one.
  - Web request/polling dampeners already configured: `../Twistloom-web/src/lib/query-client.ts` sets `refetchOnWindowFocus: false` and `refetchOnReconnect: false`; `../Twistloom-web/src/lib/config/polling.ts` defines backoff caps and polling timeouts; Step 10 therefore starts from "verify + extend", not from zero.
  - Web already serves 11 public pages with `export const revalidate = 60|300`, so Step 9 has a partially-reduced baseline rather than full SSR.
  - Every documented path in §8 (both repos) exists on disk; no phantom file references were found.

### Pain Points

1. **A pooled budget can be exhausted without expensive CPU work.** Deploys, bytes served, requests, and function duration compete for the same allowance. Assuming separate full budgets for web and backend would overstate capacity if they belong to one team.
2. **Network waits and streams can dominate function cost.** Reducing parsing or import work may have little impact if an invocation spends most of its time waiting for the database or a provider.
3. **Frontend work contributes independently.** SSR, route handlers, Server Actions, images, client assets, RSC payloads, prefetch, and backend calls all need consideration.
4. **Historical guidance needs qualification.** The migration enhancement targets cannot all fit in 300 credits; its “0 credits” cache-hit diagram is incorrect for request/bandwidth meters; scheduled eligibility was left unverified; the former session-cache recommendation must not relax current authorization guarantees.
5. **Potential inefficiencies are hypotheses.** This document does not establish that either project currently has any particular bottleneck, unsafe cache, duplicate request, or unnecessary eager import.

### Goal

Keep both applications reliable within the actual Free-plan allowance by reducing measured credit consumption per useful user action while preserving security, correctness, freshness, and user experience.

---

## 3. Intended Design & Rationale

### 3.1 Verified platform facts and plan assumptions

Research checked on **2026-10-05** and re-verified on **2026-10-07**, using the official sources linked here and in §8. The primary model is **credit-based Free**; if the account is Legacy Free, rebuild the budget from that plan before implementing budget-driven changes. Netlify treats accounts created before **2025-09-04** as Legacy by default (switching to credit-based is optional and **cannot be reverted**), so a recent site migration does not prove the account's pricing model.

| Meter | Credit-based rate | Planning implication |
|-------|-------------------|----------------------|
| Monthly Free allowance | 300 credits | Budget at team level |
| Successful production deploy | 15 credits | Count web and backend releases separately |
| Deploy Preview / branch deployment | 0 deployment credits | Runtime traffic is still metered |
| Compute | 10 credits / GB-hour | Allocated memory × execution duration |
| Bandwidth | 20 credits / GB | Assets and API/download/image responses matter |
| Web requests | 2 credits / 10,000 requests | No documented exemption for CDN/cache-served requests — budget cache hits as metered |

Sources: [Netlify pricing](https://www.netlify.com/pricing/), [How credits work](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/). Failed deploys and rollback to a previous production deploy do not consume deployment credits; active previews still generate runtime usage. The request-meter rate is documented; the *cache-hit* treatment is not explicitly documented either way (unlike edge invocations, which explicitly exclude cached responses), so this roadmap budgets conservatively.

Usage is aggregated across a team's projects. Exhausting credits pauses **all** sites in the team (visitors see a "Site not available" page), the Free plan has **no auto-recharge or credit packs**, and new production deploys cannot be triggered until the cycle resets. The two official pages disagree on notifications: [usage monitoring](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/monitor-usage-for-credit-based-plans/) documents 50%, 75%, and 100%, while the [billing FAQ](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/billing-faq-for-credit-based-plans/) also lists 90%. Confirm account behavior rather than depending on any one notice, and do not assume configurable 70%/90% alerts exist on Free.

**Other optional consumers:** Netlify AI Gateway/Agent Runners convert model usage at 180 credits per USD; Agent Runners also use compute. Preview Servers and Netlify Database have compute meters. External AI, Neon, Redis, media, and queue providers retain their own quotas and bills. Do not assume those services use Netlify credits unless routed through a Netlify-metered product. [AI pricing](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/pricing-for-ai-features/), [credit-based plan details](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/).

| Runtime property | Verified platform behavior | Free-tier consequence |
|------------------|----------------------------|-----------------------|
| Functions memory | Default 1024 MB; billing uses allocation, not observed heap | Less heap use alone does not lower the memory multiplier |
| Function region | New-site default `cmh` / Ohio (sites created before 2023-10-04 may differ); customization requires Pro or Enterprise | Measure dependency distance; do not plan a Free function-region switch |
| Memory/vCPU customization | Credit-based Pro or Enterprise | Do not propose a 256 MB function or paid tuning as a Free saving |
| Synchronous function | 60-second execution limit | Set application deadlines with room for cleanup |
| Scheduled function | 30-second execution limit | Keep work bounded or dispatch it |
| Background function | Up to 15 minutes | Longer eligibility is not free execution |
| Payloads | 6 MB buffered; 20 MB streamed; 256 KB background; binary request effectively ~4.5 MB | Direct transfers are preferable for large files |

Sources: [function configuration](https://docs.netlify.com/build/functions/configuration/), [function billing](https://docs.netlify.com/build/functions/usage-and-billing/). Defaults describe the platform, not verified settings of these deployments.

#### Additional Free-plan constraints that shape this plan

| Constraint (credit-based Free) | Consequence for this roadmap |
|--------------------------------|------------------------------|
| **1 concurrent build per team**; paid build add-ons are not purchasable on Free | Paired web + backend releases queue serially — Step 3's batching also reduces waiting, not just credits |
| **1 Team Owner seat, no additional seats**; up to 500 projects share one 300-credit pool | A second project does not add headroom; any test/sandbox site also draws from the same pool |
| **Build minutes are not a separate meter** (deploy = flat 15 credits) | Faster builds save wall-clock/iteration time only — never claim build-time savings as credits |
| **No auto-recharge/credit packs on Free**; while paused, no new production deploys | Step 2's exhaustion response must be front-loaded; an exhausted cycle blocks hotfixes |
| **Preview Servers consume compute** (10 credits/GB-hour); Free includes 1 Live Preview Server | "Previews are free" applies to the deploy meter only — Step 3 must inventory idle preview servers |
| **Password protection / basic-auth headers, shared env vars, audit logs are Pro-gated**; Free Firewall Traffic Rules limited to 2 rules per ruleset, 3 IPs, 3 geolocations | Directly affects Step 4's abuse controls and Step 7's private-site cache caveat — confirm which gate is actually in force |
| **Rate-limit enforcement can lag up to ~10 seconds** | Platform rate limits are a coarse backstop, not an exact quota; keep app-layer limits |

Sources: [credit-based pricing plans](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/), [rate limiting](https://docs.netlify.com/manage/security/secure-access-to-sites/rate-limiting/), [billing FAQ](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/billing-faq-for-credit-based-plans/).

### 3.2 Use one budget, not independent maxima

For an estimated billing cycle:

```text
estimated credits = 15 × D + 10 × H + 20 × B + 2 × R / 10,000 + 180 × A + O

D = successful production deploys across all sites in the team
H = function GB-hours; sum allocated_GB × billed_seconds / 3,600
B = web bandwidth in GB, using Netlify's reported units
R = web requests, including previews and static/cache-served requests
A = Netlify-metered AI model usage in USD, if enabled
O = other metered usage, including Preview Servers / Database where applicable
```

Keep additional compute/bandwidth consumers in `O` if excluded from `H`/`B`; do not count them twice. This is a planning approximation, not a replacement for the account dashboard or undocumented rounding rules.

**Illustrative team envelope, not a traffic forecast:**

| Allocation | Example usage | Credits |
|------------|---------------|---------|
| Deploys | 8 total, e.g. 4 paired web/backend releases | 120 |
| Web bandwidth | 2 GB | 40 |
| Function compute | 4 GB-hours | 40 |
| Web requests | 50,000 | 10 |
| Optional meters | Disabled / absent for this example | 0 |
| Planned usage | All meters combined | **210** |
| Reserve | Incidents, usage variance, emergency releases | **90** |

Derived comparisons help prioritize work: one paired release costs 30 credits; preventing 1 GB of bandwidth saves 20; eliminating one hour at 1 GB saves 10; preventing 10,000 requests saves 2 **plus their avoided compute/bytes**. At 1 GB allocation, shortening 10,000 invocations by 500 ms saves about 13.89 compute credits. These are calculations from the rates, not measured project savings.

Twenty production deploys or 15 GB bandwidth each consume the entire 300-credit pool alone. The migration §11.5 examples of 225 deploy credits, ~210 compute credits, and 200 bandwidth credits total ~635 before requests; use a joint envelope instead.

### 3.3 Design alternatives

**Alternative A — Optimize the existing two-site topology first.** Keep Next.js and Hono separate; improve deployment cadence, delivery, cache policy, request volume, and duration. Lowest disruption; separate deploy costs and cross-site boundaries remain.

**Alternative B — Consolidate deployments or substantially rewrite for Edge/static hosting.** May remove a deployment or some compute, but introduces routing, credentials, runtime compatibility, cache invalidation, release coupling, and rollback work. A larger shared bundle or broader redeploys can erase savings.

**Alternative C — Upgrade before optimizing.** Buys capacity and some tuning controls, but adds recurring cost and does not address waste. Useful when required traffic exceeds a realistic Free budget or reliability requirements cannot tolerate a hard cap.

**Recommendation: Alternative A.** Treat consolidation, paid tuning, and broad runtime changes as later decisions supported by measured savings. Netlify's credit model rewards fewer served bytes, fewer unnecessary releases/requests, and fewer allocated execution seconds; optimize those first.

### 3.4 What transfers from the Fluid roadmap

| Previous idea | Netlify interpretation |
|---------------|-------------------------|
| Avoid repeated CPU/import work | Useful if it meaningfully reduces initialization or invocation duration |
| Awaiting external I/O was relatively cheap in the previous model | Count waiting time inside a running Netlify function; reduce round trips and long holds |
| Coalesce status polling | Reduce real network calls first; instance-local coalescing is incomplete across cold instances |
| Cache public reads | CDN/durable hits avoid origin invocation; request and bandwidth meters remain |
| Cache JWT verification | Consider immutable verification work only; do not cache positive session/ban authorization across requests |
| Move work after responding | `waitUntil()` improves response latency but includes async duration in billing |
| Stream for faster first output | Can improve UX while increasing held duration; compare with finite requests/jobs |

The async billing point is explicitly documented in the [Functions API](https://docs.netlify.com/build/functions/api/). The comparison describes the historical roadmap, not a claim about current Vercel pricing.

### 3.5 Do inline lazy imports help?

**Yes, selectively. They are a conditional duration/bandwidth optimization, not a Netlify pricing feature.**

For **Hono/Node.js**, importing a heavy, rarely needed dependency inside its handler can postpone initialization until that route runs. Candidate classes include export/rendering libraries, optional AI-provider SDKs, and administrative tools. Static imports remain appropriate for lightweight or almost-always-used dependencies. AWS explains both selective initialization and reusable execution environments in its [Lambda optimization guide](https://aws.amazon.com/blogs/compute/operating-lambda-performance-optimization-part-2/) and [best practices](https://docs.aws.amazon.com/lambda/latest/dg/best-practices.html); these are engineering guidance, not Netlify billing guarantees.

Crucial qualifications:

1. **Deferred execution is not necessarily a smaller deployment.** With esbuild code splitting disabled, dynamic imports remain in the same bundle with asynchronous semantics. Inspect Netlify's actual artifacts before claiming bundle separation or smaller ZIPs. [esbuild splitting](https://esbuild.github.io/api/#splitting).
2. **The first use pays the loading cost.** Benchmark cold/common routes, cold/heavy routes, warm routes, and simultaneous first use. An improvement on rarely used paths can become a regression if the dependency is used on nearly every request.
3. **Import graphs matter.** An eager barrel export, route registry, or other static importer can already initialize the same dependency. Inline syntax alone proves nothing.
4. **Reuse does not create durable state.** Reuse safe clients within an instance where compatible, but expect a new instance at any time. Module loading and client construction are different costs; repeating the latter per request can dominate.
5. **Do not claim lower memory billing from a smaller heap.** Free functions retain their configured allocation. Also do not assume Netlify's exact cold-init metering from direct AWS Lambda pricing; attribute savings using Netlify measurements.
6. **Use literal trusted import paths.** Preserve required fonts/templates/native files in packaging, keep credentials server-side, and avoid user-selected arbitrary imports. A cached failed initialization needs an intentional recovery policy; module-evaluation failures may require a fresh deployment/instance.

For **Next.js browser code**, defer optional Client Components with `next/dynamic` and load large libraries when a feature is actually opened. This can reduce initial bytes and browser work. A component rendered immediately may still load immediately; extra chunks add requests. Dynamic import of a Server Component does not lazily load that Server Component itself, and the current guide warns that Server-to-Client dynamic imports do not automatically split as expected. `ssr: false` belongs in Client Components and should be reserved for suitable browser-only UI. [Next.js lazy loading](https://nextjs.org/docs/app/guides/lazy-loading).

**Recommendation:** First remove unused dependencies and unnecessary eager initialization; then trial a few optional imports. Compare **credits per representative workload and user latency**, not import count. Backend imports are Step 16; browser imports are Step 17 because they affect different costs.

### 3.6 Non-breaking guarantees

| Area | Required invariant | Optimization boundary |
|------|--------------------|-----------------------|
| Authentication | Cookie-session requests retain fresh backend session existence, ownership, and standing checks; other auth modes retain their authoritative checks | No cross-request positive authorization cache; frontend gating is not the authority |
| Privacy | User-scoped, draft, private, purchased, or administrative data stays isolated | No blanket public cache policy or public signed download URL |
| Payments/jobs | Idempotent durable state, transaction integrity, recoverable completion | No fire-and-forget financial mutation or duplicate charging on retry |
| Public content | Explicit freshness and withdrawal requirements | Cache only approved public representations; strict withdrawal can require bypassing caches |
| Locale/variants | The correct language and semantic query variant | Do not omit response-affecting inputs from keys |
| API contracts | Compatible status codes, bodies, CORS, callbacks, and auth behavior | A topology change must prove parity before rollout |
| Accessibility/SEO | Usable loading, errors, navigation, and public content | Keep critical UI and content available; measure deferred-feature latency |
| Deployment | Private-site posture and recoverable release order | No public launch needed for this roadmap or local audit |

---

## 4. Feasibility Analysis

| Dimension | Assessment |
|-----------|------------|
| Effort | Low for budget/release policies; medium for measured delivery, request, and import changes; high for workflow or topology changes. Estimates follow the later audit. |
| Risk | Low for eliminating unused bytes/builds; medium for timeouts and lazy initialization; high for shared caching, auth, invalidation, and asynchronous money/job flows. |
| Backend changes | Conditional: cache verification, shorter I/O paths, bounded work, packaging, and optional edge/job handlers. |
| Frontend changes | Conditional: public rendering/revalidation, request policy, media delivery, and deferred UI. |
| Dependencies | Confirm pricing/team, establish baseline, inspect existing implementation, obtain owner-access evidence for deployed checks. |
| Free-compatible work | Delivery, requests, safe caching, code-based rate limits, duration reduction, eligible scheduled/background functions, and selective Edge Functions. |
| Plan-gated work | Function memory/vCPU and region customization; long-retention/log-drain features require separate eligibility checks. |
| Reversibility | Most changes can be reverted individually. Data relocation, topology, and workflow migrations need explicit rollback and reconciliation plans. |
| Expected benefit | Unknown until measured. Rank by projected monthly credits saved, user impact, engineering effort, and correctness risk. |

---

## 5. Flow Diagram (Mermaid)

```mermaid
flowchart TD
    A["Useful user action"] --> B["Browser reuses safe assets and avoids duplicate requests"]
    B --> C["Netlify receives a request: request meter applies"]
    C --> D{"Approved public representation cached?"}
    D -->|Yes| E["CDN or durable cache serves bytes: bandwidth meter applies"]
    D -->|No| F{"Static delivery or suitable lightweight edge response?"}
    F -->|Yes| E
    F -->|No| G["Invoke Next.js or Hono function: allocated duration adds compute"]
    G --> H{"Protected operation?"}
    H -->|Yes| I["Check current session, ownership, and standing"]
    H -->|No| J["Read approved public data"]
    I --> K{"Long-running work?"}
    J --> L["Bound I/O and serialize a minimal response"]
    K -->|No| L
    K -->|Yes| M["Persist idempotent job and dispatch selected executor"]
    M --> N["Return job ID; client uses bounded updates"]
    M --> O["Executor completes durable work; its own meters still apply"]
    O --> P["Commit state and coordinate cache invalidation"]
    L --> E
    N --> E
    P --> D
```

The diagram illustrates the recommended boundaries; it does not assert that this exact flow is implemented. Scheduled work and deployment credits are additional budget consumers outside the visitor request path.

---

## 6. Implementation Plan

**Execution rule:** Ground each step before changing code. Record `implemented and verified`, `partial`, `not implemented`, or `not applicable`, with current source/deployment evidence. Only implement the remaining gap. Exact files/lines and numeric targets are intentionally deferred to that audit, as requested.

### Step 1: Confirm plan, ground existing implementation, and measure both sites — ⏳ In Progress

> **Implementation pass (2026-10-07):** Local grounding complete — both repos audited read-only; upload ceilings (6/10 MB over a 6 MB function body) and the render-dynamic root cause (Step 9) recorded as audit findings. Blocked on owner account access: plan confirmation, live usage/credit dashboards, traffic measurement. No deployment changes made.

**Files:** This roadmap; `docs/roadmap/NETLIFY_MIGRATION_ROADMAP.md`; `netlify.toml`; `netlify/functions/api.mts`; web `netlify.toml`, `next.config.ts`; generated deploy artifacts. Source details are future audit candidates.
**Effort:** Low–medium. **Savings driver:** Accurate prioritization and avoiding duplicate work.

1. Confirm Credit-based versus Legacy Free (accounts created before 2025-09-04 default to Legacy; the switch cannot be reversed), team membership of both projects, billing-cycle dates, other projects sharing the pool, actual deployed Node/Next.js/adapter configuration, and which mechanism makes each site private — the backend's 401 came from Netlify Edge Access Control, while the web site's gate is unverified (404 as of 2026-10-05, first build attempted 2026-10-07). Verify that neither gate silently disables CDN caching (see Step 7).
2. Build an implementation/evidence matrix for all 20 steps, including the migration's already-completed cache work and previously closed web findings.
3. Capture representative private-site activity: anonymous public reading where authorized, sign-in, browsing, reading, mutations, job progress, and an export. Separate cold/warm requests, preview/production, humans/bots, cache hits/misses, and idle scheduled work.
4. Record deployed request counts, served bytes, function duration and invocation count, dependency timing, rendering mode, and deploy count. Use existing instrumentation first; never log credentials or private payloads.
5. Establish credits per useful action and projected credits per cycle. A small known workload can be used while real traffic is sparse; label synthetic estimates and avoid load tests that consume the allowance.

**Non-breaking:** Read-only/local assessment; private hosting remains private.
**Exit evidence:** Account/baseline snapshot, source map, documented unverified live checks, and a ranked list of real gaps. Access-gated checks remain pending and do not block independent local work.

---

### Step 2: Establish one credit budget and operational guardrails — ⬜ Planned

> **Status note (2026-10-07):** Not started — requires the owner's Netlify account (usage, notifications, plan comparison) and Step 1 workload numbers to set credit quotas.

**Files:** This roadmap; candidate deployment/runbook documentation; Netlify team settings outside Git.
**Effort:** Low. **Savings driver:** Avoiding pool exhaustion and accidental optional usage.

1. Replace separate maxima with the §3.2 envelope, using measured usage and a reserve. Start with a proposed 70% planned allocation; change the ratio only with evidence.
2. Verify built-in notices reach the owner. Review usage frequently during implementation, then at a cadence justified by consumption. Forecast using remaining days in the actual billing cycle and known upcoming deploys, rather than assuming 30 days.
3. Inventory Netlify AI Gateway, Agent Runners, Preview Servers, Database, and experimental features. Disable unused consumers where appropriate; do not migrate functioning external services merely because a Netlify equivalent exists.
4. Define staged responses to rising usage: stop optional rebuilds/test loops; reduce speculative fetching and nonessential jobs; investigate abuse; protect critical flows; then consciously choose reduced scope or a paid plan if needed. Never interrupt required transaction settlement/reconciliation casually.
5. Keep external-provider budgets separate and visible. Offloading Netlify compute can transfer cost or quota pressure elsewhere.

**Non-breaking:** No silent downgrade of authentication, settlement, or user promises.
**Exit evidence:** One owner-approved operating envelope, notice verification, optional-meter inventory, and a documented exhaustion response. This document itself does not alter account settings.

---

### Step 3: Reduce unnecessary production deploys and preview side effects — ⏳ In Progress

> **Implementation pass (2026-10-07):** Added `ignore = "sh scripts/netlify-ignore.sh"` to both `netlify.toml` files; the script skips builds only for docs-only change sets (`*.md` + `docs/**`) and builds on anything else or on any script/ref error. Verified with an 8-scenario harness (docs-only → skip, backend-docs → skip, code → build, workflow → build, missing ref → build, bogus ref → build, dot-dir .md → build [conservative], `docs/` non-md → skip). Release batching and preview-server inventory remain blocked on account access.

**Files:** Backend/web `netlify.toml`; candidate build-ignore helper; release workflow files identified during audit.
**Effort:** Low–medium. **Savings driver:** Deployment credits and post-deploy cache refill.

1. Batch compatible fixes into deliberate production releases. Count a paired release as two successful deploys; release only the app that changed when contracts allow it.
2. Use previews for repeated validation. Preview deployment is free of the deploy meter, but preview browsing, SSR, APIs, and test traffic still consume runtime meters; scheduled functions run only for published (production) deploys, so previews carry no idle cron cost, whereas any running Preview Server consumes compute at 10 credits/GB-hour. Inventory and idle-stop preview servers.
3. Account for the **one-concurrent-build team limit**: web and backend releases queue behind each other, so batching also shortens iteration waits. Failed builds cost 0 credits but still consume queue time.
4. Ignore genuinely irrelevant changes, such as documentation-only edits, after inspecting each repository's build inputs. Include configuration, dependencies, shared/generated assets, and lockfiles in relevant changes. These are separate projects; do not assume a monorepo path filter fits them.
5. Follow Netlify ignore semantics: exit `0` skips; exit `1` builds. Build-hook-triggered builds bypass this ignore mechanism. Use a dependency-free helper compatible with the ignore-command environment, with missing Git history conservatively causing a build. [Ignore builds](https://docs.netlify.com/build/configure-builds/ignore-builds/).
6. Scope preview secrets and backend targets; suppress emails, paid generation, production writes, and duplicate callback side effects unless intentionally enabled in a sandbox. Disable idle preview features where safe.
7. Use documented rollback rather than rebuilding merely to restore the previous known-good release. Preserve API compatibility during sequential web/backend deployment.

**Non-breaking:** Security fixes and necessary emergency releases remain possible; no required build is skipped.
**Exit evidence:** Build/no-build cases verified, paired-release accounting, preview side-effect review, and a rollback rehearsal. Optimize build time for iteration, but do not claim saved build minutes reduce this plan's deployment meter.

---

### Step 4: Reject abusive or invalid traffic before expensive work — ⏳ In Progress

> **Implementation pass (2026-10-07):** Proxy matcher now excludes all `/_next/*` paths (previously only `_next/static|_next/image`), with the existing guard proving safety; the `netlify.toml` note now states explicitly that redirect rules carry no `rate_limit` schema. Deferred: function-level IP rate-limit rules (Free tier: 2 per path, path-only matching, ~10 s propagation lag) and `ipFallback` on anonymous reads — quotas cannot be picked safely without Step 1 traffic data (NAT-shared networks would hit 429s).

**Files:** Backend `netlify/functions/api.mts`, `netlify.toml`, middleware candidates; web `netlify.toml`, `src/proxy.ts` and generated adapter configuration, subject to support checks.
**Effort:** Low–medium. **Savings driver:** Avoided origin duration, responses, and provider usage.

1. Evaluate Netlify code-based rate limits before origin invocation on the most expensive eligible paths. Free supports **two code-based rules per project**, **path targeting only**, with per-domain-&-IP aggregation (per-domain alone is an Enterprise/high-performance-edge option). Declare function/edge-function rules as a `rateLimit` block in the function's exported `config` — Netlify explicitly states that **function rate limits cannot be defined in `netlify.toml`** (`netlify.toml` `[redirects.rate_limit]` applies to redirects only). Enforcement can lag by up to ~10 seconds, so keep the existing application-layer quotas (backend already enforces per-user limits through its Upstash rate-limit middleware) as the authoritative control; IP limits alone are unsuitable for shared networks or payment/job correctness. [Rate limiting](https://docs.netlify.com/manage/security/secure-access-to-sites/rate-limiting/).
2. Validate body limits, method, schema, and required credentials before loading heavy features or calling providers. Use existing secure middleware ordering rather than bypassing authorization.
3. Restrict middleware/proxy matchers to necessary paths so assets do not cause extra work. The web matcher in `src/proxy.ts` is broad and already carries an in-code note to narrow it (`../Twistloom-web/src/proxy.ts:369`, matcher at `:372`); narrowing it removes edge/middleware work per request without new code. Review catch-all function routing and supported static-file precedence — backend `netlify.toml` already sets `preferStatic: true` so CDN static files win over the function — and verify locale routing, callbacks, and protected paths still behave correctly; do not edit generated adapter functions directly.
4. Prefer small static failure responses where suitable. Keep legitimate crawler discovery, accessibility, shared-IP users, webhook signatures, and trusted callbacks working. `robots.txt` guides cooperative crawlers; it is not abuse enforcement.
5. Measure observed cost of blocked traffic; do not promise that rate-limited, password-gated, or rejected requests incur zero credits. Avoid adding an Edge Function solely to inspect every request if platform rules suffice.

**Non-breaking:** Correct authorization and provider callbacks remain intact.
**Exit evidence:** Safe-path and abusive-path tests, callback verification, rule availability/configuration evidence, and lower expensive-origin invocation volume.

---

### Step 5: Reduce image, JavaScript, font, and response bandwidth — ⏳ In Progress

> **Implementation pass (2026-10-07):** Serwist precache reduced **38.16 MB/233 entries → 8.83 MB/135 entries** via `globIgnores: ["public/images/**","public/videos/**"]` (the offline fallback page uses no raster assets; runtime caching still covers `/images/` on first use) — verified by build plus precache-manifest inspection; SW revision now falls back to `COMMIT_REF` instead of `randomUUID()` so offline entries are not re-downloaded every deploy; removed the unused `i.pravatar.cc` remotePattern; gated Vercel preconnect/dns-prefetch hints on `process.env.VERCEL` (retained for rollback parity when hosted on Vercel). Deferred: font `preload:false` experiment and the ImageKit vs `/_next/image` bandwidth split (both need deployed measurement).

**Files:** Web `next.config.ts`, `src/lib/config/image.ts`, `src/lib/utils/image-url.ts`, `src/components/ui/OptimizedImage.tsx`, `src/app/layout.tsx` (Serwist service worker), asset/component families; backend response serializers identified later.
**Effort:** Medium. **Savings driver:** Bandwidth, browser requests, and serialization work.

1. Rank response types and routes by bytes served, including covers, avatars, reader illustrations, social previews, JS, CSS, fonts, HTML/RSC, and JSON. Optimize the largest actual contributors first.
2. Verify the deployed Next.js image path: Netlify's current adapter uses Image CDN for `next/image`; it also provisions functions for dynamic Next.js work. Avoid adding a Node image proxy when the adapter/CDN already handles it. **Audit split first:** `OptimizedImage` sets `unoptimized` for ImageKit sources (`../Twistloom-web/src/components/ui/OptimizedImage.tsx:70`), so ImageKit URLs bypass Next/Image CDN optimization entirely while `picsum.photos` and `i.pravatar.cc` do not — measure both classes before choosing an optimization, and never route private images through a shared optimizer without an access check. [Next.js on Netlify](https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/).
3. Use correct responsive `sizes`, bounded widths/quality variants, supported efficient formats, and lazy loading below the fold. Do not preload every cover or compromise the main visible image. Whitelist remote sources (`next.config.ts` `images.remotePatterns`) and maintain private-image access boundaries. [Image CDN](https://docs.netlify.com/build/image-cdn/overview/).
4. Serve only necessary font families, scripts, styles, and third-party widgets. Use immutable browser caching for truly content-hashed assets; changing assets must get new URLs. Browser reuse can avoid a request, whereas a CDN hit still serves bytes. Note the web app registers a **Serwist service worker** (`../Twistloom-web/src/app/layout.tsx:156`): precached assets avoid network requests but every SW revision bump re-downloads them, so count SW cache invalidation as a bandwidth event when bundling changes. Vercel telemetry (`@vercel/analytics`, `@vercel/speed-insights`) is deliberately retained for rollback parity and consent-gated — confirm it no-ops on Netlify so it adds no requests or bytes. [Advanced caching guide](https://developers.netlify.com/guides/advanced-caching-made-easy/).
5. Verify actual compression on deployed text responses before implementing compression inside a function. Return paginated, field-selected JSON and avoid repeated large content/RSC payloads. Preserve required fields and response contracts.
6. Check metadata/social-image endpoints for expensive regeneration and needless requests; use static or intentionally revalidated assets when content/freshness permits.

**Non-breaking:** Readability, image quality, layout stability, accessibility, and social preview correctness are acceptance criteria.
**Exit evidence:** Representative transferred-byte comparison with visual checks and no increase in error rate or poor loading behavior. Image CDN delivery still belongs in the bandwidth/request budget.

---

### Step 6: Avoid routing large uploads and downloads through functions — ⬜ Planned

> **Status note (2026-10-07):** Audit finding only — covers/web uploads are 6 MB and feedback media 10 MB, both proxied through the `/api/backend` rewrite, so a request above 6 MB would exceed the function body ceiling. No change made: the fix requires product-level decisions (direct-to-storage upload URLs, size caps, or CDN passthrough).

**Files:** Candidate backend upload/export/download services and routes; web upload/download clients; media-provider configuration.
**Effort:** Medium; high if storage changes are required. **Savings driver:** Avoided function transfer/holds and Netlify egress where delivery moves to another provider.

1. Prefer authenticated, short-lived direct upload authorization and direct storage/CDN downloads where existing providers support them. The function performs authorization and returns a scoped capability; it does not relay the entire file.
2. Validate object ownership, key scope, size, type, checksum where applicable, expiration, and download entitlement. Use private storage for private assets. A signed URL is a bearer capability, so keep it short-lived and out of shared caches/logs.
3. For reusable exports, store an artifact keyed by content/version and export options instead of regenerating it on every download; re-check entitlement before access. Clean up expired artifacts.
4. Compare storage/CDN egress, requests, retention, and free quotas. Moving files into Netlify Blobs does not automatically avoid Netlify delivery meters, nor does adding another free-tier dependency guarantee total savings.
5. Verify CORS, resumability where required, filenames, failure handling, and large-file limits. Reuse existing integrations before introducing another provider. **Current-state evidence:** web uploads do *not* yet follow item 1 — cover, pen-draft, and feedback images are client-compressed (`browser-image-compression`) then POSTed as base64/FormData through the `/api/backend` rewrite (`../Twistloom-web/src/lib/services/pen-api.ts`, `FeedbackForm.tsx`) into backend functions, while `../Twistloom-web/src/lib/config/upload.ts` permits up to 6 MB (cover/pen) and 10 MB (feedback); base64 adds ~33% and Netlify functions allow a **6 MB buffered request** payload (20 MB streamed responses only), so these limits sit at or above the platform ceiling — measure end-to-end in Step 1 for 413/timeout failures before trusting them, and lower the configured limits or adopt item 1 if they exceed it.

**Non-breaking:** Entitlement enforcement and private-media isolation remain authoritative.
**Exit evidence:** Successful authorized transfer, rejected unauthorized/expired capability, correct provider accounting, and no large payload passing unnecessarily through the function.

---

### Step 7: Verify and extend safe public backend CDN/durable caching — ⏳ In Progress

> **Audit pass (2026-10-07):** Code-level verification found three issues to fix later: `applyPublicCdnCache` never affects route responses that already set `Cache-Control` (early return, `src/middleware/cache.ts`); the `/api/books/trending` whitelist entry is dead (no such route); purge tags `explore`/`trending` are never attached (only `stats` is). Also added a `[[headers]]` entry caching `robots.txt` for 24 h. **Deferred:** the cache-header fix itself — it changes CDN behavior for private/no-store responses and must ship with a guard test plus deployed purge verification (exit evidence).

**Files:** Backend `src/utils/netlify-cache.ts`, `src/middleware/cache.ts`, public route candidates, `netlify.toml`; existing related tests.
**Effort:** Medium. **Savings driver:** Avoided origin invocations and dependency calls.

1. Audit migration Steps 13–14 first. Approve a narrow list of truly public GET representations; distinguish anonymous data from optional-user fields, paid access, moderation states, private books, drafts, and cookie-dependent responses.
2. Set a per-representation freshness budget. Prefer a short initial TTL and only add stale-while-revalidate when stale output is acceptable. Do not cache errors or unauthorized output under an anonymous key.
3. Validate header precedence precisely: for cache-*control*, Netlify respects the most specific header in the order `Netlify-CDN-Cache-Control` > `CDN-Cache-Control` > `Cache-Control` — a generic header does **not** outrank a Netlify-specific one, and a generic `private` on a protected response is not a substitute for a correct higher-precedence policy. Variation is different: when a response carries both `Netlify-Vary` and `Vary`, Netlify honors **both** when building cache keys (additive, not ranked). For protected responses, prohibit conflicting shared-cache opt-ins and ensure the effective policy is private/no-store as appropriate. [Caching overview](https://docs.netlify.com/build/caching/caching-overview/), [CDN caching guidance](https://www.netlify.com/knowledge-base/how-to-control-cdn-caching-on-netlify/).
4. Verify locale and every response-affecting query/header variant. Remove only proven nonsemantic tracking parameters from cache-key variation, with consistent `Netlify-Vary` behavior. Do not collapse semantic filters, pagination, locale, or permission variants for hit rate. [Cache-key guidance](https://www.netlify.com/knowledge-base/how-to-control-cdn-caching-on-netlify/).
5. Verify `durable` for eligible serverless public responses and inspect deployed `Cache-Status`; local development cannot establish real CDN behavior. Durable cache is not supported for Edge Function responses. [Caching overview](https://docs.netlify.com/build/caching/caching-overview/).
6. Treat cache hits as saved origin compute, never zero total credits. Background revalidation still performs origin work. Tiny TTLs or low-traffic/high-cardinality routes may produce limited savings.

**Private-site evidence caveat:** Netlify documents that its `basic-auth` protection on any page disables CDN caching for the whole site, and on credit-based plans password protection/basic-auth headers are listed as **Pro-only** — so first establish which gate is actually in force: the backend's observed 401 came from **Netlify Edge Access Control**, which is a different mechanism whose caching interaction is not covered by the `basic-auth` statement. Do not infer caching behavior from an arbitrary login gate, and keep whatever protection exists in place. If the gate prevents a representative cache check, mark that deployed evidence pending and continue local/header-policy checks. [Private-site caching caveat](https://www.netlify.com/knowledge-base/how-to-control-cdn-caching-on-netlify/).

**Non-breaking:** Public caching never authorizes a protected operation or exposes a private representation.
**Exit evidence:** Hit/miss and origin-count tests; A/B user and anonymous isolation; locale/query variants; no shared private/error caching; measured savings for approved routes.

---

### Step 8: Coordinate invalidation across backend, Next.js, and browser caches — ⏳ In Progress

> **Audit pass (2026-10-07):** Purge-tag drift documented (ties to Step 7); web-side invalidation reviewed — centralized query-key factories, `refetchOnReconnect:false`/`refetchOnWindowFocus:false` defaults, and freshness-guarded `visibilitychange` handling already comply with AGENTS §5. No invalidation code changed.

**Files:** Backend `src/utils/netlify-cache.ts`, `src/services/cache.ts`, mutation services; web revalidation/query invalidation candidates.
**Effort:** Medium–high. **Savings driver:** Safely extending reuse without needless broad purges.

1. Verify migration Step 15, then map each public mutation to backend tags, Next.js data/route caches, and browser query keys. A backend CDN purge does not establish that a separate web site's rendered/data cache was invalidated.
2. Trigger invalidation after durable commit; use idempotent, bounded dispatch/retry. Retain finite TTLs as fallback. A post-response task may be suitable for latency but is neither guaranteed free nor a substitute for a recoverable delivery record when required.
3. Prefer scoped tags over site-wide purges. Batch repeat invalidations; Netlify limits each tag/site purge to twice per five seconds. Monitor failures/429s rather than silently assuming freshness. [Caching invalidation limits](https://docs.netlify.com/build/caching/caching-overview/#on-demand-invalidation).
4. Distinguish tolerated catalogue staleness from strict withdrawal/private-content changes. If purge propagation/failure cannot meet privacy requirements, that representation is ineligible for public caching.
5. Review whether atomic deploy invalidation is adequate: new deploys invalidate the cache for that deploy context by default. `Netlify-Cache-ID` is the documented **opt-out of that automatic invalidation** for function/proxy responses (its IDs also register as purge tags), not a general "persist across deploys" switch — do not adopt it unless representation/schema compatibility and explicit invalidation are proved. [Caching overview](https://docs.netlify.com/build/caching/caching-overview/).
6. Avoid expensive synchronous revalidation fan-out after every write; evaluate coalescing and bounded regeneration. Protect revalidation endpoints, prevent replay abuse, and keep tokens out of client bundles.

**Non-breaking:** Database transactions stay authoritative; auth/permission changes are enforced immediately by the protected API.
**Exit evidence:** Update/delete/visibility-change behavior across both sites, failed purge recovery, freshness bounds, targeted invalidation, and no stale protected data disclosure.

---

### Step 9: Prefer static rendering and deliberate revalidation for public pages — ⏳ In Progress

> **Audit finding (2026-10-07) — largest identified lever; implementation deliberately deferred as risky:** every declared `revalidate` route is dynamic as built: the root layout reads `headers()` (`../Twistloom-web/src/app/layout.tsx`) and all public fetches go through `fetchWithLogs`, which reads `cookies()`/`headers()` (`../Twistloom-web/src/lib/utils/fetch.ts`). The generated prerender manifest contains zero `[locale]/*` routes, so every public page view is a function invocation. Static rendering requires moving locale derivation out of the root layout **and** a cookie-free public fetch path — shipping only one half yields zero benefit, and a partial mistake risks serving one user's data to another. Deferred pending a reviewed refactor design and deployed verification.

**Files:** Web `src/app/` route/layout/metadata candidates, `next.config.ts`, data-loading and revalidation helpers.
**Effort:** Medium. **Savings driver:** Avoided SSR and repeated backend rendering reads.

1. Classify routes as static, public revalidated, personalized dynamic, or unsuitable for shared reuse. Include metadata and social-image handlers, not just visible pages. Baseline already exists: 11 web pages set `export const revalidate = 60|300`, so start by inventorying which routes are *not* covered rather than assuming full SSR.
2. For public pages, compare static rendering/ISR with per-visitor SSR. Keep personalization in an appropriate separate boundary if the audited Next.js version and adapter support it; preserve public SEO and current-user behavior.
3. Inspect dynamic triggers in shared layouts and metadata. Cookie/request-dependent reads and broad force-dynamic settings may expand runtime work. The installed version is **Next.js 16** and this project does **not** enable `cacheComponents` (`next.config.ts` has no such flag), so the classic rendering model applies: request-time APIs such as `cookies()` opt the route (or the whole app from the root layout) into dynamic rendering. Version-16 specifics to respect: synchronous `cookies()`/`headers()` access was removed, `revalidateTag` now requires a second `cacheLife` argument (the single-argument form is deprecated; `updateTag`/`refresh()` cover the Server-Action case), and `next build` no longer runs linting. Do not mix Cache Components/`"use cache"`/PPR assumptions into this codebase without deliberately opting in. [Next.js production guide](https://nextjs.org/docs/app/guides/production-checklist), [version 16 upgrade guide](https://nextjs.org/docs/app/guides/upgrading/version-16), [cookies API](https://nextjs.org/docs/app/api-reference/functions/cookies).
4. Let the Netlify adapter manage its generated cache infrastructure: it provisions SSR/ISR/PPR/route-handler functions and implements tag-based and path-based revalidation on top of Netlify's cache tags/primitives (no documented `/___revalidate`-style endpoint exists, so do not assume one). Verify deployed output rather than manually patching generated functions or assuming custom response headers override Next.js caching.
5. Set revalidation by business freshness and traffic. Avoid full production rebuilds on every content edit; prefer authenticated on-demand revalidation where appropriate. Prebuild a useful bounded set of popular routes rather than every possible locale/content combination.
6. Reuse approved public data even inside a personalized route where version-appropriate Next.js data caching safely supports it. Netlify's Cache API can also cache selected internal responses/fetches, but assess overlap with the adapter first; avoid redundant cache layers and never share a user's authorization or private fetch result. [Cache API](https://docs.netlify.com/build/caching/cache-api/).

**Non-breaking:** Personalized and protected pages stay isolated; public content remains discoverable and correctly localized.
**Exit evidence:** Render-mode/artifact inventory, deployed cache behavior, mutation freshness tests, and fewer SSR/backend invocations per public visit.

---

### Step 10: Reduce polling, speculative prefetch, and duplicate requests — ✅ Completed

> **No-change completion (2026-10-07):** Audit verified the requirements are already met — every polling loop pauses when the tab is hidden (`refetchIntervalInBackground: false` or manual `visibilityState` gates), global `refetchOnReconnect:false`/`refetchOnWindowFocus:false` with explicit per-query re-enables, `Retry-After` honored (`useCustomActionPolling`), and backoff caps in `src/lib/config/polling.ts`. No gaps found → no code change (Step 20.5 no-change completion).

**Files:** Web `src/lib/config/polling.ts`, `src/lib/query-client.ts`, hook/query-key/link candidates; backend status/coalescing candidates.
**Effort:** Medium. **Savings driver:** Requests, compute, and repeated bytes/provider reads.

1. Measure real production navigation and job progress. **Existing baseline:** focus and reconnect refetches are already disabled globally (`../Twistloom-web/src/lib/query-client.ts:37` and `:68`), polling backoff/timeout caps live in `../Twistloom-web/src/lib/config/polling.ts`, and the web `AGENTS.md` §5 codifies visibility-gated polling, single-flight dedupe, `Retry-After` handling, and cacheable polling reads — treat these as implemented conventions to verify, then hunt for amplification *outside* them (RSC/prefetch fetches, metadata, repeated session/profile loads, duplicate hook observers). Separate expected development-only activity from production amplification.
2. Use one active observer/transport for the same job where feasible. Back off with jitter during long waits; stop polling after completion/error/logout, when hidden/offline where appropriate, and after an explicit limit. Resume safely and expose stale/status feedback.
3. Deduplicate identical read work with correctly scoped keys, cancel obsolete requests, and set freshness by data semantics. Do not coalesce mutations, reuse a different user's response, or hide status transitions with long stale windows.
4. Limit speculative prefetch for large link lists and costly destinations; consider intent-based prefetch on selected links. Next.js supports disabling automatic prefetch, but navigation latency is the tradeoff. [Prefetching guide](https://nextjs.org/docs/app/guides/prefetching).
5. Prefer a compact status response to rereading an entire book/job. Investigate conditional requests only if they avoid bytes or work: a `304` still involves a request and may invoke a function.
6. Treat instance-local coalescing as an optimization, not a distributed guarantee. Consider durable/shared coalescing only when its extra cache calls, latency, and quotas yield a net benefit.

**Non-breaking:** Fresh authorization remains at the backend; real completion/revocation/error states stay visible.
**Exit evidence:** Network traces and requests per interaction before/after, hidden/resume/reconnect tests, bounded terminal polling, and no cross-user reuse.

---

### Step 11: Remove unnecessary frontend-to-backend proxy and rendering work — ⏳ In Progress

> **Implementation pass (2026-10-07):** The proxy now classifies the route before auth and skips the `auth()` call on non-protected routes (single-consumer proof in-file; avoids JWT decode/cookie plumbing per request and, on cache miss, a backend profile fetch per public page view); matcher narrowed to all `/_next` (Steps 4/5). Deferred: removing the `/api/backend` rewrite double-hop — architecture change with routing side effects.

**Files:** Web `src/lib/services/api.ts`, Server Component/API/Server Action candidates, `src/proxy.ts`, `netlify.toml`; backend CORS/auth/routing candidates.
**Effort:** Medium. **Savings driver:** Avoided extra function duration, requests, and transfer hops.

1. Trace browser → Next.js → Hono calls. Count which layers actually execute functions and which are CDN rewrites. **Concrete starting point:** the browser calls `/api/backend/:path*`, which `next.config.ts` `rewrites()` forwards to `https://twistloom-backend.netlify.app`, and `../Twistloom-web/src/lib/services/api.ts:144` prefixes relative URLs with `API_BASE_URL` — so every authenticated API call crosses that boundary. The open question is whether the Netlify adapter emits a CDN-level redirect/proxy for it (no frontend compute) or routes it through the Next serverless function (a second billed invocation per API call). Do not assume either outcome or assert an exact double charge without measurements.
2. In server-side rendering, call the required backend service directly rather than calling the same frontend's route handler over HTTP merely to reach Hono, where contracts/security allow it.
3. Compare direct browser backend calls, CDN-level proxying, and Next.js route-handler proxying. Keep a proxy where it is needed for credentials, origin policy, response transformation, or a stable public contract.
4. Reuse identical reads within one render/request using version-appropriate memoization. Avoid serial duplicate data loading in layout, page, and metadata. Do not introduce shared caching of a user's session or permissions.
5. Keep transformations minimal and preserve streaming/error/cancellation behavior. Test cookies, SameSite, CORS, preflight behavior, CSRF/origin controls, and callback URLs before changing the transport path.

**Non-breaking:** Existing auth, API contracts, and origin protections are part of the decision.
**Exit evidence:** End-to-end trace and metering comparison with sign-in/mutation/SSR coverage; remove a hop only when there is a demonstrated benefit.

---

### Step 12: Reduce database/cache round trips and connection overhead — ⬜ Planned

> **Status note (2026-10-07):** Not started — needs Step 1 dependency-timing attribution first; per §12.4, no speculative warm-up traffic is allowed on Free-tier credits.

**Files:** Backend database, query/service, cache-client, and instrumentation candidates; frontend server data loaders where relevant.
**Effort:** Medium. **Savings driver:** Less wall-clock waiting and repeated external work.

1. Attribute duration to actual database/cache/provider calls. Separate connection setup, Neon wake-up, query execution, Redis/network round trips, and response serialization.
2. Reduce N+1 reads, select necessary fields, paginate, and inspect measured slow query plans before adding indexes. Combine reads when transaction/snapshot/auth semantics permit it.
3. Verify compatible client/connection reuse and bounded pool behavior for Node.js serverless. Choose Neon HTTP/WebSocket/pooling based on actual query/transaction needs rather than assuming one mode is universally faster. Pooling does not remove geographic latency. [Neon driver](https://neon.com/blog/serverless-driver-ga), [Neon latency guidance](https://neon.com/blog/how-to-minimise-the-impact-of-database-latency).
4. Measure distance from the actual function region to Neon and Redis. Because Free cannot move the function region, reducing round trips is the first lever. Data-region relocation requires separate capacity, residency, migration, and recovery review; do not move production data speculatively.
5. Cache expensive approved data/aggregates only with an explicit freshness policy. Measure whether cache lookup overhead outweighs the saved query for inexpensive reads. Keep immediate session/standing enforcement and transactional balances intact.
6. Avoid periodic warm-up traffic just to keep functions or Neon awake; it consumes requests, duration, and possibly database quotas without proving net savings.

**Non-breaking:** Financial transactions and authorization consistency remain required.
**Exit evidence:** Dependency timings and query counts, measured plans for actual slow queries, cold/warm comparison, pool/timeout safety, and unchanged correctness tests.

---

### Step 13: Bound timeouts, concurrency, and retries on request paths — ⏳ In Progress

> **Implementation pass (2026-10-07):** Bounded previously-unbounded outbound calls with `AbortSignal.timeout`: LibreTranslate ×2 (30 s), Google Play/App Store verification requests (15 s), Neon usage query (10 s), QStash publish + schedule upsert (15 s), Jina embeddings (30 s, retry-aware), GitHub workflow dispatch/list/cancel (30/15/15 s). All durations are centralized as JSDoc'd constants in `src/config/timeouts.ts` (7 exported `*_TIMEOUT_MS` values covering the 11 call sites) so they are tunable in one place instead of scattered magic numbers. `TimeoutError` remains retryable per `src/utils/retry.ts`, so `retryWithBackoff` semantics are preserved. Verified: `bun run check` + 439 backend tests pass. **Deferred:** payment-path timeouts (Xendit/Stripe reads+writes) and OpenAI-compatible SDK `timeout`/`maxRetries: 0` layering — payment and idempotency risk.

**Files:** Backend/web outbound-request wrappers, service orchestration, job/provider clients, and function-entrypoint candidates.
**Effort:** Medium. **Savings driver:** Fewer wasted allocated seconds and retry storms.

1. Establish an end-to-end application deadline below the platform ceiling, then budget dependency attempts, cancellation, cleanup, and serialization within it. Use supported abort/timeout mechanisms and verify adapters propagate cancellation.
2. Parallelize independent reads with bounded concurrency when this reduces elapsed time. Preserve dependencies and transaction order; unbounded parallelism can overwhelm providers and multiply retries.
3. Separate retryable transient failures from invalid requests, authorization failures, and permanent provider errors. Cap attempts, honor `Retry-After`, add jitter, and prevent frontend + backend + SDK retry multiplication.
4. Prefer queue-based delayed retry for durable long jobs instead of sleeping inside request functions. Abort unused work on client disconnect only when stopping it is safe; required settlement/reconciliation must be independently durable.
5. Keep small optional side effects from extending the main path needlessly. `waitUntil()` can help response latency for bounded work, but the [Functions API](https://docs.netlify.com/build/functions/api/#waituntil) explicitly includes that work in duration billing.

**Non-breaking:** Do not return success before required state is durable, or abandon critical operations on timeout.
**Exit evidence:** Fault injection for slow/failed dependencies, bounded attempts/duration, correct partial-failure behavior, and lower billed time without extra failure rates.

---

### Step 14: Choose economical streaming and long-job execution patterns — ⬜ Planned

> **Status note (2026-10-07):** Not started — stream/latency measurements are required before comparing SSE-to-queued transports; no speculative changes (§14 waiting rule).

**Files:** Backend streaming/AI/export/job routes and workers; web progress transport/polling clients.
**Effort:** Medium–high. **Savings driver:** Avoided long holds and repeated generation.

1. Measure stream lifetime, first useful output, reconnects, final completion, and idle waiting. Streaming is a UX choice; all held function duration belongs in the compute estimate. A ten-second reduction over 1,000 streams at 1 GB saves about 27.78 compute credits. Heartbeats do not reset the function's hard execution limit; bound reconnects and provide recoverable status rather than an endless reconnect loop.
2. Compare finite streaming, adaptive status polling, and durable job + completion event/webhook. Polling is not automatically cheaper: include status invocation duration, request bytes, number of viewers, and backend/provider reads.
3. Keep short interactive streams where their value warrants the cost. For operations that can exceed the synchronous ceiling, persist an idempotent job, dispatch an appropriate executor, return a job ID, and allow safe reconnect/resume.
4. Consider a provider's asynchronous submission/completion webhook where available, so a Netlify function does not wait for an entire generation. Validate signatures, replay protection, current job ownership, failure/cancel handling, and final-state reconciliation.
5. Compare the existing documented QStash/GitHub Actions approach with eligible Netlify execution options. Moving work between Netlify functions does not itself reduce total Netlify duration. External execution transfers resource usage and introduces its own limits.
6. Preserve reservation/charge idempotency, durable completion, cancellation rules, artifact storage, and reliable cleanup. Do not run required long work as an untracked post-response promise.

**Non-breaking:** Users can recover job state without regenerating or paying twice; authorization remains current.
**Exit evidence:** Workload-level credit/latency comparison and crash/retry/reconnect/deadline tests; explicitly document the executor and all its quotas.

---

### Step 15: Evaluate scheduled, background, and durable workflow alternatives — ⏳ In Progress

> **Audit pass (2026-10-07):** Inventory complete — zero Netlify scheduled/background functions; scheduling runs on QStash (10 free schedules, idempotent `Upstash-Schedule-Id` upsert) plus 9 GitHub Actions cron workflows; job idempotency verified (DB unique keys, dedup IDs, generation locks, failed-generation sweeps). **Decision per §15.4: keep the existing executor** — no Netlify job migration. Deferred: Async Workloads billing-model study; known gap: the weekly email job lacks a send ledger for dedupe.

**Files:** Candidate `netlify/functions/` jobs, `netlify.toml`, cron/queue services, scheduler runbooks; existing external workflow configuration.
**Effort:** Medium–high; optional. **Savings driver:** Less redundant work or waiting, if demonstrated.

1. Correct eligibility assumptions: Scheduled Functions are available on all plans and use UTC schedules, running automatically only for published deploys. Their execution cap is 30 seconds. [Scheduled Functions](https://docs.netlify.com/build/functions/scheduled-functions/).
2. Background Functions are available on credit-based Free and can run up to 15 minutes. Returning `202` does not remove the background compute bill, and Netlify retries background functions automatically (documented as one retry after ~1 minute and another after ~2 minutes). The platform docs do not state an idempotency requirement for background functions, so idempotency is a **design requirement this project must implement**, not something the platform enforces. Legacy plan eligibility differs. [Background Functions](https://docs.netlify.com/build/functions/background-functions/).
3. Inventory all current schedules and providers; avoid running equivalent QStash and Netlify jobs simultaneously. Tune cadence, batch size, checkpoints, and overlap protection according to actual backlog and correctness needs. An empty frequent sweep still costs runtime.
4. Keep existing scheduling if reliable and cheaper overall. Native schedules may simplify administration but are not a savings mandate, and a platform-wide credit pause can also affect hosted maintenance.
5. Netlify Async Workloads offers durable steps and sleeps as a further option. Its workload functions are still Netlify functions; extra routing, reinvocations, persisted state, scheduler polling, and retries need a full usage model before adoption. Do not equate a durable sleep API with an ordinary `await sleep()` or assume the workflow is free. [Async Workloads overview](https://docs.netlify.com/build/async-workloads/overview/), [multi-step behavior](https://docs.netlify.com/build/async-workloads/multi-step-workloads/), [optional configuration](https://docs.netlify.com/build/async-workloads/optional-configuration/).
6. Use short dispatch-only scheduled handlers for longer work where appropriate; compare this extra invocation with the retained external scheduler. Extension eligibility is not an open question — Async Workloads is a Netlify Extension that can be enabled on any site and plan level; what must be verified before choosing it is the full billing/usage model (its provisioned functions and blobs are billed like any other provisioned resource) and all additional meters.

**Non-breaking:** Exactly one intended schedule owns each job; durable retries and settlement sweeps remain reliable.
**Exit evidence:** Scheduler inventory, cost/reliability decision, production/preview behavior, overlap/retry tests, and a reconciliation/rollback runbook. Mark the adoption portion skipped if the existing approach wins.

---

### Step 16: Benchmark selective backend lazy imports and smaller function graphs — ⏩ Skipped after assessment

> **Assessment (2026-10-07): deferred —** confirmed the all-eager graph (`src/routes/index.ts` statically imports all providers, six AI SDKs, `google-auth-library`, `franc`, …) and `pdfkit` externalization in `netlify.toml`. Without deployed before/after cold-start durations, restructuring the import graph risks auth-path regressions for unmeasured gains. Re-evaluate after Step 1 measurement; candidate list recorded in §8.

**Files:** Backend `src/app.ts`, `netlify/functions/api.mts`, `netlify.toml`, heavy route/service candidates, `package.json`; built function artifacts.
**Effort:** Medium. **Savings driver:** Conditional initialization/invocation duration reduction.

1. Inspect the deployed import graph and artifact sizes before changing imports. Identify heavy modules, eager client construction, barrel imports, unused code, templates/fonts, and native dependencies. **Known configuration:** backend `netlify.toml` already sets `node_bundler = "esbuild"`, externalizes `pdfkit`, ships its font data via `included_files`, and builds with Bun (`bun.lockb` detection, build command `bun run typecheck`) — so packaging decisions must respect the existing pdfkit workaround rather than re-deriving it.
2. Remove genuinely unused dependencies and unnecessary startup side effects first. Prefer supported granular package entrypoints; do not bypass package exports with brittle deep paths.
3. Trial inline imports for rarely exercised, optional features. Keep common lightweight/auth dependencies simple; keep current session/standing checks on every protected request.
4. Verify whether the actual Netlify bundler splits files or only defers initialization. Externalization can add filesystem/module resolution work and packaging hazards; it is not automatically an improvement. Netlify exposes packaging controls, while esbuild documents dynamic-import semantics. [Function bundling](https://docs.netlify.com/build/functions/configuration/#bundle), [esbuild](https://esbuild.github.io/api/#splitting), [AWS dependency guidance](https://aws.amazon.com/blogs/compute/optimizing-node-js-dependencies-in-aws-lambda/).
5. Consider a separate function for a heavy, infrequent workload only when isolation beats a single Hono graph. Preserve route/auth/CORS parity and account for separate cold instances, duplicated common dependencies, and added operational complexity. Do not split every route.
6. Benchmark a realistic route mix, common-route cold start, heavy-route first invocation, warm requests, and concurrent first use on production-compatible Node.js. Validate missing-file/import failure behavior and deployment rollback.

Illustrative intent only; audit the actual graph before applying:

```ts
// Only inside an authorized optional operation, after cheap validation.
const { renderExport } = await import('../services/export-renderer.js');
return renderExport(validatedInput);
```

Repeated module loading in an instance does not imply repeated evaluation, but client construction still needs separate review. Never cache request context or a positive authorization result in a reusable initializer.

**Non-breaking:** Heavy operations still work on a fresh instance; packaging and errors stay correct.
**Exit evidence:** Artifact/import analysis plus before/after duration and Netlify compute evidence. Retain the change only when overall savings or worthwhile latency improvement outweigh first-use and maintenance costs.

---

### Step 17: Defer optional frontend components and client libraries — ⏳ In Progress

> **Audit pass (2026-10-07):** Candidate libraries confirmed present (`@tiptap/*`, `@xyflow/react`, `recharts`, `html2canvas`); no chunk-size analysis is possible without a deployed bundle report, and lazy-loading risks above-fold/hydration regressions → no code changes this pass.

**Files:** Web optional feature components, dependency imports, `next.config.ts`, `package.json`; generated route chunks.
**Effort:** Low–medium. **Savings driver:** Initial bandwidth and browser work.

1. Use route/chunk analysis to identify libraries downloaded by users who never use their features. **Audited candidates present in `package.json`** (dependency presence is verified; actual chunk weight is not): TipTap (`@tiptap/*` — rich editors), `@xyflow/react` (graph canvas), `recharts` (admin analytics), `html2canvas` (export), plus editor/export tooling behind conditional panels. Verify each is genuinely conditionally rendered before changing anything.
2. Put deferred Client Components behind real conditional rendering/interaction, with `next/dynamic` and accessible loading/error states. Load large plain libraries on demand where appropriate. [Lazy loading](https://nextjs.org/docs/app/guides/lazy-loading).
3. Keep above-the-fold content and core reader controls responsive. Avoid broad `ssr: false`; reserve it for appropriate browser-only features and test deep links and hydration.
4. Preserve server-only boundaries so secrets and heavy backend SDKs never enter browser chunks. Compare supported package-import optimization with lazy loading; do not pile on custom bundler settings without artifact evidence.
5. Account for extra chunk requests, preloads/prefetch, repeat navigation, and browser cache reuse. Measure feature-open latency as well as initial bytes. An immediate dynamic component is not necessarily deferred bandwidth.

**Non-breaking:** Required content, accessibility, SEO, and feature error recovery remain usable.
**Exit evidence:** Smaller initial transferred bytes for representative visits, correct deferred-feature loading, no hydration failures, and acceptable interaction latency.

---

### Step 18: Consider narrowly scoped Edge Functions where they remove compute — ⏩ Skipped after assessment

> **Assessment (2026-10-07): skipped —** no new Edge Functions added. The adapter's middleware (`src/proxy.ts`) already runs at the edge; its matcher was narrowed instead (Steps 4/11), removing per-request edge work with no new code and no growth in edge-invocation allowlists. Revisit only if Step 1 shows a hot origin path.

**Files:** Candidate edge handler(s), backend/web `netlify.toml`, `src/proxy.ts`, routing/header declarations; generated adapter artifacts.
**Effort:** Medium–high; optional. **Savings driver:** Avoided serverless compute for suitable work.

1. Credit-based Edge Functions do **not** contribute to the compute meter; they are metered through web requests, with served bytes still subject to bandwidth. This makes them a meaningful conditional lever. They are also subject to a separate per-plan monthly **invocation allowance** visible in the usage & billing dashboard (exact quota varies by plan); edge responses configured for caching do not count toward that invocation allowance. [How credits work](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/), [Edge limits](https://docs.netlify.com/build/edge-functions/limits/).
2. Prefer platform redirects/headers/CDN delivery when no code is needed. Evaluate small redirects, header decisions, or a standalone genuinely lightweight public response only if an Edge Function removes origin invocation.
3. Respect the Deno-based runtime and dependencies; limits include 50 ms CPU per request, a 40-second response-header timeout, 512 MB shared deployed-edge memory, and 20 MB compressed code. Network waiting is excluded from the CPU limit, but latency, provider calls, and request/byte costs still matter. [Edge limits](https://docs.netlify.com/build/edge-functions/limits/), [Edge API](https://docs.netlify.com/build/edge-functions/api/).
4. Do not move the full Hono backend or CPU-heavy auth/export processing without compatibility and correctness proof. A geographically distributed edge that repeatedly calls an Ohio database can add latency rather than remove useful work.
5. Scope paths carefully and verify processing order with existing Next.js edge/proxy behavior. Before writing any new Edge Function, remember the adapter already runs Next.js middleware (`../Twistloom-web/src/proxy.ts`) at the edge — narrowing its matcher (Step 4) removes work without adding code, and every uncached edge response consumes part of the monthly edge invocation allowance. An edge layer that simply forwards to a Node function retains the Node compute bill. Durable cache is unavailable for Edge Function responses; cached edge responses need the appropriate edge declaration and deployed validation.

**Non-breaking:** An edge check never replaces authoritative protected backend enforcement; static assets and private data keep correct handling. Netlify custom headers — **including basic-authentication headers** — do not apply to edge function responses, and enabling Split Testing stops edge functions from executing entirely; verify that the private-site gate still covers every edge-declared path before rollout. [Edge limits](https://docs.netlify.com/build/edge-functions/limits/).
**Exit evidence:** Measured origin avoidance and net cost/latency improvement, path-order/runtime tests, and clear rollback. Skip if static delivery/cache or the existing adapter already solves the case.

---

### Step 19: Keep observability useful and inexpensive — ⏳ In Progress

> **Implementation pass (2026-10-07):** Vercel analytics preconnect/dns-prefetch hints now render only when `process.env.VERCEL` is set (Netlify visitors no longer warm dead Vercel origins; Vercel rollback parity preserved); backend `/` and `/health` verified zero-compute (lazy `/health/db`). Deferred: `warmAIProviders()` dead-code removal (never called; stale health-endpoint doc) pending owner confirmation; hot-path `console.*` gating pending log-volume data (Free log retention is 24 h).

**Files:** Existing logger, timing, sampling, deployment-verification scripts, and operational documentation candidates.
**Effort:** Low–medium. **Savings driver:** Earlier detection without costly telemetry fan-out.

1. Use billing for credits and Observability for requests/function behavior; they are different datasets. Netlify states that viewing Observability adds no usage charges and that it currently has no programmatic data access. [Observability](https://docs.netlify.com/manage/monitoring/observability/overview/).
2. Free's short history makes prompt capture important. Keep compact aggregate snapshots rather than assuming long retention or a Free log drain. Current pricing lists one-day Observability and 24-hour function log history. [Feature comparison](https://www.netlify.com/pricing/).
3. Sample useful low-cardinality timing data: route family, status, bytes, cold/warm approximation, cache status, upstream latency, job duration, and retries. Redact secrets and user payloads. Do not hash/store entire responses solely to measure savings.
4. Avoid one awaited remote telemetry request per application request. Batch or sample where delivery requirements allow, and include remaining async duration/egress in the model.
5. Use infrequent lightweight health checks and representative smoke tests. Avoid automatic cache-warming loops, continuous synthetic browsing, or checks that trigger paid jobs. Health alone is not authorization/cache-freshness evidence.

**Non-breaking:** Security-relevant and correctness-required records remain retained according to existing requirements.
**Exit evidence:** Enough data to reconcile usage trends and incidents, bounded telemetry overhead, redaction checks, and explicit retention limitations.

---

### Step 20: Validate savings, roll out incrementally, and define capacity limits — ⏳ In Progress

> **Verification run (2026-10-07):** Web — `pnpm typecheck` ✓, `pnpm lint` ✓ (0 errors; 2 pre-existing warnings in `tests/unit/_scratch_popover.test.tsx`), `pnpm test` 259/259 ✓, `pnpm build` ✓; backend — `bun run check` (lint + import-extensions + typecheck) ✓, `bun test` 439/439 ✓; ignore-gate harness 8/8 scenarios ✓. Deployed evidence (CDN hit rates, billing, private gates) still pending — no deploys or load tests triggered this pass.

**Files:** This roadmap, relevant migration/register records, targeted tests/verification scripts, and operational runbooks identified after implementation.
**Effort:** Medium, spread across rollout. **Savings driver:** Keeping only effective changes and avoiding regression-driven waste.

1. Give each change a baseline, expected affected meter, representative workload, correctness tests, rollback, and acceptance threshold. Compare like traffic and actual allocated duration; separate cold/warm and preview/production data.
2. Validate locally first, then on an authorized private preview using owner access. CDN hits, real function billing, runtime behavior, and private deployment gates require deployed evidence; report pending evidence honestly instead of publishing to remove the gate.
3. Run required repository checks for actual code changes and meaningful targeted tests — note that Next.js 16 removed `next lint` and `next build` no longer lints, so ESLint/`pnpm lint` must be an explicit CI step rather than an implicit build side effect. Include public/private cache isolation, logout/revocation/ban behavior, mutation freshness, job idempotency, localization, callback integrity, and deferred UI behavior as applicable.
4. Batch accepted improvements into a small number of production releases. Monitor the next comparable workload window and stop/revert changes that increase credits per useful action, failure rate, or unacceptable user latency.
5. Update each status only with source and verification evidence. Preserve separate `code complete / deployment evidence pending` records where needed; adopt no-change completions when existing code already meets the requirement.
6. Forecast realistic capacity including deploy reserve, bots, previews, idle jobs, and third-party quotas. If required usage cannot fit, choose an explicit scope/cadence reduction or paid capacity rather than assuming further micro-optimizations will solve it.
7. On a paid plan, evaluate region co-location and memory/vCPU using **allocated GB × duration**, not speed alone. Upgrade for demonstrated capacity/reliability needs; do not add paid-only options to the Free implementation checklist.

**Non-breaking:** Critical-path correctness, private hosting posture, and rollback remain explicit acceptance criteria.
**Exit evidence:** Coherent cycle forecast below the agreed envelope, measured successful changes, no material correctness/UX regression, and clearly listed unresolved owner-access evidence.

---

## 7. Open Questions

These are later audit/operational decisions, not requests to stop this research or publish the sites.

### Q1. What pricing model and team budget actually apply? — ⬜ Open

- **(A)** Both sites share a credit-based Free team: one 300-credit envelope; simplest default model.
- **(B)** Sites belong to different teams: separate confirmed envelopes and operational ownership; do not assume this topology.
- **(C)** Legacy plan: different quotas/eligibility; current credit calculations do not apply directly.

**Recommendation:** Verify in the owner-access dashboard before any budget-driven implementation. Use A only as this document's provisional planning assumption; do not reorganize accounts to evade limits. Treat C as a live branch, not a formality: accounts created before **2025-09-04** are Legacy by default, Legacy rates/eligibility differ from every table in §3.1, and the credit-based switch **cannot be reverted**.

---

### Q2. Which meter should drive the first implementation batch? — ⬜ Open

- **(A)** Release/bandwidth waste dominates: prioritize Steps 3–6.
- **(B)** Public SSR/API work dominates: prioritize Steps 7–12.
- **(C)** Long jobs or blocked/abusive work dominates: prioritize Steps 4 and 13–15.

**Recommendation:** Measure first, then choose the highest projected credit saving per effort at acceptable risk. Keep selective imports behind larger demonstrated opportunities.

---

### Q3. How much public staleness is acceptable? — ⬜ Open

- **(A)** Per-representation finite TTL plus scoped invalidation: practical catalogue/read caching.
- **(B)** Very short TTL/no stale window: less reuse, tighter public freshness.
- **(C)** No shared caching: appropriate where confidentiality or immediate withdrawal cannot tolerate stale delivery.

**Recommendation:** A for explicitly approved public data, C for protected/immediate-withdrawal representations, with exact freshness limits decided before extending TTLs. Validate both sites' cache layers.

---

### Q4. Should long jobs keep the existing executor or move to Netlify? — ⬜ Open

- **(A)** Retain existing documented queue/external execution: fewer changes; separate quotas remain.
- **(B)** Native scheduled/background functions: simpler hosting administration; billed duration and hard caps remain.
- **(C)** Netlify Async Workloads: durable-step orchestration; additional machinery and meters require evaluation.

**Recommendation:** Retain A unless workload-level cost, recovery, and operational evidence favors B/C. Returning `202`, moving a task after response, or replacing a scheduler alone does not prove savings.

---

### Q5. Are heavy import paths common enough to keep eager loading? — ⬜ Open

- **(A)** Static granular imports: simple and suitable for frequently used lightweight paths.
- **(B)** Inline lazy import: suitable for optional expensive initialization without restructuring routes.
- **(C)** Separate function/worker: stronger heavy-work isolation with additional release/runtime complexity.

**Recommendation:** Compare A/B on audited heavy candidates; consider C only if artifacts and cold/common-route measurements show a material additional benefit.

---

### Q6. What operating reserve and release cadence are acceptable? — ⬜ Open

- **(A)** Start with a 210-credit planned envelope and 90-credit reserve: more protection from spikes, fewer elective releases.
- **(B)** Allocate more to planned traffic/releases: greater utilization with smaller incident headroom.
- **(C)** Paid capacity when measured demand requires it: higher ongoing budget and potentially additional controls.

**Recommendation:** Start with A as an illustrative policy and replace its allocations using real traffic and delivery needs. Move to C if required workload cannot fit without harming promised behavior.

---

## 8. References & File Touch List

### Research sources

All below are primary vendor/tool documentation, checked on **2026-10-05** and **re-verified on 2026-10-07**. Pricing/account UI take precedence for the actual account. Feature availability, runtime support, and rates must be rechecked when execution begins. Older AWS articles establish engineering principles only; their benchmarks and direct Lambda billing are not Netlify guarantees. Recommendations, priorities, and worked examples are this roadmap's analysis, not vendor-provided project savings.

| Source | Supports |
|--------|----------|
| [Netlify pricing](https://www.netlify.com/pricing/) | Current Free allowance, rates, feature/retention comparison |
| [How credits work](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/) | Deploy exceptions, runtime meters, previews, Edge compute distinction |
| [Credit-based pricing plans](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/) | Plan-specific meters and optional consumers |
| [Monitor credit usage](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/monitor-usage-for-credit-based-plans/) | Team aggregation and documented notifications |
| [Billing FAQ](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/billing-faq-for-credit-based-plans/) | Billing policy; alert wording differs from monitoring page |
| [AI feature pricing](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/pricing-for-ai-features/) | Gateway/Agent inference and Agent compute |
| [Function configuration](https://docs.netlify.com/build/functions/configuration/) | Runtime defaults, payloads, region, memory/vCPU, bundle controls |
| [Function billing](https://docs.netlify.com/build/functions/usage-and-billing/) | Allocated-memory/duration calculation; Legacy differences |
| [Functions API](https://docs.netlify.com/build/functions/api/) | Async `waitUntil()` duration and handler configuration |
| [Ignore builds](https://docs.netlify.com/build/configure-builds/ignore-builds/) | Exit-code semantics, environment restrictions, build-hook exception |
| [Rate limiting](https://docs.netlify.com/manage/security/secure-access-to-sites/rate-limiting/) | Free code rules and targeting/aggregation limits |
| [Next.js on Netlify](https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/) | Adapter-generated functions, Next caches/revalidation, Image CDN |
| [Image CDN](https://docs.netlify.com/build/image-cdn/overview/) | Image delivery/transformations and integration guidance |
| [Caching overview](https://docs.netlify.com/build/caching/caching-overview/) | Durable cache, invalidation, variation, precedence, deployment behavior |
| [Cache API](https://docs.netlify.com/build/caching/cache-api/) | Optional reuse of selected internal responses/fetches |
| [CDN caching knowledge base](https://www.netlify.com/knowledge-base/how-to-control-cdn-caching-on-netlify/) | Safe policy and cache debugging |
| [Advanced caching guide](https://developers.netlify.com/guides/advanced-caching-made-easy/) | Tags, conditional delivery, immutable asset policy |
| [Scheduled Functions](https://docs.netlify.com/build/functions/scheduled-functions/) | Availability, UTC, published deploys, 30-second limit |
| [Background Functions](https://docs.netlify.com/build/functions/background-functions/) | Credit-based Free availability, 15-minute runs, retries, `202` |
| [Async Workloads overview](https://docs.netlify.com/build/async-workloads/overview/) | Optional durable orchestration |
| [Multi-step workloads](https://docs.netlify.com/build/async-workloads/multi-step-workloads/) | Steps, sleeps, and reinvocation model |
| [Async Workloads configuration](https://docs.netlify.com/build/async-workloads/optional-configuration/) | Scheduler polling and operational controls |
| [Observability overview](https://docs.netlify.com/manage/monitoring/observability/overview/) | Billing separation, no-charge viewing, no programmatic access |
| [Edge limits](https://docs.netlify.com/build/edge-functions/limits/) | CPU, memory, code-size, header timeout, compatibility caveats |
| [Edge API](https://docs.netlify.com/build/edge-functions/api/) | Deno runtime, routing and async API behavior |
| [Next.js lazy loading](https://nextjs.org/docs/app/guides/lazy-loading) | Client/server dynamic-import distinctions and SSR constraints |
| [Next.js prefetching](https://nextjs.org/docs/app/guides/prefetching) | Speculative fetch behavior and opt-out tradeoffs |
| [Next.js production guide](https://nextjs.org/docs/app/guides/production-checklist) | Static rendering and bundle optimization |
| [Next.js cookies API](https://nextjs.org/docs/app/api-reference/functions/cookies) | Request-dependent rendering considerations |
| [esbuild splitting](https://esbuild.github.io/api/#splitting) | Inline import does not guarantee separate chunks |
| [AWS initialization optimization](https://aws.amazon.com/blogs/compute/operating-lambda-performance-optimization-part-2/) | Selective/lazy initialization principles |
| [AWS Node.js dependency optimization](https://aws.amazon.com/blogs/compute/optimizing-node-js-dependencies-in-aws-lambda/) | Bundle/import-graph considerations |
| [AWS Lambda best practices](https://docs.aws.amazon.com/lambda/latest/dg/best-practices.html) | Safe resource reuse and stateless execution |
| [Neon serverless driver](https://neon.com/blog/serverless-driver-ga) | HTTP/WebSocket mode considerations |
| [Neon latency guidance](https://neon.com/blog/how-to-minimise-the-impact-of-database-latency) | Dependency distance and connection/query tradeoffs |

### Fact-check log (2026-10-07)

Read-only re-verification of every platform claim against vendor docs, plus a path/source audit of both repositories. Items marked "corrected" were changed in the text above.

| Original claim | Verdict | Action |
|----------------|---------|--------|
| Rate-limit rules "can be declared in `netlify.toml` or as a `rateLimit` block" | **Wrong for functions** — Netlify: "rate limits for functions cannot be defined in the `netlify.toml` configuration file" (`[redirects.rate_limit]` is redirects-only); per-domain aggregation is Enterprise/HP-Edge | Corrected in Step 4; added path-only targeting, ~10 s enforcement lag, existing Upstash layer |
| "Cache hits still consume this meter" stated as documented fact | Rate documented (2 credits/10,000); **no** documented cache-hit exemption either way | Rephrased as a conservative budget assumption in §3.1 |
| "Netlify-specific cache headers outrank generic ones" (implying `Vary` too) | Cache-*control* precedence is real (`Netlify-CDN-Cache-Control` > `CDN-Cache-Control` > `Cache-Control`), but `Netlify-Vary` and `Vary` are **both** honored when present | Corrected in Step 7 |
| Cross-deploy "`Netlify-Cache-ID` persistence" | Real, but it is the documented **opt-out of automatic deploy invalidation** for function/proxy responses (IDs auto-register as purge tags) | Clarified in Step 8 |
| "automatic retry requires idempotency" (background functions) | Platform documents automatic retries (~1 min, then ~2 min) but **no** idempotency requirement | Reframed as our design requirement in Step 15 |
| "Both projects … they remain private" | Backend 401 via **Netlify Edge Access Control**; web `twistloom-web.netlify.app` returned **404 (site not created)** on 2026-10-05 and its first build failed on 2026-10-07 | Corrected in §2 and Step 1 |
| Usage notices "50/75/100, FAQ also 90" | Both official pages exist and **disagree** (monitoring page vs FAQ) | Stated explicitly as a documentation disagreement in §3.1 |
| Region default "sites created before 2023-10-04 may differ" | **Verified** verbatim in function configuration docs | Kept |
| — | Missing Free-plan constraints discovered | Added §3.1 "Additional Free-plan constraints" (1 concurrent build, 1 owner seat, build minutes not metered, no deploys while paused, Preview Server compute, Pro-gated security features, Free firewall rule caps) |
| Next.js guidance was version-agnostic | Project is **Next.js 16.3.1** without `cacheComponents` | Made Step 9/20 version-specific (classic model, sync `cookies()` removed, 2-arg `revalidateTag`, `next lint` removed) |
| §2 "no deep source audit" | Path/source audit performed 2026-10-07 | Evidence boundary and §2 baseline updated; §8 candidate paths all confirmed to exist |

**Verified unchanged** (spot-checked, no edit needed): 300-credit pool and all five meter rates; 15-credit deploy with failed/rollback exceptions; preview deploys at 0 deployment credits; 1024 MB allocation billing; 60 s/30 s/15 min limits and payload sizes; 180 credits/USD AI meter; Edge Functions off the compute meter plus separate invocation allowance; edge limits (50 ms CPU, 40 s header timeout, 512 MB per set, 20 MB code); `durable` unsupported for edge responses; `basic-auth` disables site caching; purge rate limit of 2 per 5 s; `waitUntil()` duration billing; ignore-builds exit codes and build-hook bypass; scheduled functions on all plans/UTC/published-only; Async Workloads as an installable Extension billed like other provisioned resources; Image CDN for `next/image`; Observability free-to-view with no programmatic access; 1-day/24-hour Free retention; credit math in §3.2 (13.89, 27.78, 635, 210/90 examples all re-derived correctly).

### Implementation pass log (2026-10-07)

Non-breaking, locally verifiable changes only; nothing was deployed. Per-step scope and deferrals are recorded under each heading in §6; risky or account-blocked items were deliberately deferred (§9).

| Repository | Files changed | Purpose |
|------------|---------------|---------|
| Backend | `netlify.toml`, `scripts/netlify-ignore.sh` (new) | Step 3 ignore-builds gate (exit 0 = skip, non-zero = build); Step 4 `rate_limit` note; `robots.txt` 24 h CDN cache header |
| Backend | `src/config/timeouts.ts` (new), `src/utils/translation.ts`, `src/utils/embedding.ts`, `src/utils/github-workflow.ts`, `src/services/neon-usage.ts`, `src/services/forum-queue.ts`, `src/services/store-verification/google-play.ts`, `src/services/store-verification/app-store.ts`, `src/cron/ensure-qstash-schedules.ts` | Step 13 outbound timeouts via `AbortSignal.timeout` (11 call sites in 8 files), durations centralized as 7 JSDoc'd constants in `src/config/timeouts.ts`; `retryWithBackoff` semantics preserved because `TimeoutError` is already classified retryable |
| Web | `src/proxy.ts` | Steps 4/11 — matcher narrowed to all `/_next`; `auth()` skipped on non-protected routes |
| Web | `netlify.toml`, `scripts/netlify-ignore.sh` (new) | Step 3 ignore-builds gate |
| Web | `src/app/serwist/[path]/route.ts` | Step 5 — precache `globIgnores` for `public/images/**` + `public/videos/**`; deterministic SW revision fallback (`COMMIT_REF` instead of `randomUUID()`) |
| Web | `next.config.ts`, `src/app/layout.tsx` | Step 5 — unused `i.pravatar.cc` remotePattern removed; Vercel preconnect/dns-prefetch hints gated on `process.env.VERCEL` (Step 19) |

**Verification (all local; nothing deployed):**

| Check | Result |
|-------|--------|
| Backend `bun run check` (lint + import-extensions + typecheck) | Pass |
| Backend `bun test` | 439 pass / 0 fail |
| Web `pnpm typecheck` | Pass |
| Web `pnpm lint` | 0 errors (2 pre-existing warnings in `tests/unit/_scratch_popover.test.tsx`) |
| Web `pnpm test` | 259 pass |
| Web `pnpm build` + Serwist precache-manifest inspection | Pass; precache 38.16 MB/233 → 8.83 MB/135 entries; zero `public/images`/`public/videos` entries; `/en/offline` + `/id/offline` retained |
| Ignore-gate harness (8 scenarios against scratch git repos) | 8/8 expected exit codes |

### Actual documentation changes in this task

| File | Change |
|------|--------|
| `docs/roadmap/NETLIFY_FREE_TIER_OPTIMIZATION_ROADMAP.md:1` | **NEW** — researched plan for both applications. Revised 2026-10-07: platform claims re-verified, both repositories path-audited, inaccuracies corrected (see fact-check log), web-specific evidence added; implementation-pass statuses, per-step notes, and the §8 implementation log added |
| `docs/roadmap/NETLIFY_MIGRATION_ROADMAP.md`, §11 | Companion link and notice that this roadmap supersedes its joint-budget/cache-cost examples; existing completion statuses retained |

### Existing references, not changed

- `docs/roadmap/VERCEL_FLUID_ACTIVE_CPU_OPTIMIZATION_ROADMAP.md:1` — historical optimization context.
- `../Twistloom-web/docs/roadmap/OPEN_FINDINGS_REGISTER.md:1` — separate findings status and evidence tracking.
- `.agents/skills/roadmap-doc/SKILL.md:1` — canonical roadmap structure used here.

### Candidate future touch areas — no edits authorized by this document itself

| Area | Candidate paths / location | Assessment purpose |
|------|----------------------------|--------------------|
| Backend deployment | `netlify.toml`, `netlify/functions/api.mts`, `package.json` | Routing, rate limits, build policy, artifacts, runtime compatibility |
| Backend composition | `src/app.ts`, relevant `src/routes/` and `src/services/` files | Import graph, long work, dependency round trips |
| Backend cache | `src/utils/netlify-cache.ts`, `src/middleware/cache.ts`, `src/services/cache.ts` | Existing public caching, tags, invalidation and isolation |
| Backend operations | Relevant `src/cron/`, `scripts/verify-deployment.ts`, targeted existing tests | Schedule overlap, verification, telemetry and recovery |
| Web deployment | `../Twistloom-web/netlify.toml`, `../Twistloom-web/next.config.ts`, `../Twistloom-web/src/proxy.ts` | Generated infrastructure, public rendering, images, path scope |
| Web fetching | `../Twistloom-web/src/lib/services/api.ts`, `src/lib/query-client.ts`, `src/lib/config/polling.ts` within web | Transport hops, coalescing, polling and refetch policy |
| Web delivery | `../Twistloom-web/src/app/`, `src/components/`, `src/lib/config/image.ts`, `src/lib/utils/image-url.ts` within web | Public routes/metadata, deferred UI, media bytes |
| Web verification | `../Twistloom-web/scripts/verify-deployment.mjs`, relevant tests identified later | Private deployed checks and regressions |
| External operations | Netlify team/site settings; existing Neon/Redis/media/queue accounts | Actual quotas, budgets, regions and optional product usage |

**Edited by the 2026-10-07 implementation pass (full list in §8):** backend `netlify.toml`, `scripts/netlify-ignore.sh` (new), and eight `src/` files (§8 implementation log); web `netlify.toml`, `scripts/netlify-ignore.sh` (new), `next.config.ts`, `src/proxy.ts`, `src/app/layout.tsx`, `src/app/serwist/[path]/route.ts`. Everything else in the table above remains untouched.

Unqualified paths in this document refer to the backend unless explicitly marked web. Directory families are candidates, not a comprehensive approved edit list. Exact file/line targets and any new helper/test files must be recorded after grounding; no guessed line numbers or claims of discovered source bugs are included.

---

## 9. Completion Status

Legend: ✅ Completed and verified · ⏳ In progress / partial · ⬜ Planned · ⏩ Skipped after assessment

### Completed

- ✅ **Research/documentation only:** Official pricing/runtime/caching/framework guidance checked; one combined budget model, selective-lazy-import guidance, and ordered audit/implementation candidates documented.
- ✅ **Fact-check + source audit (2026-10-07):** Every platform claim re-verified against vendor docs; six claims corrected or sharpened (rate-limit declaration surface, cache-hit metering wording, `Vary` precedence, `Netlify-Cache-ID` semantics, background-function idempotency, "both sites private"), the 90%-notification page disagreement surfaced, missing Free-plan constraints added, and all referenced paths in both repositories confirmed to exist. Full log in §8.
- ✅ **Safe-subset implementation pass (2026-10-07):** Step 3 (ignore-builds gate in both repos, harness-verified 8/8), Steps 4/11 (proxy matcher narrowing + auth skip on public routes), Step 5 (Serwist precache 38.16 MB → 8.83 MB, deterministic SW revision, pravatar removal), Step 7 (partial: `robots.txt` 24 h cache header), Step 13 (eight outbound timeout groups), Step 19 (Vercel preconnect gating) implemented. Step 10 closed as a no-change completion (audit found all polling/refetch requirements already met). Full file list and verification matrix in §8.
- ✅ **Local verification (2026-10-07):** backend `bun run check` + 439 tests; web typecheck + lint (0 errors) + 259 tests + build; no deploys, load tests, or account changes triggered.

### In Progress

- ⏳ **Steps 1, 4, 5, 7, 8, 9, 11, 13, 15, 17, 19, 20:** partially implemented or audited this pass. Remaining work is either account-blocked (measurement, dashboards, deployed evidence) or deliberately deferred as risky — each step heading in §6 carries an "Implementation/Audit/Assessment" note stating exactly what is done and what is deferred.

### Future / Deferred

- ⬜ **Account-blocked (Steps 2, remainder of Steps 1/3):** plan confirmation, credit budgets and guardrails, usage baselines, release/preview inventory — requires owner Netlify account access.
- ⏩ **Deferred as risky — revisit only after Step 1 evidence:** Step 9 static-rendering refactor (largest identified lever; requires relocating `headers()`-based locale derivation and `cookies()`-dependent public fetches together, or the change yields zero benefit / risks cross-user data leakage); Steps 7/8 cache-header + purge-tag fixes (need a guard test and deployed purge verification); Step 13 payment-path timeouts and SDK retry layering (payment/idempotency risk); Step 16 lazy-import graph restructuring (auth-path risk without deployed cold-start baselines); Step 17 chunk-based code-splitting (needs deployed bundle report; above-fold/hydration risk); Step 18 new Edge Functions (assessed: middleware matcher narrowing suffices for now).
- ⬜ **Measurement-gated (Steps 6, 12, 14):** upload passthrough product decision, dependency round trips, streaming transport comparison — all require Step 1 data first (§6 waiting rules).

**Completion rule:** A suggestion is not a confirmed finding. A documented migration completion is not newly reverified deployment evidence. This roadmap becomes implementation-complete only when applicable items are implemented/verified or deliberately skipped with rationale, and remaining account/private-site evidence is identified explicitly.
