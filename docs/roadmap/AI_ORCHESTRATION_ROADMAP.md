# Twistloom AI Orchestration — Hardening & Expansion Roadmap

This roadmap addresses three issues found in the current `aiPrompt`/`aiStreamSSE`
fallback system and adds two new free-tier providers (**OpenRouter** and
**Cloudflare Workers AI**) using the existing `openai` SDK — no new pnpm
packages required.

**Order matters.** Phases 1–3 are independent fixes you can ship separately.
Phases 4–5 (new providers) depend on the factory created in Phase 3, so do
that one first if you want the new providers too.

| Phase | What | Files touched |
|---|---|---|
| 0 | Add `'openrouter'` / `'cloudflare'` to the provider type union | `types/ai-chat.ts` |
| 1 | Wire up dead `canUseAIToday` daily-limit check | `ai-chat.ts`, `ai-chat-stream.ts` |
| 2 | Fix `RateLimiter` concurrency race | `ai-limiters.ts` |
| 3 | Extract OpenAI-compatible factory (DRY) | `ai-chat.ts`, `ai-chat-stream.ts` |
| 4 | Add OpenRouter | `ai-clients.ts`, `ai-clients.config.ts`, `ai-limiters.ts`, `ai-chat.ts`, `ai-chat-stream.ts`, `.env` |
| 5 | Add Cloudflare Workers AI | same files as Phase 4 |
| 6 | DB migration + verification checklist | `db/schema.ts` + manual testing |

---

## Phase 0 — Extend the provider type union

Find the file that declares the provider union (likely
`src/types/ai-chat.ts`), and add the two new providers:

```ts
// Before
export type AIChatProvider =
  | 'github'
  | 'gemini'
  | 'cohere'
  | 'mistral'
  | 'groq'
  | 'cerebras'
  | 'nvidia';

// After
export type AIChatProvider =
  | 'github'
  | 'gemini'
  | 'cohere'
  | 'mistral'
  | 'groq'
  | 'cerebras'
  | 'nvidia'
  | 'openrouter'
  | 'cloudflare';
```

**Do this first, even before Phase 1–3.** Every `Record<AIChatProvider, ...>`
in the codebase (`AI_RATE_LIMITS`, `AI_MAX_PROMPT_LENGTH`,
`AI_PROVIDER_API_KEYS`, `AI_RATE_LIMITS_WITH_BUFFER`) will now fail to
type-check until you fill in entries for `openrouter` and `cloudflare`. Use
those compiler errors as your checklist for Phases 4–5 — if you miss a
config entry, TypeScript will tell you exactly where.

If you'd rather land Phases 1–3 first without the compile errors, skip Phase
0 until you reach Phase 4.

---

## Phase 1 — Wire up `canUseAIToday`

**Problem:** `canUseAIToday(provider)` is fully implemented in
`ai-limiters.ts` but never called. Daily RPD limits are only discovered
reactively (via a 429), wasting a request and a round trip on an exhausted
provider before falling back.

### 1a. `ai-chat.ts` — import the function

```ts
// Before
import { getRateLimiter, incrementDailyUsageCount } from './ai-limiters.js';

// After
import { canUseAIToday, getRateLimiter, incrementDailyUsageCount } from './ai-limiters.js';
```

### 1b. `ai-chat.ts` — gate the provider loop in `aiPrompt`

Find the prompt-length validation block inside the `for (const provider of providers)` loop:

```ts
      // Validate prompt length against provider's maximum limit
      const totalDocumentsLength = documents.reduce((sum, doc) => sum + `${doc.title ?? ''}${doc.snippet}`.length, 0);
      const totalPromptLength = systemPrompt.length + prompt.length + totalDocumentsLength;
      const maxPromptLength = AI_MAX_PROMPT_LENGTH[provider];
      if (totalPromptLength > maxPromptLength) {
        console.log(`[${provider}] ⚠️ Prompt length (${totalPromptLength.toLocaleString()} chars) exceeds limit (${maxPromptLength.toLocaleString()} chars), skipping`);
        continue;
      }
```

Add a daily-limit check immediately after it:

```ts
      // Validate prompt length against provider's maximum limit
      const totalDocumentsLength = documents.reduce((sum, doc) => sum + `${doc.title ?? ''}${doc.snippet}`.length, 0);
      const totalPromptLength = systemPrompt.length + prompt.length + totalDocumentsLength;
      const maxPromptLength = AI_MAX_PROMPT_LENGTH[provider];
      if (totalPromptLength > maxPromptLength) {
        console.log(`[${provider}] ⚠️ Prompt length (${totalPromptLength.toLocaleString()} chars) exceeds limit (${maxPromptLength.toLocaleString()} chars), skipping`);
        continue;
      }

      // Skip providers that have already exhausted their daily request budget
      if (!(await canUseAIToday(provider))) {
        console.log(`[${provider}] ⚠️ Daily request limit reached, skipping`);
        continue;
      }
```

### 1c. `ai-chat-stream.ts` — same import change

```ts
// Before
import { getRateLimiter, incrementDailyUsageCount } from './ai-limiters.js';

// After
import { canUseAIToday, getRateLimiter, incrementDailyUsageCount } from './ai-limiters.js';
```

### 1d. `ai-chat-stream.ts` — gate the provider loop in `aiStreamSSE`

