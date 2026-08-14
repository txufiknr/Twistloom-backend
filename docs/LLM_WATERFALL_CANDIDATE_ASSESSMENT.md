# Twistloom LLM Waterfall — Candidate Provider Assessment

**Date:** August 4, 2026
**Scope:** Fact-check and fit assessment of 13 candidate free-tier LLM providers against Twistloom's existing nine-provider waterfall.
**Method:** Each provider's own docs/pricing pages were checked directly where reachable, cross-referenced against independent trackers for rate-limit figures (these move without notice, so treat every number below as "verify in-console before wiring it in," not as a hard contract).

> **A note on "your current 9" before you read this:** I don't have the literal enumerated list of your nine live providers in front of me — only the pattern from your recent build history: Groq, Cohere, OpenRouter, Cloudflare Workers AI, and Google Gemini all appear to already be in the stack, GitHub Models was flagged for its July 30, 2026 retirement, and Cohere/Jina were flagged for non-commercial license terms. Where a candidate below functionally duplicates one of those (an aggregator duplicating OpenRouter, a speed-optimized host duplicating Groq), I've flagged it — but you should do a final pass against your actual live config, since I may be missing 3-4 providers I have no visibility into.

---

## At a Glance

| # | Provider | Verdict | One-line reason |
|---|----------|---------|------------------|
| 1 | **OVHcloud AI Endpoints** | ✅ **Recommended** | Established EU cloud (GDPR/sovereignty), genuinely free anonymous + keyed tiers, OpenAI-compatible, no commercial-use red flags found |
| 2 | **SambaNova Cloud** | ✅ **Recommended** | Well-funded (~$1.1B raised), persistent no-card free tier, OpenAI-compatible, no commercial restriction found |
| 3 | **Ollama Cloud** | ⚠️ Conditional | Legitimate product, no commercial restriction found, but quota is GPU-time/session-based (not token/RPM), no SLA, one documented reliability incident |
| 4 | **ModelScope** | ⚠️ Conditional | Generous quota (2,000 RPD) and strong Qwen/DeepSeek access, but likely needs an Alibaba account/Chinese phone, commercial terms undocumented |
| 5 | **Z.ai (Zhipu AI)** | ⚠️ Conditional — **use z.ai, not bigmodel.cn** | Real, capable GLM models, but the `.cn` endpoint you listed needs China phone verification, and the parent company sits on the US Entity List |
| 6 | **SiliconFlow** | ⚠️ Conditional — **use `.com`, not `.cn`** | The `.cn` base URL you listed is the domestic platform (Chinese phone likely required); the international `.com` platform is more usable but has a thin, undocumented free tier |
| 7 | **Aion Labs** | ⚠️ Conditional, niche | Models are literally fine-tuned for dark/mature narrative fiction — a strong thematic fit — but it's a small operator, ToS is thin, and the free quota (20K tokens/day) is very small |
| 8 | **Chutes.ai** | ⚠️ Conditional, use with care | Real free/cheap models via a Bittensor-decentralized network, but your prompts may transit anonymous third-party "miner" nodes outside of TEE-flagged models |
| 9 | **LLM7.io** | ⚠️ Low priority | Functional and free, but it's an unofficial mirror that isn't affiliated with the model owners it proxies (including branded ones) — no SLA, small solo-ish operator |
| 10 | **Kilo Gateway** | ❌ Not recommended | Functionally an OpenRouter clone built for a coding-agent product; free-tier prompts can be logged with no clear opt-out; likely redundant with OpenRouter |
| 11 | **OpenCode Zen** | ❌ Not recommended | Requires billing details/card on file; the handful of literally-free models are explicitly labeled trial-only with "do not submit personal or confidential data" warnings |
| 12 | **Agnes AI** | ❌ Not recommended | New Singapore startup reselling other labs' models under its own brand names; even independent reviewers call its usage limits/ToS unclear; heavy consumer-marketing footprint, no operating track record |
| 13 | **Glhf.chat** | ❌ **Does not fit — fact-check failure** | It was free during a 2024 beta (matching the HN/Reddit links you cited), but it moved to **paid, usage-based billing in January 2025** and has stayed paid since |

---

## Detailed Assessments

### 1. Ollama Cloud
**Base URL:** `https://api.ollama.com` · **OpenAI-compatible:** Yes

