<div align="center">

<table>
<tr>
<td>
<img src="https://twistloom-web.vercel.app/images/logo/logo_192.png?raw=true" width="100"/>
</td>
<td>

<p align="left" style="font-family: Georgia, Cambria, 'Times New Roman', Times, serif; font-size: 32px; font-weight: bold; margin-bottom: 0">
  Twistloom
</p>

</td>
</tr>
</table>

[![Twistloom](https://img.shields.io/badge/🩸_Twistloom-AI_Horror_Interactive_Fiction-7c3aed?style=for-the-badge&labelColor=1a0533&logoColor=white)](https://twistloom-web.vercel.app)
[![Stack](https://img.shields.io/badge/Stack-Next.js_16_•_Hono_•_Neon_•_Upstash-a78bfa?style=for-the-badge&labelColor=0d0d1a)](https://twistloom-web.vercel.app)
[![AI](https://img.shields.io/badge/AI-8_LLM_Providers-6d28d9?style=for-the-badge&labelColor=0d0d1a)](https://twistloom-web.vercel.app)

![Bun](https://img.shields.io/badge/Bun-1.3+-f9f9f9?logo=bun&logoColor=white&labelColor=14151a)
![TypeScript](https://img.shields.io/badge/typescript-blue?logo=typescript)
![Hono](https://img.shields.io/badge/hono-E36002?logo=hono&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/postgresql-336791?logo=postgresql)
![Drizzle ORM](https://img.shields.io/badge/drizzle-ff6b00?logo=drizzle)
![Vercel](https://img.shields.io/badge/vercel-000000?logo=vercel)
![License](https://img.shields.io/badge/license-proprietary-red)

</div>

<div style="background: #0d1117; border: 1px solid #30363d; border-radius: 10px; padding: 16px; margin-bottom: 20px; color: #c9d1d9;">

<p align="center" style="font-family: Georgia, Cambria, 'Times New Roman', Times, serif; font-size: 16px; font-weight: 500; margin-bottom: 0; text-align: center; color: red">
  An AI-powered psychological horror interactive fiction platform. The story adapts to every choice — powered by a multi-LLM waterfall, narrative momentum engine, and adaptive health systems.
</p>

</div>

A sophisticated psychological thriller branching story engine backend that delivers immersive, AI-powered interactive narratives. Built with cutting-edge TypeScript and modern web technologies, this platform creates dynamic, choice-driven stories where readers' decisions shape the outcome through intelligent character psychology, environmental storytelling, and multi-layered horror mechanics. The system leverages advanced AI providers to generate compelling content that adapts to user choices while maintaining narrative consistency and psychological depth.

Twistloom is not merely a branching story platform. It is a multiverse storytelling engine where the same decision can lead to different realities, making every reader's journey potentially unique.

[![Typing SVG](https://readme-typing-svg.herokuapp.com?font=Fira+Code&weight=500&size=16&pause=1200&color=A78BFA&center=true&vCenter=true&repeat=true&width=700&height=70&lines=🎭+Building+AI-powered+psychological+horror+fiction;🤖+Multi-LLM+orchestration+across+8+providers;⚡+Next.js+16+%7C+React+19+%7C+TypeScript;🧠+Narrative+engines%2C+momentum+systems+%26+story+AI;🩸+Where+every+choice+rewrites+the+horror...)](https://git.io/typing-svg)

## 🌐 URLs

- **Backend API**: https://twistloom-backend.vercel.app
- **Frontend Web**: https://twistloom-web.vercel.app

## 🏗️ Tech Stack

### **Technologies**

| Choice | Version | Why |
|--------|---------|-----|
| 💻 **TypeScript** | 6.0+ | Type safety, modern features, and excellent IDE support |
| 🐰 **Bun** | 1.3+ | All-in-one JS runtime — fast dev server, native TypeScript, package manager, and test runner |
| 🔥 **Hono.js** | 4.12+ | Ultra-fast, runtime-agnostic web framework with first-class TypeScript and native Bun support |
| 🗄️ **Neon (Postgres)** | 18 | Serverless, auto-scaling, and excellent TypeScript support |
| 🔧 **Drizzle ORM** | 0.45+ | Type-safe, excellent migrations, and modern query builder |
| 🚀 **Vercel** | Node.js runtime | Stable serverless execution via custom `IncomingMessage` → `Request` adapter |

### **AI Providers**

| Provider | Purpose |
|----------|---------|
| 🥇 **Mistral** | Primary prose — best creative writing with natural character voices |
| 🥇 **Google Gemini** | Large context (1M tokens), fast, excellent world-building |
| 🔌 **OpenRouter** | Unified gateway — Qwen, Llama-4, DeepSeek, Nemotron + Gemini |
| 🥈 **Cerebras** | High-speed inference for GLM-4.7 with toggleable reasoning |
| 🥈 **Groq** | Low-latency Llama-4 / Qwen / GPT-OSS models at 10M token context |
| 🥈 **NVIDIA** | Cost-effective Llama-3.3 on NIM catalog |
| 🥉 **Cloudflare Workers AI** | Edge inference for Mistral-7B / Llama-3.1 / Gemma at low latency |
| 🥉 **Cohere** | Last-resort fallback — Command-R |

## 🔥 Why Hono over Express

The backend was migrated from **Express.js** to **Hono.js** while keeping every feature intact (Stripe payments, NextAuth/Auth.js session verification, Drizzle ORM, Server-Sent Events, and multipart image uploads). Hono's runtime-agnostic design made the subsequent Bun migration seamless.

### Why we switched

- **Runtime freedom.** Hono runs on any JavaScript runtime (Node.js, Bun, Deno, Workers, Vercel Edge) from a single codebase. Express is effectively Node-only, which locked deployment choices in.
- **Serverless-native.** Hono ships first-class adapters. The same app serves as a Vercel deployment and a local dev server (`Bun.serve()`) without custom shims. Express's monolithic `listen()` model fights the short-lived, per-request serverless model.
- **Performance & cold starts.** Hono's tiny surface and zero-dependency core start faster and use less memory than Express + its middleware chain.
- **First-class TypeScript.** Route params, query, body, environment, and middleware bindings are inferred through `AppEnv` (`src/hono/env.ts`), so handlers get a fully typed `c` instead of loosely-typed `req`/`res` augmentation.
- **Batteries included.** Built-in CORS, streaming/SSE (`hono/streaming`), and `@hono/auth-js` for cookie-based Auth.js verification replaced hand-rolled Express middleware.
- **Ergonomic helpers.** `c.json()`, `c.req.param()/query()/header()`, and typed `c.get()/c.set()` variables remove the boilerplate of `req.body`/`res.status().json()` and `wrapAsync`.
- Read more on https://solodevstack.com/blog/hono-vs-expressjs-solo-developers

### Migration notes

- JSON body parsing, locale extraction, rate limiting, and upload handling are now Hono middleware (`src/middleware/*`).
- Express error helpers were replaced by `c*` helpers in `src/utils/error.ts` (`cApiError`, `cValidationError`, `cNotFoundError`, etc.) that return a Hono `c.json(...)` response.
- SSE routes (`POST /api/books/stream`, `GET /api/books/prompt`, `GET /api/books/:identifier/:pageId/candidates`) use Hono's native `streamSSE`.
- `multer` uploads were replaced by a small `parseBody`-based middleware that exposes the file on `c.get("file")`.

## 🐰 Bun Migration

The backend was migrated from **Node.js + pnpm + tsx** to **Bun** (runtime + package manager + dev server). The migration took advantage of the existing Web API-compliant codebase (already migrated from Express to Hono) and Hono's runtime-agnostic architecture.

### Why Bun

| Reason | Impact |
|--------|--------|
| **Native TypeScript** | No `tsx` transpilation step — Bun runs `.ts` files directly |
| **Faster installs** | `bun install` is ~80% faster than `pnpm install` on cold cache |
| **Lower cold starts** | Bun runtime on Vercel starts in ~50-200ms vs ~300-800ms on Node.js |
| **Single toolchain** | Bun replaces pnpm + tsx + node with one binary |
| **Web API native** | Bun's `Bun.serve()` and native `fetch` align perfectly with Hono's Request/Response model |

### Migration scope

| Phase | Change | Status |
|-------|--------|--------|
| 1 — Package manager | `pnpm` → `bun install`, lockfile `pnpm-lock.yaml` → `bun.lock` | ✅ |
| 2 — Local dev | `tsx watch` + `@hono/node-server` → `bun --watch` + `Bun.serve()` | ✅ |
| 3 — Vercel deployment | Custom `IncomingMessage` → `Request` adapter in `api/index.ts` | ✅ |

> **Note on runtime decisions:** Vercel's Bun runtime was initially attempted but had ESM module linking failures. The `hono/vercel` adapter was also tried but its `handle()` doesn't properly convert `IncomingMessage` → `Request` on the Node.js runtime, causing `this.raw.headers.get()` to fail. The final architecture uses a **custom conversion handler** in `api/index.ts` — the same well-tested pattern from the pre-migration codebase. This is the most stable path while still benefiting from Bun's faster local dev cycle.

### Dependencies removed

`@hono/node-server`, `undici`, `tsx`, `@types/express` — all replaced by Bun's built-in capabilities.

### Vercel deployment

The app is deployed on the **Node.js runtime** via a custom handler in `api/index.ts`. Vercel's Node.js Serverless functions receive `(IncomingMessage, ServerResponse)`, but Hono expects a Web API `Request`. The handler converts between the two.

**Why not `hono/vercel` `handle()`?** The adapter passes the raw request through without conversion. On the legacy Node.js Serverless path, the `IncomingMessage` reaches Hono as `c.req.raw`, and `c.req.raw.headers.get()` throws because `IncomingMessage.headers` is a plain object with no `.get()` method.

**Why not `@hono/node-server` `getRequestListener`?** It wraps `IncomingMessage` in a `ReadableStream` via `Readable.toWeb()`. On Vercel's Node.js runtime the body is already pre-buffered, so the stream's end/data events never fire — the body-read promise hangs until Vercel's platform timeout.

#### Hybrid architecture

| Layer | Runtime | Purpose |
|-------|---------|---------|
| Local development | **Bun** | Fast dev server (`bun --watch`), native TypeScript |
| Package management | **Bun** | `bun install` (~80% faster than pnpm) |
| Production (Vercel) | **Node.js** | Stable, battle-tested serverless execution |

#### Web API migration (pre-existing)

The codebase was originally migrated to be Edge Runtime-compatible, systematically replacing Node.js-only APIs. This foundation made the Hono migration seamless and keeps the door open for future runtime changes:

| Blockers Replaced | Web API-Compatible Alternative |
|-------------------|-------------------------------|
| `@imagekit/nodejs` SDK | ImageKit REST API via `fetch` |
| `bcrypt` native addon | `bcryptjs` (pure JS, identical API) |
| `Buffer` (9+ usages) | `Uint8Array`, `TextEncoder`/`TextDecoder`, Web `atob()` |
| `crypto.createHash` | `crypto.subtle.digest("SHA-256")` (Web Crypto) |
| `fs`/`path` (constants + ai-image) | `process.env['npm_package_version']`; dynamic `import()` |
| `@actions/core` `group()` | `edgeGroup.wrap()` with `::group::` markers |
| `process.uptime()` / `.memoryUsage()` / `.version` | `typeof` guards + `Date.now()` startup timestamp |
| Stripe default HTTP client | `Stripe.createFetchHttpClient()` |
| Neon WebSocket (`ws` package) | `neonConfig.webSocketConstructor = globalThis.WebSocket` |
| `@hono/node-server` entrypoint | Bun's `Bun.serve()` (local) / custom `IncomingMessage` → `Request` adapter (production) |

#### Configuration

- **Vercel dashboard → Framework Preset → "Hono"**.
- **Build Command** — leave empty (Vercel auto-detects `bun install` from `bun.lock`).
- **Install Command** — leave empty.
- **Output Directory** — leave default (no override).

## 🚀 Features

### **Story Generation & Multiverse Narrative Engine**

* **AI-Powered Psychological Thrillers**: Dynamically generated stories designed around tension, uncertainty, and psychological horror
* **Multiverse Story Architecture**: Every choice can produce multiple alternative futures rather than a single predetermined outcome
* **Alternative Fate Generation**: Multiple AI-generated continuations are created for a single action, allowing parallel narrative possibilities
* **Unique Reader Experiences**: Two readers making the same decisions may still experience different story outcomes
* **Meaningful Consequences**: Choices influence character psychology, relationships, world state, and future narrative opportunities
* **Dynamic Character Development**: Evolving character personalities, motivations, relationships, and hidden agendas
* **Psychological Profiling**: Tracks fear, trust, paranoia, trauma, and other hidden psychological variables
* **Sanity (Composure) System**: Engine-owned resource (0-100) that decays under horror and recovers in safe moments — a ticking-clock mechanic that never relies on AI-authored state
* **Replayable Narratives**: Readers can revisit the same story and uncover entirely different paths, revelations, and endings
* **Emergent Storytelling**: Narrative outcomes are generated rather than scripted, enabling unexpected twists and discoveries

### **Branching & State Management**

* **Page-Based Story States**: Every page stores its own narrative state for precise reconstruction
* **Parent-Child Page Relationships**: Flexible branching architecture supporting complex narrative trees
* **Branch-Aware Progression**: Independent state evolution across diverging story paths
* **Character Memory System**: Persistent tracking of relationships, interactions, and emotional history
* **Location Tracking**: Consistent environmental storytelling with location-aware narrative generation
* **Trauma & Psychological Systems**: Dynamic mental state progression influencing future story events
* **Alternative Fate Persistence**: Multiple possible outcomes can coexist from the same decision point
* **Deterministic Reconstruction**: Any branch can be reconstructed exactly from stored state history
* **Hybrid Delta + Checkpoint Architecture**: Snapshots every 5 pages + incremental deltas for 90% faster state reconstruction

### **Story Bible Architecture**

* **Structured Narrative Foundation**: Characters, threads, future notes, viable endings, facts, and places created at book initialization
* **Four Independent Layers**: Character profiles, narrative threads, world facts, and viable endings — each page-generation AI builds upon across stateless requests
* **Persistent Lore**: Story Bible content carried through every generation call for narrative consistency

### **Asynchronous Candidate Generation**

* **Background Multiverse Expansion**: Alternative futures generated asynchronously before readers reach them
* **GitHub Workflow Processing**: On-demand GitHub Actions with 30-minute timeout for reliable async generation
* **Timeout Prevention**: Eliminates Vercel execution limits through background processing
* **Deployment-Aware Strategy Pattern**: Automatic adaptation between Vercel, GitHub Actions, and cron environments
* **Distributed Locking**: Prevents duplicate generation and concurrent branch conflicts
* **Pending Generation Tracking**: Database-driven generation management without external job queues
* **Real-Time Progress Updates**: SSE-based progress monitoring for generation status
* **Automatic Retry Logic**: Stale-detection self-healing re-dispatches failed workflow runs
* **Multi-Level Pre-Generation**: Future story branches generated ahead of time for near-instant reader progression
* **Scalable Branch Expansion**: Supports large branching structures without impacting reader performance

### **On-Demand Async Book Creation**

* **HTTP 202 Acceptance**: Book creation starts immediately, responds with book ID before generation completes
* **Atomic Credit Consumption**: Credits deducted in same Postgres transaction as draft row inserts
* **Stage-Based Refunds**: Pro-rata credit refunds on cancellation based on generation progress
* **Stale-Detection Self-Healing**: Automatically re-dispatches stuck workflow runs without manual intervention
* **AI Validation Timeout**: 15-second timeout for initial AI validation; runner re-validates if it times out
* **Status Polling**: Frontend polls `GET /api/books/:bookId/status` for progress updates and enriched result

### **Canon Validation**

* **AI-Powered Lore Judge**: Validates each generated page against established story bible and character profiles
* **Three Outcomes**: Passed (accept), Revised (regenerate with feedback), Rejected (trigger full rewrite)
* **Capped Rewrite Loop**: Maximum retry count prevents infinite generation cycles
* **Reality-Distortion Exceptions**: Unreliable narration and hallucinatory sequences bypass validation
* **Fail-Open Design**: Never blocks story progression — if canon validation fails, the page is accepted anyway

### **Custom Actions & Hint System**

* **AI-Powered Action Validation**: `Gate 0` (presence check) and `Gate 1` (canon/consistency) validate user-submitted custom actions
* **Smart Hint Purchase**: Users can buy hints for actions, revealed progressively (best → worst hint levels)
* **Canonical Action Preservation**: Author-created canonical actions always available alongside custom actions
* **Credit-Gated Custom Actions**: Custom action submission consumes credits, preventing abuse

### **Advanced AI Systems**

* **Multi-Provider AI Support**: 8 providers with tiered ranking and automatic fallback for reliability
* **Adaptive AI Configuration**: Generation parameters dynamically adjust based on story progression and psychological state
* **Context-Aware Storytelling**: Intelligent narrative context management for long-running stories
* **Structured JSON Generation**: Type-safe AI responses with schema validation and auto-repair
* **Prompt Evaluation Pipeline**: Self-review and evaluation stages for higher narrative quality
* **Rate Limiting & Caching**: Optimized AI utilization and performance management
* **Psychological Narrative Modeling**: AI generation guided by hidden emotional and psychological state systems
* **Top-K Sampling**: Stable config (k=40-60, temperature 0.9-1.15) eliminating low-probability nonsense while encouraging creative word choice
* **AI Chat Streaming**: Real-time SSE streaming with provider-level fallback, backpressure handling, and AbortSignal cancellation

### **Guest User System**

* **Cookie-Based Guest Sessions**: `twistloom_guest_id` cookie with 30-day TTL for immediate read-only access
* **Lazy Guest Creation**: Two-tier sessions — temporary in-memory for browsing, persistent DB record created only on first write action
* **Seamless Migration**: Guest reading progress, favorites, and data automatically migrated to authenticated account on login

### **Branch Traversal Algorithm**

* **Intelligent State Reconstruction**: Rebuild any story state from any branch point
* **Hybrid Delta + Checkpoint Architecture**: Combines snapshots (every 5 pages / major events) and incremental changes for efficient reconstruction
* **90% Performance Improvement**: State reconstruction reduced from 50–200ms to 5–20ms
* **Multi-Level Recovery Strategy**: Direct, hybrid, and fallback reconstruction paths
* **Branch-Aware Navigation**: Supports traversal across complex narrative trees and alternative realities
* **High-Performance Caching**: Multi-level LRU cache with TTL, circuit breakers, and retry logic — 85%+ hit rates for active readers

### **Psychological & Narrative Systems**

* **Psychological Profile Endpoint**: Full "autopsy" of the main character's mental state, relationships, and trauma history
* **Locked Paths Timeline**: Visual timeline showing which narrative branches were closed off and why
* **Character Memory**: Persistent emotional and relational history across the entire narrative
* **Ending Sharing**: Readers can share completed endings via unique URLs

### **Social & Community**

* **Social Mentions Ingestion**: Multi-source social proof from Reddit, Hacker News, GitHub, Bluesky, Brave Search
* **Admin Curation Pipeline**: Pending → approved → featured workflow for social mentions
* **User Testimonials**: Full CRUD for reader testimonials on books
* **User Following**: Follow/unfollow system with follower/following lists
* **Daily Check-In**: Credit rewards for daily engagement, with double-check-in option
* **Achievement System**: Trackable reader/writer achievements with acknowledgment flow
* **Activity Logs**: User activity history for display on profile

### **Payments & Monetization**

* **Dual-Currency Economy**: Spendable credits + VIP subscriptions ($9.99/mo)
* **Stripe Checkout Integration**: Pre-created price IDs, three-layer webhook idempotency
* **Atomic Credit Transactions**: `executeWithCredits()` wraps credit deduction + DB writes in single Postgres transaction
* **Subscription Management**: Trial eligibility, cancellation flow, Stripe customer portal
* **Gateway-Agnostic Design**: Stripe + Xendit payment gateway support with unified abstraction
* **30-Day VIP Trial**: New users get free trial period before subscription kicks in
* **Referral Rewards**: Early-attribution referral system with deferred mutual credit payouts after email verification
* **Book Purchases**: Paid books purchasable with credits, purchase-gating for premium content

### **User Authentication & Security**

* **Dual Auth Providers**: Google OAuth + Email/Password via NextAuth v5
* **Dual Session Support**: Guest (cookie) + Authenticated (JWT) with automatic migration
* **Google One-Tap**: Seamless Google sign-in with one-tap prompt
* **Session Management**: List active sessions, logout from specific devices or all devices
* **Account Linking**: Link/unlink Google OAuth to existing credential accounts
* **Email/Password Change**: Authenticated email and password updates
* **Rate Limiting**: IP-based (with Upstash Redis) — 5 auth attempts/min, request throttling
* **CSRF Protection**: Origin header validation against allowed domains
* **Account Lockout**: Progressive lockout on repeated failed login attempts

### **Search & Discovery**

* **Tokenized Search**: Word-boundary-aware ILIKE across title, hook, summary, and keywords
* **Relevance Scoring**: Weighted per-field matching with descending relevance sort
* **Multi-Filter Explore**: Combined filters — tags, language, age range, gender, mode, last updated, collection
* **Sort Options**: Trending, popular, newest, top-picks, originals, reads, favorites, for-you, recommendations, creations
* **Public Book Stats**: Aggregate platform statistics (total books, readers, completions, etc.)
* **Popular Tags**: Tag frequency aggregation for browse filtering

### **Translation & Internationalization**

* **Auto-Translation Cron**: Scheduled Indonesian translation for books via AI
* **Multi-Language Support**: Per-book translations stored in `book_translations` table
* **Locale-Aware Emails**: i18n support (en/id) for all 15 transactional email templates
* **Header-Language Routing**: `Accept-Language` header used for localized content delivery

### **Email System**

* **15 Transactional Templates**: Security (verification, password reset), billing (receipts, subscription), support, and engagement (weekly recommendations, monthly summaries)
* **Resend Integration**: Production email delivery via Resend API
* **HMAC Unsubscribe**: Cryptographically signed one-click unsubscribe links
* **Preference Toggles**: Granular email notification preferences per user
* **Three-Tier Voice Spectrum**: Plain → mild noir → full noir tone options for narrative-themed emails

### **State Management System**

* **Automatic Story Snapshots**: Intelligent checkpoint creation during major narrative events
* **Incremental State Deltas**: Efficient storage of only what changes between pages
* **Branch-Specific Evolution**: Each timeline evolves independently while preserving shared history
* **Smart Cleanup & Optimization**: Automatic maintenance while preserving important checkpoints
* **70% Database Load Reduction**: Optimized retrieval and reconstruction algorithms
* **Type-Safe State Application**: Reliable and deterministic state rebuilding

### **Credit System**

* **Consumable Credits**: Spent on book creation, custom action submission, hint purchases
* **Daily Check-In Rewards**: Free credits for checking in daily, double-check-in option
* **Referral Rewards**: Mutual credit bonuses for verified email pairs
* **Subscription Benefits**: VIP subscription includes monthly credit stipend
* **Purchase History**: Full transaction log with context and metadata
* **Credit Packs**: Buyable credit packs via Stripe checkout

## 🏛️ Architecture Highlights

### **Type Safety**

- Full TypeScript coverage with strict type checking
- Domain-driven design with clear separation of concerns
- Type-safe AI response handling with schema validation and auto-repair
- Comprehensive error management with typed error helpers
- Fully typed `AppEnv` for route handler bindings

### **Performance**

- Serverless optimization for Vercel deployment
- Intelligent caching with Redis (Upstash)
- Database connection pooling via Neon serverless
- Efficient context management for long-running stories
- **Branch Traversal Algorithm** for 90% faster state reconstruction
- **Multi-level LRU caching** with 85%+ hit rates
- **Optimized database queries** reducing load by 70%
- **Denormalized engagement counts** (likesCount, readCount) via DB triggers — O(1) reads, no COUNT(*) subqueries
- **Hybrid trending scores**: Real-time incremental updates + daily batch normalization with time decay

### **Scalability**

- Multi-region database deployment (Neon)
- Auto-scaling with serverless functions
- Rate limiting and request throttling via Upstash Redis
- Graceful error handling and fallbacks across all providers
- Distributed locking for concurrent generation safety
- Strategy-pattern deployment (Vercel / GitHub Actions / cron)

### **Reliability**

- Stale-detection self-healing for async book creation
- Idempotent Stripe webhook handling (3-layer: table → SELECT → unique constraint)
- Multi-level AI provider fallback (model → provider → system)
- Exponential backoff retry logic for generation failures
- Circuit breakers on branch state reconstruction
- Data integrity audit trail for all state changes

## 🤖 AI Orchestration Flow

### **Smart Provider-Model Fallback System**

Twistloom implements a sophisticated AI provider ranking and fallback system that ensures maximum reliability and performance for story generation:

#### **🧠 Orchestration Flow (Writing)**

1. **Provider Ranking**: Based on `AI_CHAT_MODELS_WRITING` configuration
   ```
   mistral → gemini → openrouter → cerebras → groq → nvidia → cloudflare → cohere
   ```

2. **Model Selection**: Each provider has multiple models with fallback hierarchy
   ```
   Example: gemini → [gemini-2.5-pro, gemini-3.5-flash, gemini-3-flash-preview, gemini-2.5-flash]
   ```

3. **Intelligent Fallback Logic**:
   - **API Key Validation**: Checks provider availability before attempting
   - **Rate Limiting**: Applies throttling per provider to prevent overuse
   - **Model-Level Fallback**: Tries each model in sequence within provider
   - **Provider-Level Fallback**: Moves to next provider if all models fail
   - **Error Classification**: Categorizes failures for appropriate retry strategy

#### **🛡️ Reliability Features**

- **Multi-Level Fallback**: Model → Provider → Complete system fallback
- **Error Classification**: Intelligent retry based on error type
- **Rate Limiting**: Prevents API abuse and ensures fair usage
- **Usage Tracking**: Daily usage monitoring per provider
- **Type Safety**: Structured response parsing with validation and auto-repair (JSON repair + token repair)
- **Logging**: Comprehensive success/failure tracking with telemetry
- **Context Awareness**: Different models for different tasks (theme validation vs writing vs evaluation vs summarization)
- **Fast Models**: Separate `AI_CHAT_MODELS_FAST` config for low-latency validation (Groq Llama-3.3, Cerebras Llama-3.1)

This intelligent system ensures **99.9% uptime** for story generation while maintaining **optimal performance** and **cost efficiency** through smart provider selection and fallback strategies.

## 🌳 Branch Traversal Algorithm

### **🚀 Performance Revolution**

The Branch Traversal Algorithm transforms story state reconstruction from a performance bottleneck into a high-speed, scalable solution:

#### **📊 Performance Metrics**
| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| **State Reconstruction** | 50-200ms | 5-20ms | **90% faster** |
| **Database Load** | 10-20 queries | 2-5 queries | **70% reduction** |
| **Cache Hit Rate** | 0% | 85%+ | **New capability** |
| **Memory Usage** | High | Optimized | **50% reduction** |
| **Storage Efficiency** | Full states only | Compressed deltas | **90% smaller** |

#### **🔧 Core Components**

1. **Hybrid Reconstruction System**
   - **Snapshots**: Full state checkpoints every 5 pages or major events
   - **Deltas**: Incremental changes between consecutive states
   - **Intelligent Caching**: Multi-level LRU cache with TTL
   - **Fallback Strategies**: Multiple reconstruction methods for reliability

2. **Smart Decision Engine**
   - **Snapshot Creation Logic**: Prioritizes major events and periodic checkpoints
   - **Delta Compression**: Efficient storage of state differences
   - **Cleanup Algorithms**: Automatic optimization while preserving critical data

3. **Performance Optimization**
   - **Parallel Processing**: Concurrent state reconstruction operations
   - **Memory Management**: Efficient garbage collection and cache eviction
   - **Database Optimization**: Strategic indexes and query patterns

#### **🎯 Algorithm Flow**

```typescript
// State reconstruction process
1. Check cache for existing state
2. Find nearest snapshot (checkpoints)
3. Apply incremental deltas forward
4. Fallback to direct reconstruction if needed
5. Cache result for future requests
```

#### **🛡️ Reliability Features**

- **Multiple Fallback Strategies**: Direct, hybrid, and basic reconstruction
- **Circuit Breakers**: Prevent cascading failures under load
- **Retry Logic**: Exponential backoff for transient failures
- **Data Integrity**: Complete audit trail of all state changes
- **Error Resilience**: Comprehensive error handling and logging
- **Scalability**: Designed for thousands of concurrent users

This algorithm enables **instantaneous story navigation** and **enterprise-scale performance** while maintaining data integrity and system reliability.

## 🌐 API Examples

https://twistloom-backend.vercel.app/api/books/explore?sortBy=trending&limit=10
https://twistloom-backend.vercel.app/api/books/stats
https://twistloom-backend.vercel.app/api/user/users/txufiknr

## 🏛️ API Architecture

### **Authentication API** (`/api/auth`)
- `POST /api/auth/signup` - Register new user accounts
- `POST /api/auth/verify-email` - Verify user email address
- `POST /api/auth/resend-verification` - Resend email verification code
- `POST /api/auth/forgot-password` - Initiate password reset flow
- `POST /api/auth/reset-password` - Complete password reset with token
- `POST /api/auth/verify-credentials` - Verify email/username and password for NextAuth
- `POST /api/auth/logout` - Terminate user session
- `POST /api/auth/logout-all` - Terminate all user sessions
- `POST /api/auth/logout-all-devices` - Terminate sessions on other devices
- `POST /api/auth/logout-session` - Terminate a specific session
- `GET /api/auth/sessions` - List all active sessions
- `DELETE /api/auth/sessions/:id` - Delete a specific session
- `PUT /api/auth/email` - Update email address
- `PUT /api/auth/password` - Update password
- `PUT /api/auth/username` - Update username
- `POST /api/auth/google-one-tap` - Google One-Tap sign-in
- `POST /api/auth/google-oauth` - Google OAuth sign-in
- `POST /api/auth/link/google` - Link Google account
- `POST /api/auth/unlink/google` - Unlink Google account
- `POST /api/auth/link/credentials` - Link credential account

### **Books API** (`/api/books`)

**Book Creation & Generation:**
- `POST /api/books` - Create new psychological thriller books (sync)
- `POST /api/books/stream` - Create book with SSE streaming progress
- `POST /api/books/async` - Create book asynchronously via GitHub Actions
- `GET /api/books/:bookId/status` - Poll async book creation status
- `POST /api/books/:bookId/cancel` - Cancel a pending/in-progress generation
- `POST /api/books/:bookId/retry` - Retry a failed/cancelled generation
- `GET /api/books/generations/active` - List active in-progress generations
- `POST /api/books/workflow-webhook` - Internal GitHub Actions webhook

**Book Retrieval & Management:**
- `GET /api/books` - Retrieve user's book library
- `GET /api/books/explore` - Explore published books with search, filters, pagination
- `GET /api/books/:identifier` - Get specific book by slug or ID
- `PUT /api/books/:id` - Update book metadata (title, hook, summary, keywords, ending, etc.)
- `PUT /api/books/:id/cover-image` - Upload/replace book cover image
- `PUT /api/books/:id/character-image` - Upload/replace main character avatar
- `PATCH /api/books/:id/visibility` - Update book visibility level
- `PATCH /api/books/:id/archive` - Archive or unarchive a book
- `DELETE /api/books/:id` - Delete a book and queue image deletion
- `GET /api/books/:id/similar` - Get similar books by keyword similarity
- `GET /api/books/tags/popular` - Get popular tags for filtering
- `GET /api/books/stats` - Get public book statistics
- `POST /api/books/:identifier/purchase` - Purchase a paid book with credits

**Reading & Navigation:**
- `GET /api/books/:identifier/:pageId` - Get specific page with translation support
- `POST /api/books/:identifier/:pageId/confirm-visit` - Confirm page visit and record progress
- `POST /api/books/:identifier/:pageId/touch` - Lightweight heartbeat updating session `updatedAt`
- `GET /api/books/:identifier/branches` - List all branches for a book
- `GET /api/books/:identifier/:pageId/candidates` - Pre-generate candidate pages via SSE
- `GET /api/books/:identifier/:pageId/candidates/status` - Poll candidate generation status
- `POST /api/books/:identifier/:pageId/actions/hint` - Purchase an action hint

**Custom Actions:**
- `POST /api/books/:identifier/:pageId/custom-actions/preview` - Preview custom action (no charge)
- `POST /api/books/:identifier/:pageId/custom-actions/submit` - Submit custom action (credit cost)

**Psychological Features:**
- `GET /api/books/:identifier/psychological-profile` - Get psychological "autopsy" of the MC
- `GET /api/books/:identifier/locked-paths` - Get timeline of locked/closed paths

**Social Interactions:**
- `POST /api/books/:id/like` - Like a book
- `DELETE /api/books/:id/like` - Unlike a book
- `POST /api/books/:id/favorite` - Add book to favorites
- `DELETE /api/books/:id/favorite` - Remove book from favorites
- `PATCH /api/books/favorites/rename-collection` - Rename a collection across all favorites
- `POST /api/books/:identifier/:pageId/share` - Share a completed ending
- `GET /api/books/share/:username/:bookSlug/:pageId` - Public ending view

**Comments:**
- `GET /api/books/:id/comments` - Get book comments with pagination
- `POST /api/books/:id/comments` - Create comment on book
- `GET /api/books/:id/pages/:pageId/comments` - Get comments for a page
- `POST /api/books/:id/pages/:pageId/comments` - Create comment on a page
- `GET /api/books/:id/pages/:pageId/paragraphs/:paragraphNumber/comments` - Get paragraph comments
- `POST /api/books/:id/pages/:pageId/paragraphs/:paragraphNumber/comments` - Create paragraph comment
- `PUT /api/books/comments/:id` - Update comment
- `DELETE /api/books/comments/:id` - Delete comment
- `GET /api/books/comments` - Get authenticated user's comments

**Testimonials:**
- `GET /api/books/testimonials` - Get own book testimonials
- `GET /api/books/:identifier/testimonials` - List book testimonials
- `POST /api/books/:identifier/testimonials` - Create a testimonial
- `GET /api/books/:identifier/testimonials/:id` - Get single testimonial
- `PATCH /api/books/:identifier/testimonials/:id` - Update testimonial
- `DELETE /api/books/:identifier/testimonials/:id` - Delete testimonial

**Utilities:**
- `GET /api/books/prompt` - Generate book creation prompt via SSE

### **Users API** (`/api/user` and `/api/users`)
- `GET /api/user` - Get authenticated user profile
- `POST /api/user` - Create/onboard user profile (first login)
- `PUT /api/user` - Update user profile
- `DELETE /api/user` - Delete user profile
- `GET /api/users/:identifier` - Get public user profile by ID or username
- `POST /api/user/likes` - Like targets (books, comments)
- `DELETE /api/user/likes` - Unlike targets
- `GET /api/user/likes` - Get user's likes
- `POST /api/user/favorites` - Add books to favorites
- `DELETE /api/user/favorites` - Remove books from favorites
- `GET /api/user/favorites` - Get user's favorites
- `GET /api/user/collections` - Get user's book collections
- `POST /api/users/:id/follow` - Follow a user
- `DELETE /api/users/:id/follow` - Unfollow a user
- `GET /api/users/:id/followers` - Get user's followers
- `GET /api/users/:id/following` - Get user's following
- `GET /api/user/followers` - Get authenticated user's followers
- `GET /api/user/following` - Get authenticated user's following
- `GET /api/user/checkin/status` - Get daily check-in status
- `POST /api/user/checkin` - Perform daily check-in for credits
- `POST /api/user/checkin/double` - Double check-in bonus
- `GET /api/user/activity-logs` - Get user's activity history
- `GET /api/user/progress` - Get user's reading progress across books
- `GET /api/user/achievements` - Get user's achievements
- `GET /api/user/achievements/unnotified` - Get unnotified achievements
- `POST /api/user/achievements/acknowledge` - Mark achievements as acknowledged
- `GET /api/user/export` - Export user data

### **Payments API** (`/api/payments`)
- `GET /api/payments/credit-packs` - Get available credit packs
- `GET /api/payments/subscription-plans` - Get subscription plans
- `POST /api/payments/create-checkout-session` - Create Stripe checkout session for credits
- `POST /api/payments/create-subscription-checkout` - Create Stripe subscription checkout
- `POST /api/payments/create-trial-checkout-session` - Create trial checkout session
- `GET /api/payments/subscription` - Get subscription status
- `POST /api/payments/subscription/cancel` - Cancel subscription
- `GET /api/payments/subscription/portal` - Get Stripe customer portal URL
- `GET /api/payments/subscription/trial-eligibility` - Check trial eligibility
- `POST /api/payments/stripe/webhook` - Handle Stripe webhook events
- `POST /api/payments/xendit/webhook` - Handle Xendit webhook events
- `POST /api/payments/xendit/subscription-webhook` - Handle Xendit subscription webhooks
- `GET /api/payments/transactions` - Get transaction history

### **Admin API** (`/api/admin`)
- Admin routes for system management and monitoring

### **Blog API** (`/api/blog`)
- Blog posts and content management

### **Email API** (`/api/email`)
- Email preference management and opt-out handling

### **Social Mentions API** (`/api/social-mentions`)
- Social proof ingestion and admin curation pipeline

## 🛠️ Development Scripts

### **Development**
```bash
bun dev                         # Start development server with hot reload
bun dev:api                      # Start API server only
bun dev:cron:trending            # Run trending scores cron job locally
bun dev:cron:generate            # Run originals generation cron job locally
bun dev:cron:candidate           # Run candidate generation cron job locally
bun dev:cron:translate           # Run auto-translation cron job locally
bun dev:cron:vip-expiration      # Run VIP expiration cron job locally
bun dev:cron:forum-ban           # Run forum ban reconciliation locally
bun dev:cron:cleanup             # Run database cleanup cron job locally
bun dev:cron:email-weekly        # Run weekly recommendations email
bun dev:cron:email-monthly       # Run monthly summary email
```

### **Production**
```bash
bun run build                    # Build TypeScript to JavaScript
bun start                        # Start production server
bun start:cron:trending          # Run trending scores cron job in production
bun start:cron:generate          # Run originals generation cron job in production
bun start:cron:candidate         # Run candidate generation cron job in production
bun start:cron:translate         # Run auto-translation cron job in production
bun start:cron:vip-expiration    # Run VIP expiration cron job in production
bun start:cron:forum-ban         # Run forum ban reconciliation in production
bun start:cron:cleanup           # Run database cleanup in production
bun start:cron:email-weekly      # Run weekly recommendations email in production
bun start:cron:email-monthly     # Run monthly summary email in production
```

### **Database Management**
```bash
bun db:generate                  # Generate database migrations
bun db:migrate                   # Apply database migrations
bun db:migrate:prod              # Apply database migrations in production
bun db:studio                    # Open Drizzle Studio GUI
bun db:test                      # Test database connection
bun db:extensions                # Install database extensions
bun db:extensions:prod           # Install database extensions in production
bun db:triggers                  # Create database triggers
bun db:triggers:prod             # Create database triggers in production
bun db:clear                     # Clear all database data
bun db:clear:prod                # Clear all database data in production
bun db:reset                     # Reset database (clear + migrate + seed)
bun db:reset:prod                # Reset database in production
```

### **Quality Assurance**
```bash
bun check                        # Run lint, import validation, and typecheck
bun lint                         # Run ESLint on all files
bun lint:fix                     # Auto-fix ESLint issues
bun lint:fast                    # Run ESLint without promise checks
bun lint:imports                 # Validate import extensions
bun typecheck                    # Run TypeScript type checking
```

## 🧠 AI Prompt System

Twistloom uses a sophisticated prompt orchestration system located in `src/utils/prompt.ts`, designed specifically for branching psychological thriller narratives and multiverse storytelling.

### **Core Capabilities**

* **Story Initialization**: Complete AI-generated books, metadata, themes, and narrative foundations
* **Dynamic Page Generation**: Context-aware continuation based on reader decisions
* **Alternative Fate Generation**: Multiple plausible futures generated from the same decision point
* **Character Intelligence**: Personality-aware dialogue, motivations, secrets, and behavioral evolution
* **Location Management**: Persistent environmental storytelling and world consistency
* **Psychological Modeling**: Hidden emotional state tracking influencing future narrative outcomes

### **Multiverse Narrative Generation**

Unlike traditional branching fiction where each choice maps to a single consequence:

```
Open the door
    └── Fixed Outcome
```

Twistloom generates multiple possible futures:

```
Open the door
    ├── The room is empty
    ├── A missing friend is waiting
    ├── Something is already inside
    └── The room should not exist
```

This allows:

* Different readers to experience different stories despite making identical choices
* Increased replayability and narrative discovery
* Emergent storytelling beyond predefined branching trees
* Unique psychological twists and alternative realities
* Large-scale narrative diversity without hand-authoring every path

### **Prompt Features**

* **Multi-Provider Fallback**: Automatic provider switching and failover
* **Context Summarization**: Intelligent long-story memory management
* **Structured JSON Output**: Strict schema validation and recovery
* **Branch-Aware Context**: Narrative awareness of current timeline and divergence points
* **Character Memory**: Persistent emotional and relational history
* **State-Aware Generation**: Prompts adapt to reconstructed story state
* **Psychological Continuity**: Hidden emotional systems influence future content generation

### **Advanced Prompt Engineering**

* **Structured Narrative Constraints**: Enforce story consistency while preserving creativity
* **Psychological Depth Modeling**: Multi-layered emotional and behavioral generation
* **Dynamic Tension Management**: Escalation and release patterns optimized for thriller storytelling
* **Reader Expectation Manipulation**: Designed to create uncertainty, surprise, and suspense
* **Alternative Fate Diversity Controls**: Ensures generated futures meaningfully diverge rather than repeating variations of the same outcome
* **Branch Consistency Verification**: Maintains continuity within each timeline while allowing multiverse divergence

## 🔧 Configuration

### **AI Configuration**
- Multi-provider model selection (Mistral, Gemini, OpenRouter, Cerebras, Groq, NVIDIA, Cloudflare, Cohere)
- Configurable temperature, top-k, and output limits
- Rate limiting and caching strategies
- Fallback and error handling
- Specialized configs for writing, fast validation, summarization, and embedding

## 🚀 Getting Started

### **Prerequisites**
- Bun 1.3+
- Neon database account
- AI provider API keys

### **Installation**
```bash
# Clone repository
git clone <repository-url>
cd twistloom-backend

# Install dependencies
bun install

# Configure environment
cp .env.example .env.local
# Edit .env.local with your API keys
```

### **Development Setup**
```bash
# Start development server (Bun native, hot reload)
bun dev

# Run database migrations
bun db:migrate

# Open database studio
bun db:studio
```

### **Environment Variables**
```env
# Database
DATABASE_URL=postgresql://...

# AI Providers
CEREBRAS_API_KEY=...
GOOGLE_AI_API_KEY=...
MISTRAL_API_KEY=...
COHERE_API_KEY=...
GROQ_API_KEY=...
OPENAI_API_KEY=...
NVIDIA_API_KEY=...
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...

# OpenRouter — Unified API gateway for various LLMs
OPENROUTER_API_KEY=...
```

## 📚 Documentation

### **Code Organization**
```
api/
├── index.ts                        # Vercel serverless entrypoint (IncomingMessage → Request adapter)

src/
├── app.ts                          # Hono app configuration
├── server.bun.ts                   # Server entry point (Bun runtime)
│
├── config/                         # Configuration files and AI client setup
│   ├── achievements.ts             # Achievement definitions
│   ├── ai-chat.ts                  # AI chat configuration
│   ├── ai-clients.ts               # AI provider model selection
│   ├── ai-images.ts                # AI image generation config
│   ├── auth.ts                     # Authentication configuration
│   ├── book-creation.ts            # Book creation limits and timeouts
│   ├── branch-traversal.ts         # Branch traversal algorithm config
│   ├── cache.ts                    # Cache configuration
│   ├── candidate-generation.ts     # Candidate generation config
│   ├── canon-validation.ts         # Canon validation config
│   ├── characters.ts               # Character system config
│   ├── constants.ts                # Application constants
│   ├── credits.ts                  # Credits system config
│   ├── custom-actions.ts           # Custom action validation config
│   ├── emails/                     # Email templates
│   ├── embedding.ts                # Embedding configuration
│   ├── enums.ts                    # Shared enum definitions
│   ├── env.ts                      # Environment variables
│   ├── errors.ts                   # Error configuration
│   ├── generation-refund.ts        # Pro-rata refund calculation
│   ├── image.ts                    # Image configuration
│   ├── legal.ts                    # Legal compliance config
│   ├── pagination.ts               # Pagination config
│   ├── prompt-cache.ts             # Prompt caching config
│   ├── purge.ts                    # Cache purge config
│   ├── redis.ts                    # Redis configuration
│   ├── story.ts                    # Story settings
│   ├── subscription.ts             # Subscription config
│   ├── theme-validation.ts         # Theme validation config
│   ├── translation.ts              # Translation config
│   ├── user.ts                     # User configuration
│   └── xendit.ts                   # Xendit payment config
│
├── cron/                           # Scheduled job handlers
│   ├── auto-translate-indonesian.ts
│   ├── cleanup.ts
│   ├── email-monthly-summary.ts
│   ├── email-weekly-recommendations.ts
│   ├── forum-ban-reconciliation.ts
│   ├── generate-originals.ts
│   ├── on-demand-book-creation.ts
│   ├── retry-pending-generations.ts
│   ├── update-trending-scores.ts
│   └── vip-expiration.ts
│
├── db/                             # Database schema and migrations
│   ├── client.ts                   # Database client
│   ├── extensions.ts               # Database extensions
│   ├── reset.ts                    # Database reset utilities
│   ├── schema.ts                   # Database schema (all tables)
│   └── triggers.ts                 # Database triggers
│
├── hono/                           # Hono framework setup
│   ├── env.ts                      # AppEnv type definitions
│   └── express-shim.ts             # Express-to-Hono conversion utilities
│
├── middleware/                      # Hono middleware
│   ├── admin-auth.ts               # Admin authentication
│   ├── body.ts                     # Body parsing
│   ├── cache.ts                    # Response caching
│   ├── locale.ts                   # Locale extraction
│   ├── nextauth.ts                 # NextAuth v5 session verification
│   ├── rate-limit.ts               # Rate limiting (Upstash Redis)
│   └── upload.ts                   # Multipart image upload
│
├── routes/                         # API endpoint handlers
│   ├── admin.ts                    # Admin routes
│   ├── auth.ts                     # Authentication routes
│   ├── blog.ts                     # Blog routes
│   ├── books.ts                    # Books API routes
│   ├── email.ts                    # Email preference routes
│   ├── index.ts                    # Route index
│   ├── payments.ts                 # Payments API routes
│   ├── social-mentions.ts          # Social mentions routes
│   └── user.ts                     # User API routes
│
├── schema/                         # Schema definitions
│   ├── book.ts                     # Book schema
│   └── story.ts                    # Story schema
│
├── services/                       # Business logic and data access
│   ├── achievements.ts             # Achievement system
│   ├── book-controller.ts          # Book query builders and controllers
│   ├── book-creation.ts            # Book creation pipeline
│   ├── book.ts                     # Book service (CRUD, enriched queries)
│   ├── cache.ts                    # Cache service (Redis + in-memory)
│   ├── canon-validation.ts         # Canon validation AI pipeline
│   ├── credits.ts                  # Credits system
│   ├── custom-actions.ts           # Custom action validation (Gate 0/1)
│   ├── email-preferences.ts        # Email preference management
│   ├── forum-queue.ts              # Forum notification queue
│   ├── image.ts                    # Image upload and management
│   ├── locked-paths.ts             # Locked paths timeline
│   ├── performance-monitoring.ts   # System performance tracking
│   ├── prompt-cache.ts             # Prompt caching service
│   ├── psychological-profile.ts    # MC psychological profiling
│   ├── session-manager.ts          # Session management
│   ├── social/                     # Social mentions ingestion
│   ├── story-branch.ts             # Branch-aware story functions
│   ├── story-state-cache.ts        # Story state caching (LRU)
│   ├── story.ts                    # Story service (visit, stats, session)
│   ├── subscription.ts             # Subscription management
│   ├── translation.ts              # Translation service
│   ├── user-controller.ts          # User query builders
│   ├── user.ts                     # User service
│   ├── vector-memory.ts            # Vector memory (pgvector)
│   └── xendit.ts                   # Xendit payment service
│
├── types/                          # TypeScript type definitions
│   ├── achievements.ts
│   ├── ai-chat.ts
│   ├── ai-images.ts
│   ├── api.ts
│   ├── book-creation.ts
│   ├── book.ts
│   ├── candidate-generation.ts
│   ├── canon-validation.ts
│   ├── character.ts
│   ├── credits.ts
│   ├── custom-action.ts
│   ├── email-locale.ts
│   ├── email-preferences.ts
│   ├── express.d.ts
│   ├── github-workflow.ts
│   ├── hono.ts
│   ├── image.ts
│   ├── payment.ts
│   ├── places.ts
│   ├── prompt.ts
│   ├── redis.ts
│   ├── schema.ts
│   ├── session.ts
│   ├── sse.ts
│   ├── story-thread.ts
│   ├── story.ts
│   ├── subscription.ts
│   ├── theme-validation.ts
│   └── user.ts
│
└── utils/                          # Utility functions and AI helpers
    ├── account-lockout.ts          # Progressive account lockout
    ├── ai-chat-stream.ts           # AI SSE streaming
    ├── ai-chat.ts                  # AI chat abstraction
    ├── ai-clients.ts               # AI client utilities
    ├── ai-image.ts                 # AI image generation
    ├── ai-limiters.ts              # AI rate limiting
    ├── ai-logger.ts                # AI usage logging
    ├── ai-parser.ts                # AI response JSON parsing
    ├── ai-sampling.ts              # Top-k/temperature sampling config
    ├── ai-token-repair.ts          # Token repair utilities
    ├── book-mode.ts                # Book mode utilities
    ├── books.ts                    # Book validation helpers
    ├── branch-traversal.ts         # Core Branch Traversal Algorithm
    ├── cache.ts                    # Cache utilities
    ├── candidate-generation.ts     # Candidate generation utilities
    ├── characters.ts               # Character generation utilities
    ├── debounce.ts                 # Debounce utilities
    ├── distributed-lock.ts         # Distributed locking (Postgres advisory)
    ├── edge-group.ts               # GitHub Actions group formatting
    ├── email-verification.ts       # Email verification tokens
    ├── email.ts                    # Email sending utilities
    ├── embedding.ts                # Embedding generation
    ├── env.ts                      # Environment utilities
    ├── error.ts                    # Error handling helpers
    ├── formatter.ts                # Text formatting
    ├── gemini.ts                   # Gemini-specific utilities
    ├── github-workflow.ts          # GitHub workflow dispatch
    ├── graceful-shutdown.ts        # Graceful shutdown
    ├── logger.ts                   # Structured logging
    ├── narrative-style.ts          # Narrative style utilities
    ├── page-validation.ts          # Page validation utilities
    ├── pagination.ts               # Pagination utilities (cursor, offset)
    ├── parser.ts                   # AI response parsing
    ├── password-reset.ts           # Password reset tokens
    ├── password-validation.ts      # Password strength validation
    ├── password.ts                 # Password hashing (bcryptjs)
    ├── places.ts                   # Place utilities
    ├── player-profile.ts           # Player profile utilities
    ├── progress-tracking.ts        # Action progress tracking
    ├── prompt-security.ts          # Prompt injection prevention
    ├── prompt-stream.ts            # Cached prompt streaming
    ├── prompt-telemetry.ts         # Prompt usage telemetry
    ├── prompt-translation.ts       # Prompt translation utilities
    ├── prompt.ts                   # AI prompt engineering
    ├── quote.ts                    # Quote utilities
    ├── redis.ts                    # Redis client utilities
    ├── reliability.ts              # Retry/reliability utilities
    ├── retry.ts                    # Retry logic
    ├── sanitize-html.ts            # HTML sanitization
    ├── search.ts                   # Search utilities
    ├── sse.ts                      # Server-Sent Events utilities
    ├── story.ts                    # Story utilities
    ├── stripe.ts                   # Stripe utilities
    ├── text-processing.ts          # Text processing
    ├── text-similarity.ts          # Text similarity
    ├── theme-validation.ts         # Theme validation
    ├── time.ts                     # Time utilities
    ├── translation.ts              # Translation utilities
    ├── username.ts                 # Username generation
    ├── uuid.ts                     # UUID generation (v7)
    └── xendit.ts                   # Xendit utilities
```

### **Key Modules**
- **Story Engine**: Core branching narrative logic
- **AI Integration**: Multi-provider AI communication with fallback orchestration
- **Character System**: Dynamic character management and psychological profiling
- **Database Layer**: Type-safe data persistence with Drizzle ORM
- **API Layer**: RESTful endpoint implementation on Hono.js
- **Branch Traversal Algorithm**: Hybrid delta+checkpoint state reconstruction
- **Story State Cache**: Multi-level LRU cache with 85%+ hit rates
- **Story Branch Service**: Branch-aware story functions
- **Candidate Generation**: Synchronous and async candidate generation
- **GitHub Workflow Dispatch**: Background processing via GitHub Actions
- **Distributed Locking**: Prevents concurrent generation on same branching point
- **Custom Actions**: AI-powered canon validation (Gate 0/1) for user-submitted actions
- **Canon Validation**: Lore-consistency checking for generated pages
- **Strategy Pattern**: Deployment-aware generation (Vercel / GitHub Actions / cron)
- **Performance Monitoring**: System performance tracking and metrics
- **Translation Service**: Multi-language support and auto-translation cron
- **Credits System**: Atomic credit consumption and management
- **Subscription Service**: VIP subscription management with Stripe + Xendit
- **Image Service**: Image upload and management via ImageKit
- **Authentication**: NextAuth v5 with Google OAuth + Email/Password
- **Rate Limiting**: Request throttling via Upstash Redis
- **Email System**: 15 transactional templates via Resend with i18n
- **Referral System**: Early-attribution referrals with deferred mutual payouts
- **Achievement System**: Trackable reader/writer achievements
- **Vector Memory**: pgvector-based semantic memory for narrative context
- **Lazy Guest System**: Two-tier session management (in-memory → persistent)
- **Session Manager**: Multi-device session tracking and termination

---

**Built with 💀 for interactive psychological thriller storytelling**