Find this block (inside the `for (const provider of providers)` loop, before
the per-model loop starts):

```ts
          const models = modelSelection[provider];
          if (!models || models.length === 0) continue; // Skip to next provider

          // Validate prompt length against provider's maximum limit
          const totalPromptLength = systemPrompt.length + prompt.length;
          const maxPromptLength = AI_MAX_PROMPT_LENGTH[provider];
          if (totalPromptLength > maxPromptLength) {
            console.log(`[${provider}] ⚠️ Prompt length (${totalPromptLength.toLocaleString()} chars) exceeds limit (${maxPromptLength.toLocaleString()} chars), skipping`);
            continue;
          }
```

Add the same check:

```ts
          const models = modelSelection[provider];
          if (!models || models.length === 0) continue; // Skip to next provider

          // Validate prompt length against provider's maximum limit
          const totalPromptLength = systemPrompt.length + prompt.length;
          const maxPromptLength = AI_MAX_PROMPT_LENGTH[provider];
          if (totalPromptLength > maxPromptLength) {
            console.log(`[${provider}] ⚠️ Prompt length (${totalPromptLength.toLocaleString()} chars) exceeds limit (${maxPromptLength.toLocaleString()} chars), skipping`);
            continue;
          }

          // Skip providers that have already exhausted their daily request budget
          if (!(await canUseAIToday(provider))) {
            console.log(`[${provider}] ⚠️ Daily request limit reached, skipping`);
            continue;
          }
```

**That's it for Phase 1.** Both orchestrators now skip providers whose
`usage` table count for today already meets/exceeds `AI_RATE_LIMITS[provider].rpd`,
before spending an HTTP round trip on them.

---

## Phase 2 — Fix the `RateLimiter` concurrency race

**Problem:** `throttle()` reads `this.lastCall`, computes a wait, then writes
`this.lastCall` — with an `await` in between. Two concurrent calls for the
same provider can both read the same `lastCall`, both decide "no wait
needed," and both fire near-simultaneously, doubling the realized RPM.

**Fix:** serialize `throttle()` calls through a promise chain so each caller
waits for the previous one to finish updating `lastCall` before computing its
own wait.

### `ai-limiters.ts`

```ts
// Before
export class RateLimiter {
  private lastCall: number = 0;
  private readonly delay: number;

  constructor(private readonly provider: AIChatProvider) {
    const config = AI_RATE_LIMITS_WITH_BUFFER[provider];
    if (!config) {
      throw new Error(`No rate limit configuration found for provider: ${provider}`);
    }
    this.delay = config.delayMs;
  }

  async throttle(): Promise<void> {
    const now = Date.now();
    const timeSinceLastCall = now - this.lastCall;
    
    if (timeSinceLastCall < this.delay) {
      const waitTime = this.delay - timeSinceLastCall;
      console.log(`[RateLimiter] Throttling ${this.provider} - waiting ${waitTime}ms`);
      await delay(waitTime);
    }
    
    this.lastCall = Date.now();
  }
```

```ts
// After
export class RateLimiter {
  private lastCall: number = 0;
  private readonly delay: number;

  /**
   * Serializes concurrent throttle() calls. Each call chains onto this promise,
   * so overlapping callers wait their turn instead of all reading the same
   * `lastCall` and passing the gate simultaneously.
   */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly provider: AIChatProvider) {
    const config = AI_RATE_LIMITS_WITH_BUFFER[provider];
    if (!config) {
      throw new Error(`No rate limit configuration found for provider: ${provider}`);
    }
    this.delay = config.delayMs;
  }

  async throttle(): Promise<void> {
    // Grab a slot in the queue, chained after whoever is currently waiting
    const previous = this.queue;
    let release: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });

    await previous;

    try {
      const now = Date.now();
      const timeSinceLastCall = now - this.lastCall;

      if (timeSinceLastCall < this.delay) {
        const waitTime = this.delay - timeSinceLastCall;
        console.log(`[RateLimiter] Throttling ${this.provider} - waiting ${waitTime}ms`);
        await delay(waitTime);
      }

      this.lastCall = Date.now();
    } finally {
      release!();
    }
  }
```

Everything else in the `RateLimiter` class (`getDelay`, `getProvider`,
`getRPM`) stays unchanged.

**Quick way to verify this works:** temporarily fire 5 concurrent
`getGroqLimiter().throttle()` calls in a scratch script and log
`Date.now()` after each resolves — they should now come back roughly
`delayMs` apart instead of all at once.

---

## Phase 3 — Extract a reusable OpenAI-compatible factory

**Problem:** `githubPrompt` (and `githubStreamGenerator`) are ~60-line
functions that are 95% identical to what any other `/v1/chat/completions`
provider needs. OpenRouter and Cloudflare Workers AI (Phases 4–5) are both
OpenAI-spec, so we extract the shared logic once and reuse it.

### 3a. `ai-chat.ts` — add a type-only import for the client class

The file already has:

```ts
import type OpenAI from 'openai/resources/chat/completions.js';
```

This `OpenAI` name refers to the **chat completions resource types**
(`OpenAI.ChatCompletion`, `OpenAI.ChatCompletionCreateParamsNonStreaming`,
etc.), not the client class — so we need a second, aliased import for the
actual `OpenAI` client class returned by `getGitHubClient()`:

