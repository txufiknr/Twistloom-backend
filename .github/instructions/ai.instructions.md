---
applyTo: "src/utils/ai*.ts, src/config/ai*.ts, src/utils/prompt*.ts"
---

# AI Orchestration Instructions

See `AGENTS.md` for the full architectural invariants. This file adds path-specific context for AI provider integration, prompt engineering, and structured output.

## Provider Abstraction

- AI providers are replaceable implementations behind shared abstractions.
- Business logic must not depend unnecessarily on one provider.
- Provider/model failure should follow the existing fallback and retry strategy.
- Do not bypass the provider abstraction for convenience.

## Provider Waterfall (19 Providers)

1. Mistral — Primary creative writing prose & natural character voices
2. Google Gemini — Large context (1M+ tokens), rapid generation, world-building lore
3. OpenRouter — Unified gateway for Qwen, Llama-4, DeepSeek, Nemotron
4. Cerebras — Ultra-high-speed inference for GLM-4.7 & reasoning
5. Groq — Low-latency fast validation (Llama-3.3, Qwen)
6. NVIDIA — Cost-effective Llama-3.3 on NIM
7. Cloudflare Workers AI — Edge inference for Mistral-7B / Llama-3.1
8. Cohere — Last-resort fallback (Command-R)
9. OVHcloud — High-capacity (400 RPM authenticated), Qwen3.6-27B / GPT-OSS-120B
10. SambaNova — DeepSeek-V3.2 / Llama on custom RDU hardware
11. ModelScope — Qwen3.5-family (Alibaba-first releases)
12. Z.ai — GLM-4.7-Flash (warm, theatrical prose)
13. SiliconFlow — Qwen3-8B ($0 tier, light fallback)
14. Aion Labs — aion-2.5 (dark/mature fiction, ~20K token/day budget)
15. Chutes — Decentralized Bittensor compute (requires funded account)
16. LLM7.io — Unofficial mirror/last-resort fallback (no SLA)
17. Inception Labs — Mercury diffusion LLM (API-credits campaign)
18. Ollama — Local inference for development/testing
19. Jina — Embeddings only (jina-embeddings-v5-text-small, not a chat provider)

## Deterministic vs Generative

- Use AI for tasks requiring semantic or generative reasoning.
- Prefer deterministic code for: validation, numerical state transitions, limits, thresholds, permissions, branching contracts, economy calculations, state reconstruction, structural consistency.
- Do not move deterministic engine responsibility into prompts merely because an LLM could perform the task.

## Prompt Engineering

- Avoid increasing prompt/context size without a clear reason.
- Preserve structured-output validation and error recovery.
- Prompt templates are in `src/config/` — do not scatter prompts across business logic.

## SSE Streaming

- Always pass `c.req.raw.signal` into AI provider calls so client disconnections terminate upstream GPU workloads.
- Use `pipeSSEStreamAndExtractText` for text extraction — never concatenate raw Uint8Array chunks.
- Use `StreamingJsonAnswerExtractor` for structured JSON responses — never pipe raw JSON tokens to client.
- DB cache MUST store pure text, never SSE wire protocol envelopes.

## Token Cost

- Consider token/cost impact of every AI-related change.
- Memoize expensive prompt serialization with page-scoped keys.
- Prefer smaller models for validation tasks.