- **What it is:** The hosted-inference arm of Ollama (the popular local-model runner). Free/Pro ($20/mo)/Max ($100/mo) tiers, billed by GPU-time utilization rather than tokens.
- **Free tier:** $0, no card required. Quota is not published as RPM/RPD — it resets on a 5-hour session cycle and a 7-day weekly cycle, and is denominated in GPU-time against "usage levels" (models are bucketed level 1–4 by weight; the free tier is realistically usable only on level 1–2 models). This is architecturally different from every RPM/TPD-style provider already in your waterfall, which makes it awkward to slot into a uniform rate-limiter.
- **Commercial use:** No explicit prohibition found in pricing/ToS pages searched. Ollama states prompt/response data is never logged or used for training, and it requires zero-data-retention commitments from its own hosting partners.
- **Reliability:** No SLA is published (service is "as is"). One independent tracker cited a documented ~95% failure-rate window on Ollama Cloud in April 2026 — worth treating as a real fallback-only tier, not a primary rung.
- **Verdict:** Legitimate and free, but the GPU-time quota model and lack of SLA make it a better fit as a deep-fallback tier than a primary rung. Worth adding low in the waterfall, not high.
- **Sources:** [ollama.com/pricing](https://ollama.com/pricing), [devtoolhub.com Ollama Cloud guide](https://devtoolhub.com/ollama-cloud-free-vs-pro-limits-pricing-2026/), [checkthat.ai Ollama pricing analysis](https://checkthat.ai/brands/ollama/pricing)

---

### 2. Z.ai (Zhipu AI)
**Base URL you listed:** `https://open.bigmodel.cn/api/paas/v4` · **OpenAI-compatible:** Yes

- **What it is:** GLM model family (GLM-4.x/5.x) from Zhipu AI, a Tsinghua-incubated Beijing lab. Served two ways: the domestic **BigModel** platform (`open.bigmodel.cn`, the URL you listed) and the international **Z.ai** platform (`z.ai/model-api`).
- **Important correction:** The URL you provided is the **China-domestic** platform. Third-party setup guides report that signing up there requires phone verification tied to a China number, which is a real practical barrier for a non-China-based solo developer. If you want this provider, register through `z.ai/model-api` instead — same GLM models, international sign-up path.
- **Free tier:** GLM-4.7-Flash is advertised free with a 200K context window; third-party trackers report figures ranging from "1 concurrent request" to "~1,000 requests/day," which is inconsistent enough that you should pull the live number from your own console rather than trust any aggregator here.
- **Commercial use:** Zhipu explicitly advertises free commercial-use authorization for some of its open models (ChatGLM3-6B, GLM-4-9B) on its own pricing page — a genuinely positive signal, better than the non-commercial restrictions you already flagged for Cohere/Jina.
- **Compliance flag worth knowing about:** In January 2025, the US Commerce Department added Beijing Zhipu Huazhang Technology (Zhipu's parent) to the Entity List over concerns it was aiding China's military AI modernization; Zhipu disputed the characterization and said it wouldn't materially affect its business since it doesn't depend on US model technology. This restricts *Zhipu's* access to US-origin technology — it does not, by itself, bar a company like Twistloom from calling their public API — but it's a fact worth having on record given this is a commercial product, particularly if you ever route payments, hosting, or app-store listings through US-regulated entities.
- **Verdict:** Real, capable models with a genuinely commercial-friendly license posture. Worth adding — but swap the base URL to the international Z.ai endpoint rather than the China-domestic one you listed, to avoid the phone-verification wall.
- **Sources:** [bigmodel.cn/pricing](https://bigmodel.cn/pricing), [docs.cline.bot Z.ai setup](https://docs.cline.bot/provider-config/zai), [theairankings.com Zhipu profile](https://theairankings.com/zhipu/) (Entity List detail, sourced there from Reuters/SCMP reporting)

---

### 3. SiliconFlow
**Base URL you listed:** `https://api.siliconflow.cn/v1` · **OpenAI-compatible:** Yes

- **What it is:** A Chinese AI-inference cloud aggregating DeepSeek, Qwen, GLM, and other open models, plus image/audio/video models.
- **Important correction:** Like Z.ai, the `.cn` domain you listed is the **domestic** platform — independent setup guides report it currently requires a Chinese phone number to register, which international users may not be able to satisfy. The international platform lives at `siliconflow.com` (not `.cn`) and uses a different signup flow (a small ~$1 starter credit instead of the domestic platform's historical ¥14 credit).
- **Free tier:** A handful of smaller models (e.g., Qwen3-8B-class) are permanently priced at $0. Free-model request limits are credit-gated: reports converge on roughly 50 requests/day with no top-up, rising to ~1,000 requests/day once you've purchased at least ~$10-worth of credit (even if you never spend it) — an unusual "pay to unlock the free tier" structure worth designing around explicitly, not assuming as unconditionally free.
- **Commercial use:** Not explicitly restricted in what's published, but also not clearly confirmed either — SiliconFlow's own reserved right to adjust limits "based on traffic and load" without a published SLA is the main caveat.
- **Verdict:** Skip the `.cn` URL as specified; if you want this provider, evaluate the `.com` platform instead, and budget for the credit-gated free-quota structure. Lower priority than OVHcloud/SambaNova given the registration friction and undocumented terms.
- **Sources:** [docs.siliconflow.com rate limits](https://docs.siliconflow.com/en/userguide/rate-limits/rate-limit-and-upgradation), [siliconflow.com/pricing](https://www.siliconflow.com/pricing)

---

### 4. ModelScope
**Base URL:** `https://api-inference.modelscope.cn/v1` · **OpenAI-compatible:** Yes

- **What it is:** Alibaba's open-model hub and inference platform — the closest thing China has to a Hugging Face-plus-hosted-inference combo, with first access to new Qwen releases.
- **Free tier:** 2,000 requests/day total, capped at 500 requests/day per individual model. No credit card required. This is a genuinely generous quota compared to most of the other candidates here.
- **Registration:** Multiple independent sources agree registration goes through an Alibaba Cloud account and may require a Chinese phone number, though this is reported with less certainty than the SiliconFlow/Z.ai domestic-platform requirement — worth testing directly since some reports suggest email-based Alibaba account creation is also possible.
- **Commercial use:** Not clearly documented by ModelScope itself in what's publicly indexed; multiple third-party trackers independently flag this as "unclear, verify before shipping" rather than either confirming or denying it.
- **Verdict:** The quota is attractive and the model catalog (Qwen3.5, DeepSeek) is strong, but you're stacking two unresolved unknowns — registration friction and commercial terms — that are worth resolving directly with ModelScope (or accepting the risk consciously) before wiring it into a commercial product's waterfall.
- **Sources:** [modelscope.ai/docs/model-service/API-Inference/limits](https://modelscope.ai/docs/model-service/API-Inference/limits), [docs.cherryai.com.cn ModelScope setup](https://docs.cherryai.com.cn/docs/en-us/pre-basic/providers/modelscope)

---

### 5. OVHcloud AI Endpoints
**Base URL:** `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1` · **OpenAI-compatible:** Yes

- **What it is:** Serverless inference over ~15-20 open-weight models (Llama, Mistral, Qwen, DeepSeek, Mixtral) from OVHcloud — a large, real, publicly-known European cloud provider (450,000+ servers, 1.6M+ customers across 140 countries), positioned explicitly around GDPR compliance and EU data sovereignty.
- **Free tier — two levels:**
  - **Anonymous, no signup at all:** 2 requests/minute per IP per model. You can pass an empty string as the API key and start calling immediately.
  - **Authenticated (free API key from an OVHcloud account):** 400 requests/minute per Public Cloud project per model — a genuinely high ceiling. As of the current docs, OVHcloud does not impose any additional token/usage cap beyond the rate and payload-size limits, though they note a usage-limit feature may be added later.
- **Small correction to your notes:** the URL you listed for "API key" (`ovhcloud.com/.../ai-endpoints/catalog/`) is the model catalog page, not where you generate a key — keys are issued from the OVHcloud Manager under Public Cloud → AI & Machine Learning → AI Endpoints → API keys, which requires an OVHcloud account (and, in practice, a Public Cloud project — verify whether that requires payment details on file even if AI Endpoints usage itself stays free).
- **Commercial use:** No restriction found; OVHcloud's business model is enterprise cloud infrastructure, not a hobbyist free-tier giveaway, so there's no ambiguity about whether commercial API traffic is welcome.
- **Verdict:** This is one of the stronger candidates in the list — an established, accountable company, genuinely free at real throughput, OpenAI-compatible, and EU-hosted (a plus if data-residency ever becomes a requirement for you). Recommended.
- **Sources:** [docs.ovhcloud.com AI Endpoints capabilities](https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-capabilities), [ovhcloud.com AI Endpoints](https://www.ovhcloud.com/en/public-cloud/ai-endpoints/)

---

### 6. Kilo Gateway
**Base URL:** `https://api.kilo.ai/api/gateway` · **OpenAI-compatible:** Yes

- **What it is:** A unified routing gateway (500+ models across Anthropic, OpenAI, Google, Mistral, and more) built primarily to power the **Kilo Code** coding-agent product — same category as OpenRouter, not a first-party model host.
- **Free tier:** `kilo-auto/free` — a Kilo-managed router that picks from currently-available free upstream models — capped at 200 requests/hour per IP, no card required.
- **Data-handling flag:** Kilo's own documentation (surfaced via an OpenRouter comparison) notes that free-tier endpoints **can log prompts**, and recommends adding a `data_collection: "deny"` filter to narrow which providers are eligible — with no confirmation that this override is even available on the free routing tier. For a product generating original narrative IP, that's a meaningful caveat.
- **Redundancy:** Kilo Gateway explicitly describes load-balancing some of its traffic across "gateways like OpenRouter/Vercel." If OpenRouter is already in your waterfall (it appears to be, per your build history), Kilo Gateway risks being a second, less-transparent layer over some of the same underlying capacity.
- **Verdict:** Not recommended. The combination of unclear data handling on the free tier and likely functional overlap with your existing OpenRouter integration doesn't justify the added complexity.
- **Sources:** [kilo.ai/docs/gateway](https://kilo.ai/docs/gateway), [kilo.ai/docs/getting-started/rate-limits-and-costs](https://kilo.ai/docs/getting-started/rate-limits-and-costs), [openrouter.ai/blog Kilo Code + OpenRouter](https://openrouter.ai/blog/tutorials/kilo-code-openrouter/)

---

### 7. OpenCode Zen
**Docs:** `https://opencode.ai/docs/zen/`

- **What it is:** A curated, benchmarked model gateway built for the **OpenCode** coding agent (formerly an SST project) — again, a coding-tool business, not a general-purpose free API.
- **This does not meet your "free-tier" bar:** Zen's own docs describe onboarding as "you sign in to OpenCode Zen, **add your billing details**, and copy your API key," with balances auto-reloading at $20 once you drop below $5. This is a pay-as-you-go product with no meaningful no-card free path.
- **The handful of models that are free are explicitly trial/promotional, with active data-use warnings:**
  - "Big Pickle" (a stealth model): free for a limited time, but Zen's own docs state collected data **may be used to improve the model** during that window.
  - "North Mini Code Free": same "may be retained and used to improve the model" language, plus "do not submit personal or confidential data."
  - An NVIDIA free endpoint routed through Zen is marked "trial use only... your use is logged for security purposes and to improve NVIDIA products."
- **Why this matters for Twistloom specifically:** these are exactly the kind of explicit "don't send us anything you care about" disclaimers that are incompatible with routing production narrative generation (which is your actual product, not incidental scratch text) through a provider.
- **Verdict:** Not recommended. It requires payment infrastructure to use at all, and the free slice that exists is explicitly unsuited to production content.
- **Sources:** [opencode.ai/docs/zen/](https://opencode.ai/docs/zen/), [open-code.ai/en/docs/zen model list](https://open-code.ai/en/docs/zen)

---

### 8. LLM7.io
**Base URL:** `https://api.llm7.io/v1` · **OpenAI-compatible:** Yes

- **What it is:** An independent, small-operator API gateway that mirrors/proxies access to a mix of open models (DeepSeek, Qwen, Llama, Mistral) and, notably, branded ones (it lists `gpt-4o-mini` and `gemini-2.5-flash-lite` in its catalog).
- **Explicitly not affiliated with the model owners it proxies** — LLM7.io states plainly it has no relationship with OpenAI, DeepSeek, Meta, or the other labs whose model names appear in its catalog. That's worth pausing on: offering a name-brand closed model like GPT-4o-mini for free, at scale, with no stated affiliation to OpenAI, is the kind of arrangement that's fragile by construction — it can be cut off with no notice if the underlying access path changes, and it's not something you can point to a stable contractual relationship for.
- **Free tier:** Two published figures conflict slightly across sources — the newer official limits page cites 500,000 tokens/day anonymous (60 req/hr, 10 req/min, 1 req/sec) rising to 1,000,000 tokens/day with a free registered token (250 req/hr, 60 req/min, 2 req/sec); older third-party write-ups cite a simpler 30 RPM (120 RPM with token registration). Treat the official docs.llm7.io figures as current.
- **Commercial use:** ToS doesn't explicitly forbid commercial use, but does grant LLM7.io "a non-exclusive licence to process your prompts/outputs...to operate, secure, troubleshoot, and improve the Service (including safety systems)" — broad enough language that you should read it in full before routing real product traffic through it.
- **Reliability:** Independent reviewers explicitly describe it as "not recommended for production due to limited infrastructure and no SLA."
- **Verdict:** It's real and it works, but the combination of an unaffiliated-mirror business model and no SLA makes it a candidate for the very bottom of your waterfall (last-resort fallback), not a rung you'd want traffic hitting often.
- **Sources:** [github.com/chigwell/llm7.io TERMS.md](https://github.com/chigwell/llm7.io/blob/main/TERMS.md), [docs.llm7.io/limits](https://docs.llm7.io/limits), [llm7.io](https://llm7.io/)

---

### 9. Aion Labs
**Base URL:** `https://api.aionlabs.ai/v1` · **OpenAI-compatible:** Yes

- **What it is:** A small, independent AI provider whose flagship differentiator is genuinely relevant to you: several of its models (Aion 2.0, Aion 2.5, Aion-RP) are specifically fine-tuned for **immersive roleplay and storytelling**, described in third-party benchmarking writeups as handling "mature or darker themes with notable nuance" and generating narrative tension, conflict, and dramatic stakes. That's a closer thematic match to psychological horror interactive fiction than any other candidate on this list.
- **Free tier:** $0, no credit card required, framed by Aion Labs itself as "a daily token allowance to explore the API and browser chat." Independent trackers converge on roughly 15 requests/minute and 20,000 tokens/day per model. That daily ceiling is small — likely enough for a handful of page generations per day at most, depending on your prompt sizes (your prompt.ts work suggests next-page prompts alone can run well into the thousands of tokens before generation even starts).
- **Commercial use:** Not documented one way or the other by Aion Labs' own pricing page in what's publicly indexed; independent trackers flag it explicitly as "commercial use: unclear, verify" rather than confirming either way.
- **Verdict:** Worth a direct look specifically *because* of the narrative-fiction specialization — but given the tiny daily quota and undocumented commercial terms, treat it as an opportunistic/niche low-volume tier (e.g., reserved for a specific narrative moment or mode) rather than a general-purpose rung, and get written confirmation of commercial terms before depending on it.
- **Sources:** [aionlabs.ai/pricing/](https://www.aionlabs.ai/pricing/), [developer.puter.com Aion model descriptions](https://developer.puter.com/ai/aion-labs/aion-1.0/)

---

### 10. Chutes.ai
**Base URL:** `https://llm.chutes.ai/v1/chat/completions` · **OpenAI-compatible:** Yes

- **What it is:** A decentralized, serverless inference marketplace built on the Bittensor network (Subnet 64). Instead of Chutes running its own datacenters, independent "miners" — anyone who registers GPU capacity on the subnet — compete to serve your requests, subsidized economically by Bittensor's TAO token incentives. Chutes is also a top model provider *behind* OpenRouter, so if OpenRouter is in your waterfall already, some Chutes capacity may already be indirectly reachable through it.
- **Free tier:** Some models are genuinely free (subsidized by TAO economics), others are heavily discounted (as low as $0-$0.30/million tokens) — real numbers, not a bait-and-switch, but tied to Bittensor subnet economics that Chutes itself says can fluctuate.
- **Data handling — the important nuance:** Chutes' own ToS states that in standard API mode, no request/response content is written to a database or persistent log — but the actual inference is still executed by whichever anonymous miner operator wins that request's auction. There's no cross-operator data-sharing "by design," but also no cryptographic guarantee of that outside of Chutes' explicit **TEE (confidential compute)** or **end-to-end encryption** modes, which appear to be flagged per-model (`confidential_compute: true`), not universal. For a commercial product generating original story content, this is worth a real decision: either restrict Chutes usage to TEE-flagged models, or treat it as fine because generated fiction isn't sensitive personal data — that's a judgment call for you, not something I can resolve for you.
- **Reliability:** Chutes' own third-party coverage describes it candidly as "decentralized = variable" reliability, appropriate for hobby/non-critical use, "not without backup" for anything needing an SLA.
- **Verdict:** Legitimate model diversity and real cost savings, but it's structurally different from every other candidate here (no single accountable operator running the compute). Usable as a fallback tier if you restrict to TEE/confidential-compute-flagged models, or as a very-low-priority rung otherwise.
- **Sources:** [chutes.ai/terms](https://chutes.ai/terms), [chutes.ai/pricing](https://chutes.ai/pricing), [chutes.ai/llms.txt](https://chutes.ai/llms.txt)

---

### 11. Glhf.chat — does not fit (fact-check failure)
**Web:** `https://glhf.chat/`

- **What your sources say:** The Hacker News post and the r/LocalLLaMA thread you linked are both from **late July/early August 2024**, describing glhf.chat's launch as "free for now while we figure out how to price it."
- **What's actually true as of 2026:** glhf.chat shipped **usage-based billing in January 2025** — a "Usage-based pricing model launched: Pay-as-you-go system with no mandatory subscriptions, Always-on models priced per token via Fireworks and Together," per the platform's own announcement thread. The current landing page describes "simple, pay-as-you-go pricing" for up to 640GB VRAM of model access — there is no remaining free tier.
- **Verdict:** This is a straightforward case of stale sourcing — the links you have describe a beta period that ended roughly a year and a half ago. It does not belong in a *free-tier* waterfall at all today. If you want it as a *paid* fallback provider that's a separate conversation.
- **Sources:** [news.ycombinator.com original 2024 launch thread](https://news.ycombinator.com/item?id=41052934), [social.vivaldi.net billing-launch announcement](https://social.vivaldi.net/@michabbb/113783803046725911), [glhf.chat/landing/home](https://glhf.chat/landing/home)

---

### 12. SambaNova Cloud
**Base URL:** `https://api.sambanova.ai/v1` · **OpenAI-compatible:** Yes

- **What it is:** A developer API over custom Reconfigurable Dataflow Unit (RDU) hardware, from SambaNova Systems — founded 2017 by former Stanford professors and Sun Microsystems veterans, having raised over $1.1B. This is a real, well-capitalized company with an enterprise sales motion, not a hobby project.
- **Free tier:** Genuinely persistent — SambaNova's own rate-limits documentation states the Free Tier applies specifically whenever **no payment method is linked to your account**; linking a card moves you to the paid Developer Tier automatically. No card required to start. Current per-model limits reported by trackers sit around 20 requests/minute, 20 requests/day, 200K tokens/day per model (down from a much higher 600 RPM figure reported at launch — treat the lower, more recent number as the one to design around, and re-verify in-console since SambaNova has revised limits before).
- **Model catalog:** Llama 3.1/3.3 (up to 405B), DeepSeek, Qwen 2.5, MiniMax — a solid, current open-model lineup, served at genuinely fast token-generation speeds (SambaNova's core differentiator).
- **Commercial use:** No explicit restriction found; several independent trackers flag it as "unclear, verify," but there's no stated prohibition, and SambaNova's whole business model is selling commercial inference — a hobbyist non-commercial carve-out would be unusual for this kind of company.
- **Verdict:** One of the strongest candidates here — established company, real persistent free tier, no card required, OpenAI-compatible. Recommended.
- **Sources:** [docs.sambanova.ai rate-limits policy](https://docs.sambanova.ai/docs/en/models/rate-limits), [sambanova.ai/blog Developer Tier launch](https://sambanova.ai/blog/sambanova-cloud-developer-tier-is-live)

---

### 13. Agnes AI
**Web:** `https://agnes-ai.com/` · **API key:** `https://platform.agnes-ai.com/login`

- **What it is:** A Singapore-based platform (by "Sapiens AI") positioning itself as a free, unified gateway to text/image/video models under its own brand names — Agnes, Echo, Pavo — described in its own marketing as aggregating "10 top global AI labs," with the flagship text model apparently a rebrand of a model from an unnamed "Global Top 10 AI Lab."
- **Track record:** Very new. Its own launch timeline (per a third-party review) shows the platform, text model, image models, and video model all launching within roughly the same few months of 2026. There's essentially no multi-year operating history to evaluate reliability against.
- **Even sympathetic independent coverage flags real uncertainty:** one review explicitly notes "there is still some unclear information (such as usage limitations)" despite otherwise being positive about the platform's potential.
- **Marketing posture:** Heavy consumer social-media presence (TikTok, Instagram, YouTube) and bold claims ("99.9% SLA," "world-class AI models," free access framed as a headline feature) that read more like a growth-stage consumer product than infrastructure a commercial platform would build a dependency on.
- **Commercial use / ToS:** Not clearly documented in what's publicly indexed. Given the platform's own reviewers can't pin down usage limitations, I would not treat commercial-use terms as settled either.
- **Verdict:** Not recommended at this time. Interesting to watch as it matures, but there isn't enough of an operating or documentation track record yet to justify integrating it into a commercial waterfall.
- **Sources:** [agnes-ai.com](https://agnes-ai.com/), [bittime.com Agnes AI review](https://www.bittime.com/en/blog/apa-itu-agnes-ai-platform-multi-agent), [toolify.ai Agnes AI listing](https://www.toolify.ai/tool/agnes-ai)

---

## Cross-Cutting Corrections to Your Notes

1. **OVHcloud "API key" link** you listed points to the model catalog, not the key-generation flow — keys come from OVHcloud Manager (Public Cloud → AI & Machine Learning → AI Endpoints → API keys), which likely requires a full OVHcloud/Public Cloud account.
2. **Z.ai base URL** (`open.bigmodel.cn`) is the China-domestic platform with a reported China-phone signup requirement — the same GLM models are reachable through the international `z.ai/model-api` platform without that barrier.
3. **SiliconFlow base URL** (`api.siliconflow.cn`) is likewise the domestic platform; the usable-from-anywhere version lives at `siliconflow.com`, not `.cn`.
4. **Glhf.chat** is no longer free — your cited sources (HN, Reddit) predate its January 2025 shift to paid, usage-based billing by about half a year.
5. **OpenCode Zen** is not a free-tier provider in the sense the rest of this list is — it requires billing details to use at all, with only a few explicitly-trial, do-not-submit-real-data models carved out as an exception.

---

## Suggested Integration Priority

If you want a rough ordering for where these land in the waterfall (highest-confidence/highest-throughput first):

1. **SambaNova Cloud** — established company, real quota, fast, no card
2. **OVHcloud AI Endpoints** — established company, EU-sovereign, genuinely free at real throughput
3. **Z.ai** (via the `z.ai` international endpoint) — capable models, commercial-friendly license language, decent quota
4. **ModelScope** — strong models, generous quota, pending confirmation of registration/commercial terms
5. **Ollama Cloud** — legitimate but awkward quota model (GPU-time, not tokens) and no SLA; good deep-fallback
6. **SiliconFlow** (`.com` only) — usable but thinly documented free tier
7. **Chutes.ai** — restrict to TEE-flagged models if added; decentralized reliability is genuinely variable
8. **Aion Labs** — narrow but thematically interesting; reserve for a specific low-volume use case rather than general rotation
9. **LLM7.io** — last-resort fallback only, given the unaffiliated-mirror business model and no SLA

**Skip:** Kilo Gateway, OpenCode Zen, Agnes AI, Glhf.chat — none of these clear the bar of "genuinely free, commercially usable, and reasonably accountable" for the reasons detailed above.

## Before You Ship Any of These

- Re-verify every rate-limit figure in each provider's own console/dashboard — third-party trackers (freellm.net, ayautomate.com, and similar sites cited above) are useful for triage but visibly disagree with each other on exact numbers for several of these providers, and none of them are the source of truth.
- Read the actual ToS/Terms of Use for whichever providers you shortlist, end to end, rather than relying on third-party "commercial use: unclear" flags — several of the providers above simply don't have this documented anywhere I could find, which means the honest answer is "ask them directly" rather than "assume yes."
- Cross-check this list against your actual live 9-provider config for functional redundancy (aggregator-vs-aggregator, speed-host-vs-speed-host) — I only had visibility into a partial picture of what's currently deployed.