```ts
// Add this alongside the existing type imports
import type OpenAIClient from 'openai';
```

### 3b. `ai-chat.ts` — import the new client getters (for later phases)

```ts
// Before
import { AI_PROVIDER_API_KEYS, getCerebrasClient, getCohereClient, getGeminiClient, getGitHubClient, getGroqClient, getMistralClient } from "./ai-clients.js";

// After (the new getters are created in Phase 4 & 5 — add the imports now so it compiles once you reach those phases)
import { AI_PROVIDER_API_KEYS, getCerebrasClient, getCloudflareClient, getCohereClient, getGeminiClient, getGitHubClient, getGroqClient, getMistralClient, getOpenRouterClient } from "./ai-clients.js";
```

> If you're doing Phase 3 in isolation (not yet adding the new providers),
> skip this import change for now — just add `getOpenRouterClient` and
> `getCloudflareClient` when you get to Phase 4/5.

### 3c. `ai-chat.ts` — add the factory function

Add this new exported function near the top of the file, just after
`promptWithFallback`:

```ts
/**
 * Creates a prompt function for any OpenAI Chat Completions–compatible provider
 * (GitHub Models, OpenRouter, Cloudflare Workers AI, and any future provider that
 * implements the standard `/v1/chat/completions` request/response shape).
 *
 * This is the shared implementation behind {@link githubPrompt}; new
 * OpenAI-compatible providers should be defined as a one-line call to this
 * factory rather than copy-pasting a full prompt function.
 *
 * @param provider - Provider name for logging, rate limiting, and config lookups
 * @param getClient - Singleton client getter (e.g. {@link getGitHubClient})
 * @returns A prompt function with the same signature as {@link githubPrompt}
 */
export function createOpenAICompatiblePrompt(
  provider: AIChatProvider,
  getClient: () => OpenAIClient
) {
  return async function (
    prompt: string,
    options?: Partial<PromptWithFallbackOptions>
  ): Promise<AIResponse<string> | null> {
    return promptWithFallback<OpenAI.ChatCompletion>(
      provider,
      prompt,
      options,
      async (model, prompt, opts) => {
        const { context, config = AI_CHAT_CONFIG_DEFAULT, outputAsJson, outputJsonStructure, outputJsonRequired } = opts;
        const systemPromptWithDocuments = formatSystemPromptWithDocuments(provider, opts);
        return await getClient().chat.completions.create({
          model,
          messages: [
            { role: 'system', content: systemPromptWithDocuments },
            { role: 'user', content: prompt },
          ],
          max_tokens: config.maxOutputToken,
          temperature: config.temperature,
          top_p: config.topP,
          stream: false,
          stop: config.stopSequences,
          response_format: outputAsJson ? (outputJsonStructure ? {
            type: "json_schema",
            json_schema: {
              name: context ?? "output-format",
              strict: true,
              schema: {
                type: "object",
                properties: outputJsonStructure,
                required: outputJsonRequired,
                additionalProperties: false
              } satisfies AIJsonProperty
            }
          } : { type: 'json_object' }) : undefined,
        } satisfies OpenAI.ChatCompletionCreateParamsNonStreaming);
      },
      (response) => {
        const content = response.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) {
          console.warn(`[${provider}] ⚠️ Invalid or empty model response`);
          return null;
        }
        return content.trim();
      },
      (response) => {
        const { usage } = response;
        if (!usage) {
          console.warn(`[${provider}] ❓ No usage data in response`);
          return undefined;
        }
        return {
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
        };
      },
      (response) => response.choices?.[0]?.finish_reason ?? 'unknown'
    );
  };
}
```

### 3d. `ai-chat.ts` — refactor `githubPrompt` to use the factory

Replace the entire existing `githubPrompt` function body with:

```ts
export const githubPrompt = createOpenAICompatiblePrompt('github', getGitHubClient);
```

Everything else (the JSDoc comment above the original function) can stay —
just keep it directly above this one-liner so the documentation is preserved.

> ⚠️ `githubPrompt` was previously a `function` declaration; it's now a
> `const` arrow/function value from the factory. Both are callable the same
> way (`githubPrompt(prompt, opts)`), so no caller changes are needed — but
> if anything elsewhere imports it for its function-declaration-specific
> behavior (hoisting), double check. In practice nothing in this codebase
> relies on that.

### 3e. `ai-chat-stream.ts` — same type import addition

```ts
// Add alongside the existing type imports
import type OpenAIClient from 'openai';
```

### 3f. `ai-chat-stream.ts` — import the new client getters (for later phases)

```ts
// Before
import { getCerebrasClient, getCohereClient, getGeminiClient, getGitHubClient, getGroqClient, getMistralClient } from "./ai-clients.js";

// After
import { getCerebrasClient, getCloudflareClient, getCohereClient, getGeminiClient, getGitHubClient, getGroqClient, getMistralClient, getOpenRouterClient } from "./ai-clients.js";
```

### 3g. `ai-chat-stream.ts` — add the streaming factory

Add this near the top of the file (e.g. just before `githubStreamGenerator`):

```ts
/**
 * Creates a streaming generator for any OpenAI Chat Completions–compatible
 * provider. Shared implementation behind {@link githubStreamGenerator}.
 *
 * @param provider - Provider name for logging and config lookups
 * @param getClient - Singleton client getter
 * @param defaultModel - Fallback model ID if `options.models` is empty
 */
function createOpenAICompatibleStreamGenerator(
  provider: AIChatProvider,
  getClient: () => OpenAIClient,
  defaultModel: string
) {
  return async function* (
    prompt: string,
    options: Partial<PromptWithFallbackOptions>
  ): AIStreamGenerator {
    const { signal } = options;
    const { context, config = AI_CHAT_CONFIG_DEFAULT, outputAsJson, outputJsonStructure, outputJsonRequired } = options;
    const systemPromptWithDocuments = formatSystemPromptWithDocuments(provider, options);

    const stream = await getClient().chat.completions.create({
      model: options.models?.[0] || defaultModel,
      messages: [
        { role: 'system', content: systemPromptWithDocuments },
        { role: 'user', content: prompt },
      ],
      max_tokens: config.maxOutputToken,
      temperature: config.temperature,
      top_p: config.topP,
      stream: true,
      stream_options: { include_usage: true },
      stop: config.stopSequences,
      response_format: outputAsJson ? (outputJsonStructure ? {
        type: "json_schema",
        json_schema: {
          name: context ?? "output-format",
          strict: true,
          schema: {
            type: "object",
            properties: outputJsonStructure,
            required: outputJsonRequired,
            additionalProperties: false
          }
        }
      } : { type: 'json_object' }) : undefined,
    } satisfies OpenAI.ChatCompletionCreateParamsStreaming, { signal });

    let usage: StreamUsage | undefined;

    for await (const chunk of stream) {
      if (signal?.aborted) return usage;

      // Final chunk (stream_options.include_usage) has usage + empty choices
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens,
          cachedTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
        };
      }

      const delta = chunk.choices[0]?.delta?.content || '';
      if (delta) yield delta;
    }

    return usage;
  };
}
```

### 3h. `ai-chat-stream.ts` — refactor `githubStreamGenerator` to use the factory

Replace the entire existing `githubStreamGenerator` function with:

```ts
const githubStreamGenerator = createOpenAICompatibleStreamGenerator('github', getGitHubClient, 'gpt-4o');
```

Keep the JSDoc comment ("GitHub streaming generator that yields chunks")
above it for documentation continuity.

**Phase 3 checkpoint:** run `pnpm build` (or `tsc --noEmit`). Behavior for
GitHub should be byte-for-byte identical — you've only moved code, not
changed logic. If this doesn't compile cleanly before moving on, stop here
and fix it; Phases 4–5 build directly on top of this factory.

---

## Phase 4 — Add OpenRouter

OpenRouter is OpenAI-spec compatible, so this reuses the `openai` package
you already have installed — **no new pnpm packages**.

Free tier: 20 RPM, 50 requests/day (or **1,000/day permanently** after a
one-time $10 credit purchase — recommended). Verify current free model IDs
at [openrouter.ai/models](https://openrouter.ai/models) since the `:free`
roster changes without notice.

### 4a. `.env` — add the API key

```bash
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 4b. `types/ai-chat.ts` — done in Phase 0

If you skipped Phase 0, add `'openrouter'` to the `AIChatProvider` union now.

### 4c. `ai-clients.ts` — add the singleton client

```ts
// Add to the singleton declarations near the top
let openrouterClient: OpenAI | null = null;
```

```ts
// Add to AI_PROVIDER_API_KEYS
export const AI_PROVIDER_API_KEYS: Record<AIChatProvider, string> = {
  github: 'GITHUB_API_KEY',
  gemini: 'GEMINI_API_KEY',
  cohere: 'COHERE_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',   // <-- new
  cloudflare: 'CLOUDFLARE_API_TOKEN', // <-- new (Phase 5, add now while you're here)
};
```

```ts
// Add a new client getter, alongside getGitHubClient etc.
export function getOpenRouterClient(): OpenAI {
  if (openrouterClient) return openrouterClient;

  const apiKey = requireEnv('OPENROUTER_API_KEY');

  openrouterClient = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
  });
  return openrouterClient;
}
```

### 4d. `ai-clients.config.ts` — rate limits, prompt length, model selection

```ts
// AI_RATE_LIMITS — add an entry
export const AI_RATE_LIMITS: Record<AIChatProvider, { rpm: number; rpd: number }> = {
  github:     { rpm: 15,  rpd: 150 },
  gemini:     { rpm: 15,  rpd: 1_500 },
  cohere:     { rpm: 100, rpd: 10_000 },
  mistral:    { rpm: 60,  rpd: 86_400 },
  groq:       { rpm: 30,  rpd: 14_400 },
  cerebras:   { rpm: 30,  rpd: 14_400 },
  nvidia:     { rpm: 40,  rpd: 57_600 },
  // NOTE: 1,000 RPD requires a one-time $10 credit top-up on OpenRouter (never expires).
  // If you haven't done that yet, use { rpm: 20, rpd: 50 } instead.
  openrouter: { rpm: 20,  rpd: 1_000 },
};
```

```ts
// AI_MAX_PROMPT_LENGTH — add an entry
export const AI_MAX_PROMPT_LENGTH: Record<AIChatProvider, number> = {
  gemini:     3_600_000,
  mistral:    1_000_000,
  cohere:     500_000,
  nvidia:     480_000,
  cerebras:   32_000,
  github:     30_000,
  groq:       24_000,
  // Conservative default for most :free model variants (~15K tokens).
  // If you pin a large-context free model (e.g. meta-llama/llama-4-maverick:free
  // with a 1M context), raise this — but remember the 20 RPM cap makes huge
  // prompts a poor fit regardless.
  openrouter: 60_000,
};
```

```ts
// AI_CHAT_MODELS_WRITING — add OpenRouter as a final fallback tier
export const AI_CHAT_MODELS_WRITING: AIModelSelection = {
  mistral: [
    'mistral-medium-latest',
    'mistral-large-latest'
  ],
  gemini: [
    'gemini-3-flash-preview',
    'gemini-2.5-flash'
  ],
  groq: [
    'llama-3.3-70b-versatile',
    'deepseek-r1-distill-llama-70b',
    'mixtral-8x7b-32768',
    'gemma2-9b-it',
  ],
  cerebras: [
    'llama-3.3-70b',
  ],
  nvidia: [
    'mistralai/mixtral-8x22b-instruct-v0.1',
    'meta/llama-3.3-70b-instruct',
    'qwen/qwen2.5-72b-instruct',
  ],
  cohere: [
    'command-r-08-2024'
  ],
  // Last-resort fallback when every dedicated free tier above is exhausted.
  // Verify these IDs are still :free at openrouter.ai/models before relying on them.
  openrouter: [
    'deepseek/deepseek-r1:free',         // Strong analytical/reasoning prose
    'meta-llama/llama-4-maverick:free',  // Large context, broad fallback
  ],
};
```

> The exact placement (which list gets `openrouter`) is up to you — adding it
> only to `AI_CHAT_MODELS_WRITING` is a conservative start. You can add it to
> `AI_CHAT_MODELS_THEME` or `AI_CHAT_MODELS_EVALUATION` too once you've tested
> JSON-schema behavior on the specific free model you pick (see Phase 6).

### 4e. `ai-limiters.ts` — rate limiter wiring

```ts
// AI_RATE_LIMITS_WITH_BUFFER — add an entry
const AI_RATE_LIMITS_WITH_BUFFER: Record<AIChatProvider, { rpm: number; delayMs: number }> = {
  github: getRateLimitConfig('github'),
  gemini: getRateLimitConfig('gemini'),
  cohere: getRateLimitConfig('cohere'),
  groq: getRateLimitConfig('groq'),
  cerebras: getRateLimitConfig('cerebras'),
  mistral: getRateLimitConfig('mistral'),
  nvidia: getRateLimitConfig('nvidia'),
  openrouter: getRateLimitConfig('openrouter'), // <-- new
};
```

```ts
// Singleton declarations — add
let openrouterLimiter: RateLimiter | null = null;
```

```ts
// Add a getter, following the same pattern as getGroqLimiter etc.
/**
 * Get OpenRouter rate limiter (singleton)
 * @returns Rate limiter instance for OpenRouter
 */
export function getOpenRouterLimiter(): RateLimiter {
  return openrouterLimiter || (openrouterLimiter = new RateLimiter('openrouter'));
}
```

```ts
// getRateLimiter — add a case
export function getRateLimiter(provider: AIChatProvider): RateLimiter {
  switch (provider) {
    case 'github': return getGitHubLimiter();
    case 'gemini': return getGeminiLimiter();
    case 'groq': return getGroqLimiter();
    case 'cohere': return getCohereLimiter();
    case 'cerebras': return getCerebrasLimiter();
    case 'mistral': return getMistralLimiter();
    case 'nvidia': return getNvidiaLimiter();
    case 'openrouter': return getOpenRouterLimiter(); // <-- new
    default: throw new Error(`No rate limiter found for provider: ${provider}`);
  }
}
```

### 4f. `ai-chat.ts` — define `openrouterPrompt` and wire the switch

```ts
// Add near the other provider prompt exports (e.g. after githubPrompt)
export const openrouterPrompt = createOpenAICompatiblePrompt('openrouter', getOpenRouterClient);
```

```ts
// In aiPrompt's switch statement
switch (provider) {
  case 'github': result = await githubPrompt(prompt, opts); break;
  case 'gemini': result = await geminiPrompt(prompt, opts); break;
  case 'cohere': result = await coherePrompt(prompt, opts); break;
  case 'mistral': result = await mistralPrompt(prompt, opts); break;
  case 'groq': result = await groqPrompt(prompt, opts); break;
  case 'cerebras': result = await cerebrasPrompt(prompt, opts); break;
  case 'nvidia': result = await nvidiaPrompt(prompt, opts); break;
  case 'openrouter': result = await openrouterPrompt(prompt, opts); break; // <-- new
}
```

### 4g. `ai-chat-stream.ts` — define `openrouterStreamGenerator` and wire the switch

```ts
// Add near githubStreamGenerator
const openrouterStreamGenerator = createOpenAICompatibleStreamGenerator(
  'openrouter',
  getOpenRouterClient,
  'deepseek/deepseek-r1:free'
);
```

```ts
// In aiStreamSSE's switch statement
switch (provider) {
  case 'github': streamGenerator = githubStreamGenerator(prompt, opts); break;
  case 'gemini': streamGenerator = geminiStreamGenerator(prompt, opts); break;
  case 'cohere': streamGenerator = cohereStreamGenerator(prompt, opts); break;
  case 'mistral': streamGenerator = mistralStreamGenerator(prompt, opts); break;
  case 'groq': streamGenerator = groqStreamGenerator(prompt, opts); break;
  case 'cerebras': streamGenerator = cerebrasStreamGenerator(prompt, opts); break;
  case 'nvidia': streamGenerator = nvidiaStreamGenerator(prompt, opts); break;
  case 'openrouter': streamGenerator = openrouterStreamGenerator(prompt, opts); break; // <-- new
}
```

**Phase 4 checkpoint:** add `openrouter` to a model selection map for a
low-stakes task first (e.g. a copy of `AI_CHAT_MODELS_THEME` in a test
script), run one prompt through `aiPrompt`, and confirm you see
`[openrouter] 🧠 Ready with task...` in the logs followed by a successful
response and a `usage` row increment.

---

## Phase 5 — Add Cloudflare Workers AI

Cloudflare exposed an OpenAI-compatible `/ai/v1/chat/completions` endpoint
(rolled out ~May 2026), so this **also** reuses `openai` — no new SDK.

Free tier: 10,000 neurons/day, resets daily at 00:00 UTC — roughly
100–300 text-generation requests/day depending on model size. Best suited
for small models (8B-class) and short prompts; this is a good fit for
lightweight validation/JSON-repair-style tasks, not full story-page
generation.

Two env vars are needed (not one): an API token *and* your Cloudflare
account ID, since the account ID is part of the base URL.

### 5a. `.env` — add both values

```bash
CLOUDFLARE_API_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
CLOUDFLARE_ACCOUNT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

> Get the account ID from the Cloudflare dashboard URL
> (`dash.cloudflare.com/<ACCOUNT_ID>`) — it's not secret, but keeping it in
> `.env` alongside the token keeps the client construction simple. Create
> the API token under **My Profile → API Tokens**, scoped to **Workers AI**.

### 5b. `types/ai-chat.ts` — done in Phase 0

If you skipped Phase 0, add `'cloudflare'` to the `AIChatProvider` union now.

### 5c. `ai-clients.ts` — add the singleton client

```ts
// Add to the singleton declarations near the top
let cloudflareClient: OpenAI | null = null;
```

```ts
// AI_PROVIDER_API_KEYS already updated in step 4c — confirm it includes:
//   cloudflare: 'CLOUDFLARE_API_TOKEN',
```

```ts
// Add a new client getter
export function getCloudflareClient(): OpenAI {
  if (cloudflareClient) return cloudflareClient;

  const apiKey = requireEnv('CLOUDFLARE_API_TOKEN');
  const accountId = requireEnv('CLOUDFLARE_ACCOUNT_ID');

  cloudflareClient = new OpenAI({
    apiKey,
    baseURL: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
  });
  return cloudflareClient;
}
```

> **Note on the missing-account-ID failure mode:** `promptWithFallback` only
> checks `process.env[AI_PROVIDER_API_KEYS['cloudflare']]`
> (`CLOUDFLARE_API_TOKEN`) before starting. If `CLOUDFLARE_ACCOUNT_ID` is
> missing, `requireEnv` throws *inside* `getCloudflareClient()`, which is
> called inside the per-model `try/catch` — so it'll be logged as "model
> failed" and fall through to the next model/provider rather than the
> cleaner "API key not provided" warning. Just make sure both env vars are
> set together.

### 5d. `ai-clients.config.ts` — rate limits, prompt length, model selection

```ts
// AI_RATE_LIMITS — add an entry
export const AI_RATE_LIMITS: Record<AIChatProvider, { rpm: number; rpd: number }> = {
  github:     { rpm: 15,  rpd: 150 },
  gemini:     { rpm: 15,  rpd: 1_500 },
  cohere:     { rpm: 100, rpd: 10_000 },
  mistral:    { rpm: 60,  rpd: 86_400 },
  groq:       { rpm: 30,  rpd: 14_400 },
  cerebras:   { rpm: 30,  rpd: 14_400 },
  nvidia:     { rpm: 40,  rpd: 57_600 },
  openrouter: { rpm: 20,  rpd: 1_000 },
  // Cloudflare bills in "neurons" (compute units), not requests, so this is
  // a conservative request-based proxy for the 10,000 neurons/day budget on
  // small (8B-class) models. Monitor actual neuron usage in the Cloudflare
  // dashboard and adjust `rpd` down if you pick a larger model.
  cloudflare: { rpm: 10,  rpd: 150 },
};
```

```ts
// AI_MAX_PROMPT_LENGTH — add an entry
export const AI_MAX_PROMPT_LENGTH: Record<AIChatProvider, number> = {
  gemini:     3_600_000,
  mistral:    1_000_000,
  cohere:     500_000,
  nvidia:     480_000,
  cerebras:   32_000,
  github:     30_000,
  groq:       24_000,
  openrouter: 60_000,
  // Workers AI 8B-class models commonly cap around 4-8K token context.
  // Keep this small both to fit the context window and to preserve neuron
  // budget for the output.
  cloudflare: 12_000,
};
```

```ts
// AI_CHAT_MODELS_THEME — add Cloudflare as a final fallback for small,
// structured tasks (theme ideas, meta-directives, JSON-repair-style work)
export const AI_CHAT_MODELS_THEME: AIModelSelection = {
  ...AI_CHAT_MODELS_OPENAI,
  gemini: [
    'gemini-3-flash-preview',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-1.5-flash-8b'
  ],
  mistral: [
    'mistral-small-latest',
    'mistral-medium-latest'
  ],
  cohere: ['command-r-08-2024'],
  groq: ['llama-3.3-70b-versatile'],
  cerebras: ['llama-3.3-70b'],
  nvidia: [
    'meta/llama-3.3-70b-instruct',
    'mistralai/mistral-7b-instruct'
  ],
  // Verify current model IDs/availability at developers.cloudflare.com/workers-ai/models
  cloudflare: [
    '@cf/meta/llama-3.1-8b-instruct',
    '@cf/google/gemma-3-12b-it',
  ],
};
```

### 5e. `ai-limiters.ts` — rate limiter wiring

```ts
// AI_RATE_LIMITS_WITH_BUFFER — add an entry
const AI_RATE_LIMITS_WITH_BUFFER: Record<AIChatProvider, { rpm: number; delayMs: number }> = {
  github: getRateLimitConfig('github'),
  gemini: getRateLimitConfig('gemini'),
  cohere: getRateLimitConfig('cohere'),
  groq: getRateLimitConfig('groq'),
  cerebras: getRateLimitConfig('cerebras'),
  mistral: getRateLimitConfig('mistral'),
  nvidia: getRateLimitConfig('nvidia'),
  openrouter: getRateLimitConfig('openrouter'),
  cloudflare: getRateLimitConfig('cloudflare'), // <-- new
};
```

```ts
// Singleton declarations — add
let cloudflareLimiter: RateLimiter | null = null;
```

```ts
/**
 * Get Cloudflare Workers AI rate limiter (singleton)
 * @returns Rate limiter instance for Cloudflare Workers AI
 */
export function getCloudflareLimiter(): RateLimiter {
  return cloudflareLimiter || (cloudflareLimiter = new RateLimiter('cloudflare'));
}
```

```ts
// getRateLimiter — add a case
export function getRateLimiter(provider: AIChatProvider): RateLimiter {
  switch (provider) {
    case 'github': return getGitHubLimiter();
    case 'gemini': return getGeminiLimiter();
    case 'groq': return getGroqLimiter();
    case 'cohere': return getCohereLimiter();
    case 'cerebras': return getCerebrasLimiter();
    case 'mistral': return getMistralLimiter();
    case 'nvidia': return getNvidiaLimiter();
    case 'openrouter': return getOpenRouterLimiter();
    case 'cloudflare': return getCloudflareLimiter(); // <-- new
    default: throw new Error(`No rate limiter found for provider: ${provider}`);
  }
}
```

### 5f. `ai-chat.ts` — define `cloudflarePrompt` and wire the switch

```ts
// Add near openrouterPrompt
export const cloudflarePrompt = createOpenAICompatiblePrompt('cloudflare', getCloudflareClient);
```

```ts
// In aiPrompt's switch statement
switch (provider) {
  case 'github': result = await githubPrompt(prompt, opts); break;
  case 'gemini': result = await geminiPrompt(prompt, opts); break;
  case 'cohere': result = await coherePrompt(prompt, opts); break;
  case 'mistral': result = await mistralPrompt(prompt, opts); break;
  case 'groq': result = await groqPrompt(prompt, opts); break;
  case 'cerebras': result = await cerebrasPrompt(prompt, opts); break;
  case 'nvidia': result = await nvidiaPrompt(prompt, opts); break;
  case 'openrouter': result = await openrouterPrompt(prompt, opts); break;
  case 'cloudflare': result = await cloudflarePrompt(prompt, opts); break; // <-- new
}
```

### 5g. `ai-chat-stream.ts` — define `cloudflareStreamGenerator` and wire the switch

```ts
// Add near openrouterStreamGenerator
const cloudflareStreamGenerator = createOpenAICompatibleStreamGenerator(
  'cloudflare',
  getCloudflareClient,
  '@cf/meta/llama-3.1-8b-instruct'
);
```

```ts
// In aiStreamSSE's switch statement
switch (provider) {
  case 'github': streamGenerator = githubStreamGenerator(prompt, opts); break;
  case 'gemini': streamGenerator = geminiStreamGenerator(prompt, opts); break;
  case 'cohere': streamGenerator = cohereStreamGenerator(prompt, opts); break;
  case 'mistral': streamGenerator = mistralStreamGenerator(prompt, opts); break;
  case 'groq': streamGenerator = groqStreamGenerator(prompt, opts); break;
  case 'cerebras': streamGenerator = cerebrasStreamGenerator(prompt, opts); break;
  case 'nvidia': streamGenerator = nvidiaStreamGenerator(prompt, opts); break;
  case 'openrouter': streamGenerator = openrouterStreamGenerator(prompt, opts); break;
  case 'cloudflare': streamGenerator = cloudflareStreamGenerator(prompt, opts); break; // <-- new
}
```

---

## Phase 6 — Database migration + verification checklist

### 6a. Check `usage.provider` for a Postgres enum constraint

If `db/schema.ts` defines the `usage` table's `provider` column via Drizzle's
`pgEnum(...)` keyed off `AIChatProvider`, adding `'openrouter'` and
`'cloudflare'` to the TypeScript union **does not** update the Postgres enum
type — you'll get a runtime DB error on the first `incrementDailyUsageCount`
call for either provider.

Check for something like:

```ts
export const aiProviderEnum = pgEnum('ai_provider', [
  'github', 'gemini', 'cohere', 'mistral', 'groq', 'cerebras', 'nvidia'
]);
```

If it exists, generate a migration (`pnpm drizzle-kit generate`) or write one
manually:

```sql
ALTER TYPE "ai_provider" ADD VALUE IF NOT EXISTS 'openrouter';
ALTER TYPE "ai_provider" ADD VALUE IF NOT EXISTS 'cloudflare';
```

> `ALTER TYPE ... ADD VALUE` cannot run inside the same transaction as other
> schema changes in older Postgres versions — keep it as its own migration
> step if your migration runner batches statements transactionally.

If `usage.provider` is just a `text`/`varchar` column with no enum/check
constraint, you can skip this step entirely.

### 6b. End-to-end verification checklist

Run through these after Phases 1–5 are applied:

1. **Build check:** `pnpm build` (or `tsc --noEmit`) — should be clean with
   no leftover `Record<AIChatProvider, ...>` gaps.
2. **`canUseAIToday` gating (Phase 1):** temporarily set
   `AI_RATE_LIMITS.openrouter.rpd = 0` in a local override, call `aiPrompt`
   with a `modelSelection` that includes `openrouter` first, and confirm you
   see `[openrouter] ⚠️ Daily request limit reached, skipping` in the logs
   with **no** outbound HTTP request.
3. **`RateLimiter` concurrency (Phase 2):** fire 4–5 concurrent calls to
   `getGroqLimiter().throttle()` from a scratch script; confirm the resolve
   timestamps are spaced ~`delayMs` apart rather than clustered.
4. **OpenRouter non-streaming (Phase 4):** call `openrouterPrompt('Say hello
   in one sentence.')` directly. Confirm a 200 response, non-empty `output`,
   `usage` populated, and a new row in the `usage` table for
   `provider = 'openrouter'`.
5. **OpenRouter streaming (Phase 4):** call `aiStreamSSE` with a
   `modelSelection` of `{ openrouter: ['deepseek/deepseek-r1:free'] }` and
   confirm chunks arrive and `aiUsed` resolves to `{ provider: 'openrouter',
   model: '...' }`.
6. **OpenRouter JSON schema:** call with `outputAsJson: true` and a real
   `outputJsonStructure`. Some free model variants only honor
   `{ type: 'json_object' }` and ignore `json_schema` — if `parseAISafely`
   fails consistently for a given model, either switch to a different free
   model or drop `outputJsonStructure` for that provider (the factory already
   falls back to `json_object` when `outputJsonStructure` is absent, but a
   model *silently ignoring* `json_schema` while still returning 200 is a
   separate failure mode worth a manual check).
7. **Cloudflare non-streaming (Phase 5):** call `cloudflarePrompt('Say hello
   in one sentence.')`. Confirm both `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID` are picked up correctly — a 401/403 here usually
   means the token's scope doesn't include Workers AI, or the account ID is
   wrong.
8. **Cloudflare neuron budget:** after a handful of test calls, check the
   Neurons usage graph in the Cloudflare dashboard (Workers & Pages → AI) to
   confirm your `AI_RATE_LIMITS.cloudflare.rpd` estimate is realistic for the
   model you picked — adjust if the 8B model burns through neurons faster or
   slower than the ~150/day estimate.
9. **Full fallback chain:** with all real providers' API keys removed except
   `OPENROUTER_API_KEY` (or `CLOUDFLARE_API_TOKEN`), confirm `aiPrompt` still
   returns a successful result by falling all the way through to the new
   provider — proving it's correctly wired into the switch statements in
   both `ai-chat.ts` and `ai-chat-stream.ts`.

---

## Summary of files changed

- `types/ai-chat.ts` — extend `AIChatProvider` union (Phase 0)
- `ai-limiters.ts` — `RateLimiter` concurrency fix (Phase 2), new limiters
  for `openrouter`/`cloudflare` (Phases 4–5)
- `ai-chat.ts` — `canUseAIToday` gating (Phase 1), new
  `createOpenAICompatiblePrompt` factory + refactored `githubPrompt` (Phase
  3), new `openrouterPrompt`/`cloudflarePrompt` + switch cases (Phases 4–5)
- `ai-chat-stream.ts` — `canUseAIToday` gating (Phase 1), new
  `createOpenAICompatibleStreamGenerator` factory + refactored
  `githubStreamGenerator` (Phase 3), new stream generators + switch cases
  (Phases 4–5)
- `ai-clients.ts` — new `getOpenRouterClient`/`getCloudflareClient` +
  `AI_PROVIDER_API_KEYS` entries (Phases 4–5)
- `ai-clients.config.ts` — new `AI_RATE_LIMITS`/`AI_MAX_PROMPT_LENGTH`/model
  selection entries (Phases 4–5)
- `.env` — `OPENROUTER_API_KEY`, `CLOUDFLARE_API_TOKEN`,
  `CLOUDFLARE_ACCOUNT_ID` (Phases 4–5)
- `db/schema.ts` + migration — only if `usage.provider` is a Postgres enum
  (Phase 6)

No new pnpm packages for any of this — both new providers ride on the
`openai` package already in your dependencies.
