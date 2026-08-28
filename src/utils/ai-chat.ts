import type { AIChatProvider, AIDocument, AIJsonEvaluation, AIJsonProperty, AIPromptForJson, AIPromptOptions, AIResponse, AIModelSelection, NvidiaChatCompletionResponse, OpenRouterCreateParams, PromptWithFallbackOptions } from "../types/ai-chat.js";
import { AI_PROVIDER_API_KEYS, getCerebrasClient, getCloudflareClient, getCohereClient, getGeminiClient, getGroqClient, getInceptionClient, getMistralClient, getOpenRouterClient, getOvhcloudClient, getSambanovaClient, getOllamaClient, getModelscopeClient, getZaiClient, getSiliconflowClient, getAionlabsClient, getChutesClient, getLlm7Client } from "./ai-clients.js";
import { AI_CHAT_CONFIG_DEFAULT, EVALUATION_FALLBACK_LIMIT, EVALUATION_SCORING_OUTPUT_TOKEN, MAX_SCHEMA_LENGTH, NVIDIA_REQUEST_TIMEOUT_MS } from "../config/ai-chat.js";
import { AI_CHAT_MODELS_EVALUATION, AI_CHAT_MODELS_WRITING, AI_MAX_PROMPT_LENGTH, AI_MAX_OUTPUT_TOKEN, AI_STREAM_DEFAULT_MODEL } from "../config/ai-clients.js";
import { canUseAIToday, getRateLimiter, incrementDailyUsageCount } from './ai-limiters.js';
import { requireEnv } from "./env.js";
import { PROMPT_SYSTEM } from "./prompt.js";
import { logAISuccess, logAIFailure, logAIPrompt } from './ai-logger.js';
import { classifyGenAIError, isGenAIErrorRetryable } from "./error.js";
import { retryWithBackoff } from "./retry.js";
import { isCompleteFinishReason } from "./ai-chat-stream.js";
import { AI_CHAT_MODEL_RETRY_COUNT } from "../config/ai-chat.js";
import { parseAISafely } from "./ai-parser.js";
import { buildEvaluationSchemaDefinition, EVALUATION_REQUIRED_FIELDS } from "../schema/story.js";
import { edgeGroup } from './edge-group.js';
import { convertToGeminiSchema, getOrCreateGeminiCache } from "./gemini.js";
import type Groq from 'groq-sdk';
import type OpenAI from 'openai/resources/chat/completions.js';
import type OpenAIClient from 'openai';
import type Cerebras from "@cerebras/cerebras_cloud_sdk/resources/index.mjs";
import type { Cohere } from "cohere-ai";
import type { GenerateContentConfig, GenerateContentParameters, GenerateContentResponse } from "@google/genai";
import type { ProgressCallback } from "../types/sse.js";
import type { StoryGenerationStep } from "../types/book.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "@mistralai/mistralai/models/components";
import type * as GroqCompletion from "groq-sdk/resources/chat/completions.mjs";
import { isObjectLike } from "./parser.js";

/**
 * Base function for AI provider prompt handling with common patterns
 * 
 * @param provider - Provider name for logging and rate limiting
 * @param prompt - User prompt to send
 * @param options - Additional options including stop sequences, system prompt, exclude models, etc.
 * @param apiCall - Function that makes the actual API call
 * @param extractOutput - Function that extracts output from response
 * @param extractUsage - Function that extracts usage from response
 * @param extractFinishReason - Function that extracts finish reason from response
 * @returns AI response or null if all models fail
 */
async function promptWithFallback<T>(
  provider: AIChatProvider,
  prompt: string,
  options: PromptWithFallbackOptions = {},
  apiCall: (model: string, prompt: string, opts: PromptWithFallbackOptions) => Promise<T>,
  extractOutput: (response: T) => string | null,
  extractUsage: (response: T) => Record<string, string | number | undefined> | undefined,
  extractFinishReason: (response: T) => string
): Promise<AIResponse<string> | null> {
  // 1️⃣ Early validation: Check if API key is available for this provider
  if (!process.env[AI_PROVIDER_API_KEYS[provider]]) {
    console.warn(`[${provider}] ⚠️ API key not provided`);
    return null;
  }

  // 2️⃣ Model configuration: Get available models and apply exclusions
  const models = options.models;
  if (!models || models.length === 0) {
    console.warn(`[${provider}] ⚠️ No models configured`);
    return null;
  }

  // 3️⃣ Model iteration: Try each model in order until one succeeds
  for (let i = 0; i < models.length; i++) {
    const model = models[i];

    // 3a. Fallback limit: Check shared counter across all providers
    const fallbackCounter = options._fallbackCounter;
    if (fallbackCounter && options.fallbackLimit !== undefined && fallbackCounter.count >= options.fallbackLimit) {
      console.warn(`[${provider}] 🛑 Fallback limit (${options.fallbackLimit}) reached across providers, stopping`);
      break;
    }

    try {
      // Rate limiting: Apply throttling before making API call
      await getRateLimiter(provider).throttle();

      // Only respect logPrompts for the very first model index
      const modelOptions = i === 0 ? options : { ...options, logPrompts: false };
      
      // Track total duration
      const requestStartAt = Date.now();
      
      // Execute the actual request to the AI provider with retry for transient errors.
      // Non-retryable errors (invalid API key, bad request, etc.) are thrown immediately;
      // retryable ones (rate limited, service unavailable, etc.) retry with backoff.
      const response = await retryWithBackoff(
        () => apiCall(model, prompt, modelOptions),
        buildModelRetryConfig(provider, model),
      );
      
      // Response extraction: Get the output content from the response
      const output = extractOutput(response);
      
      // Success handling: Process valid response and return result
      if (output) {
        const rawUsage = extractUsage(response);
        const finishReason = extractFinishReason(response);
        const durationMs = Date.now() - requestStartAt;
        const aiResponse: AIResponse<string> = {
          provider,
          model,
          output,
          result: output,
          usage: rawUsage,
          durationMs,
          finishReason
        };

        // Extract numeric token values from the loosely-typed usage record
        const usage = rawUsage as Record<string, unknown> | undefined;
        const num = (v: unknown): number | undefined => typeof v === 'number' ? v : undefined;
        
        // Logging: Log successful AI response
        logAISuccess(aiResponse, requestStartAt);
        // Usage tracking: Increment daily usage counter with metrics
        await incrementDailyUsageCount(provider, options.context ?? 'ai-prompt', {
          model,
          inputTokens: num(usage?.promptTokens) ?? num(usage?.inputTokens),
          outputTokens: num(usage?.completionTokens) ?? num(usage?.outputTokens),
          totalTokens: num(usage?.totalTokens),
          cachedTokens: num(usage?.cachedTokens),
          durationMs,
        });
        return aiResponse;
      }

      // Empty response handling: Log when no content is received
      logAIFailure(provider, model, 'No output content received');
    } catch (error) {
      // Error handling: Classify error and decide on retry strategy.
      // Retryable errors were already retried by retryWithBackoff within the try block.
      const code = classifyGenAIError(provider, model, error);

      // SCHEMA_TOO_COMPLEX is a permanent failure — the schema itself is too large for
      // this provider's constrained decoder. No other model in the same provider will
      // succeed since they all receive the same schema. Break immediately.
      if (code === 'SCHEMA_TOO_COMPLEX') {
        console.warn(`[${provider}] 💢 Schema too complex for ${model} — schema structure exceeds provider limits, skipping remaining ${provider} models`);
        if (options._fallbackCounter) options._fallbackCounter.count++;
        break;
      }

      if (i < models.length - 1) {
        // Model fallback: Try next model if more are available
        console.warn(`[${provider}] 💥 Model ${model} failed (${isGenAIErrorRetryable(code) ? 'retries exhausted' : 'non-retryable'}), trying next model:`, code);
      } else {
        // Final failure: All models have been exhausted
        console.error(`[${provider}] ❌ All models failed:`, code);
      }
    }

    // Increment shared fallback counter after any model failure (empty output or error)
    if (options._fallbackCounter) options._fallbackCounter.count++;
  }

  // 4️⃣ Complete failure: Return null when all models fail
  return null;
}

/**
 * Returns the effective `max_tokens` / `maxTokens` value for a provider model.
 *
 * Provider-specific caps in `AI_MAX_OUTPUT_TOKEN` should always be honored when
 * building the request payload, even if the configured global `maxOutputToken`
 * is higher.
 *
 * @param provider - AI provider namespace
 * @param model - Exact model identifier
 * @param requested - Requested output token limit from config
 */
export function getMaxOutputToken(
  provider: AIChatProvider,
  model: string,
  requested: number
): number {
  const providerCaps = AI_MAX_OUTPUT_TOKEN[provider];
  const modelCap = providerCaps?.[model];
  return typeof modelCap === 'number' ? Math.min(requested, modelCap) : requested;
}

// ---------------------------------------------------------------------------
// Shared request-building helpers
//
// Every *Prompt function (this file) and *StreamGenerator (ai-chat-stream.ts)
// assembles the same handful of wire shapes — a two-message conversation, a
// JSON-schema fragment, a per-dialect response_format, and the OpenAI-style
// sampling block. These were previously re-inlined at ~70 call sites across
// both files (see TWISTLOOM_AI_DRY_OPPORTUNITIES.md for the full audit); the
// helpers below single-source each shape so a future change lands once, and
// so the two files structurally cannot drift the way Cohere's response-format
// shape and the streaming prompt-length gate already had.
// ---------------------------------------------------------------------------

/**
 * Builds the canonical two-message chat conversation used by every provider.
 *
 * Both the non-streaming `*Prompt` functions and the streaming
 * `*StreamGenerator`s send identical `[system, user]` arrays; this
 * single-sources that shape so a future change (e.g. adding an assistant
 * preamble) lands in exactly one place.
 *
 * @param systemPrompt - Pre-formatted system content (documents already
 *   embedded for non-RAG providers via {@link formatSystemPromptWithDocuments})
 * @param userPrompt - Raw user turn
 * @returns A typed, readonly chat message pair
 */
export function buildChatMessages(systemPrompt: string, userPrompt: string) {
  return [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: userPrompt },
  ];
}

/**
 * Builds the `type: 'object'` JSON-schema fragment shared by every provider's
 * structured-output dialect. Passing `additionalProperties: false` is the
 * strict-mode requirement for OpenAI/Cerebras/Groq and is easy to forget;
 * centralizing it removes that footgun.
 *
 * @param structure - Property map to require from the model
 * @param required - Property names the model must emit
 * @param opts - Controls; `omitAdditionalProperties` for dialects (e.g. Gemini
 *   Interactions) that reject the key
 * @returns A typed object schema, or `undefined` when `structure` is empty
 */
export function buildJsonSchemaObject(
  structure: Record<string, AIJsonProperty> | undefined,
  required: string[] | undefined,
  opts: { omitAdditionalProperties?: boolean } = {},
): AIJsonProperty | undefined {
  if (!structure) return undefined;
  return {
    type: "object",
    properties: structure,
    required,
    ...(opts.omitAdditionalProperties ? {} : { additionalProperties: false }),
  } as AIJsonProperty;
}

/**
 * OpenAI-compatible `response_format` — used by the OpenAI-compatible factory
 * (openrouter/cloudflare/inception + the 9 newer providers), groq, and
 * cerebras, in both the non-streaming and streaming paths.
 */
export function buildOpenAIResponseFormat(
  context: string | undefined,
  outputAsJson: boolean | undefined,
  outputJsonStructure: Record<string, AIJsonProperty> | undefined,
  outputJsonRequired: string[] | undefined,
) {
  return outputAsJson ? (outputJsonStructure ? {
    type: "json_schema" as const,
    json_schema: {
      name: context ?? "output-format",
      strict: true,
      schema: buildJsonSchemaObject(outputJsonStructure, outputJsonRequired),
    },
  } : { type: 'json_object' as const }) : undefined;
}

/**
 * Mistral dialect — identical to OpenAI except the property is named
 * `schemaDefinition`.
 */
export function buildMistralResponseFormat(
  options: Pick<PromptWithFallbackOptions, 'context' | 'outputAsJson' | 'outputJsonStructure' | 'outputJsonRequired'>,
) {
  const { context, outputAsJson, outputJsonStructure, outputJsonRequired } = options;
  return outputAsJson ? (outputJsonStructure ? {
    type: "json_schema",
    jsonSchema: {
      name: context ?? "output-format",
      strict: true,
      schemaDefinition: buildJsonSchemaObject(outputJsonStructure, outputJsonRequired),
    },
  } : { type: 'json_object' }) : undefined;
}

/**
 * Cohere `responseFormat`.
 *
 * Used by the non-streaming `coherePrompt` and streaming `cohereStreamGenerator`
 * 
 * Cohere's own docs (see below) describe `json_schema` as the raw JSON
 * Schema object itself, provided directly — no `name`/`strict`/`schema`
 * wrapper exists in Cohere's actual contract at all (that wrapper shape is
 * OpenAI/Mistral's convention, not Cohere's — the two APIs just happen to
 * both call the field `json_schema`).
 * 
 * @see https://docs.cohere.com/reference/chat
 * @see https://docs.cohere.com/v2/docs/structured-outputs
 * 
 * Note:
 * `context` is accepted (matching the other three `build*ResponseFormat`
 * signatures for interchangeability) but genuinely unused here — Cohere's
 * raw-schema shape has no `name` field to put it in.
 */
export function buildCohereResponseFormat(
  options: Pick<PromptWithFallbackOptions, 'context' | 'outputAsJson' | 'outputJsonStructure' | 'outputJsonRequired'>,
) {
  const { outputAsJson, outputJsonStructure, outputJsonRequired } = options;
  return outputAsJson ? {
    type: "json_object",
    jsonSchema: outputJsonStructure ? buildJsonSchemaObject(outputJsonStructure, outputJsonRequired) : undefined
  } satisfies Cohere.ResponseFormatV2 : undefined;
}

/**
 * Gemini `generateContent`'s `responseJsonSchema` — the only dialect that
 * carries an empty-object fallback instead of `undefined`, because Gemini
 * still emits an object schema when output is JSON but no structure is
 * supplied.
 */
export function buildGeminiResponseJsonSchema(
  outputAsJson: boolean | undefined,
  outputJsonStructure: Record<string, AIJsonProperty> | undefined,
  outputJsonRequired: string[] | undefined,
): AIJsonProperty | undefined {
  return outputAsJson ? {
    type: "object",
    ...(outputJsonStructure
      ? buildJsonSchemaObject(outputJsonStructure, outputJsonRequired)
      : {}),
  } : undefined;
}

/**
 * Maps the shared {@link AIChatConfig} sampling fields onto the
 * OpenAI-compatible wire shape (`max_tokens`/`temperature`/`top_p`/`stop`/
 * `frequency_penalty`/`seed`). Keeps {@link getMaxOutputToken} as the single
 * cap clamp while removing the per-provider destructure that previously
 * invited drift (groq/cerebras/nvidia each re-declared the same six fields).
 *
 * Cohere (`p`/`k`/`maxTokens`) and Mistral (`topP`/`randomSeed`/`maxTokens`)
 * use different field names and are deliberately NOT routed through this
 * helper — see {@link coherePrompt} and {@link mistralPrompt}.
 *
 * @param provider - Provider namespace (feeds `getMaxOutputToken`)
 * @param model - Exact model id (feeds `getMaxOutputToken`)
 * @param config - Resolved generation config
 */
export function buildSamplingParams(
  provider: AIChatProvider,
  model: string,
  config: PromptWithFallbackOptions['config'] & object,
) {
  return {
    max_tokens: getMaxOutputToken(provider, model, config.maxOutputToken),
    temperature: config.temperature,
    top_p: config.topP,
    stop: config.stopSequences,
    frequency_penalty: config.frequencyPenalty,
    seed: config.seed,
  };
}

/**
 * Resolves Gemini's explicit cache boundary (mirrors Mistral's
 * `promptCacheKey`, see {@link buildMistralPromptCacheKey}).
 *
 * Single-sources the minimum-token cache seeding that both the non-streaming
 * and streaming `generateContent` paths must perform: formatting documents
 * and calling {@link getOrCreateGeminiCache} with the same key, model, system
 * prompt and bookId. Shared across ai-chat.ts and ai-chat-stream.ts so the two
 * pathways cannot drift apart on this safety-sensitive logic.
 *
 * @param options - Prompt options (reads `cachedContentId`, `systemPrompt`,
 *   `documents`, `meta`)
 * @param model - The exact model being called
 * @returns The cached content string, or `null` when no `cachedContentId`
 */
export async function resolveGeminiCachedContent(
  options: Pick<PromptWithFallbackOptions, 'cachedContentId' | 'systemPrompt' | 'documents' | 'meta'>,
  model: string,
): Promise<string | null> {
  const { cachedContentId, systemPrompt = PROMPT_SYSTEM, documents, meta } = options;
  if (!cachedContentId) return null;
  const formattedDocuments = formatDocumentsToPrompt(documents);
  return getOrCreateGeminiCache(cachedContentId, model, systemPrompt, formattedDocuments, meta?.bookId);
}

/**
 * Strips the config keys the Gemini SDK rejects (`frequencyPenalty`) and
 * separates `maxOutputToken` so the caller can re-clamp via
 * {@link getMaxOutputToken}. Shared by the non-streaming and streaming
 * `generateContent` paths so the compensation logic is identical.
 *
 * @param config - Full resolved generation config
 * @returns The Gemini-safe remainder and the requested cap
 */
export function buildGeminiConfig<C extends { frequencyPenalty?: number; maxOutputToken: number }>(
  config: C,
): { geminiConfig: Omit<C, 'frequencyPenalty' | 'maxOutputToken'>; maxOutputToken: number } {
  const { frequencyPenalty: _fp, maxOutputToken, ...geminiConfig } = config;
  return { geminiConfig, maxOutputToken };
}

/**
 * Builds the Mistral prompt-cache key, mirroring Gemini's `cachedContentId`
 * so both caches bust on the same content change (characters/places). Falls
 * back to a shared key for callers without a `cachedContentId` (pen.ts,
 * canon-validation.ts, etc.).
 *
 * @param cachedContentId - Optional content identity (shared with Gemini)
 * @returns The `promptCacheKey` value to send to Mistral
 */
export function buildMistralPromptCacheKey(cachedContentId?: string): string {
  return cachedContentId
    ? `twistloom:mistral:${cachedContentId}`
    : 'twistloom:mistral:shared';
}

/**
 * Resolves the model a streaming generator should use when the caller didn't
 * pass `options.models`. Centralizing this fallback (previously repeated
 * verbatim in all 9 stream generators) means a typo'd or removed
 * `AI_STREAM_DEFAULT_MODEL` entry fails loudly at this one call site instead
 * of silently per-generator.
 */
export function resolveStreamDefaultModel(
  provider: AIChatProvider,
  options: Partial<PromptWithFallbackOptions>,
): string {
  return options.models?.[0] || AI_STREAM_DEFAULT_MODEL[provider];
}

/**
 * Sums the character length of all provided documents. Hidden whitespace or a
 * future content field should be reflected here once — this previously had
 * two independently-hand-rolled, numerically-equivalent-but-structurally-
 * divergent copies (ai-chat.ts used `` `${title}${snippet}`.length ``,
 * ai-chat-stream.ts used `title.length + snippet.length`).
 *
 * @param documents - Optional list of AI documents
 * @returns Total chars (0 when none)
 */
export function sumDocumentChars(documents?: AIDocument[]): number {
  return documents?.reduce(
    (sum, doc) => sum + `${doc.title ?? ''}${doc.snippet}`.length,
    0,
  ) ?? 0;
}

/**
 * Returns whether a provider can accept a request: the resolved prompt
 * length — **including documents** — is within `AI_MAX_PROMPT_LENGTH`, and
 * the daily quota (`canUseAIToday`) is not exhausted.
 *
 * BUG FIX: the streaming orchestrator (`aiStreamSSE`) previously measured
 * only `systemPrompt.length + prompt.length` for this gate, omitting
 * documents entirely — while its own telemetry a few lines later *did* count
 * them. A request with sizeable `documents` could pass the gate for a
 * provider whose true total (with documents) exceeded `AI_MAX_PROMPT_LENGTH`,
 * only to fail against the provider's own limit. This helper is now the only
 * place either orchestrator measures prompt length, so the two can't
 * re-diverge.
 *
 * @param provider - Provider to check
 * @param systemPrompt - Resolved system prompt (documents embedded for
 *   non-RAG providers, per {@link formatSystemPromptWithDocuments} — pass the
 *   *original* prompt here and `documents` separately; this function adds
 *   them itself so RAG providers like Cohere, which never embed documents
 *   into the system prompt, are measured consistently too)
 * @param prompt - User prompt
 * @param documents - Optional documents (RAG or embedded)
 */
export async function assertPromptAllowed(
  provider: AIChatProvider,
  systemPrompt: string,
  prompt: string,
  documents: AIDocument[] | undefined,
): Promise<{ allowed: boolean; reason?: string }> {
  const totalPromptLength = systemPrompt.length + prompt.length + sumDocumentChars(documents);
  const maxPromptLength = AI_MAX_PROMPT_LENGTH[provider];
  if (totalPromptLength > maxPromptLength) {
    return { allowed: false, reason: `Prompt length (${totalPromptLength.toLocaleString()} chars) exceeds limit (${maxPromptLength.toLocaleString()} chars), skipping` };
  }
  if (!(await canUseAIToday(provider))) {
    return { allowed: false, reason: 'Daily request limit reached, skipping' };
  }
  return { allowed: true };
}

/**
 * Builds the shared `retryWithBackoff` options object used by both
 * `promptWithFallback` (below) and the streaming orchestrator's connection
 * handshake, so the retry policy and its log line can't drift between the
 * two.
 */
export function buildModelRetryConfig(provider: AIChatProvider, model: string) {
  return {
    maxRetries: AI_CHAT_MODEL_RETRY_COUNT,
    shouldRetry: (err: unknown) => isGenAIErrorRetryable(classifyGenAIError(provider, model, err)),
    onRetry: (attempt: number, err: unknown) => {
      console.warn(`[${provider}] 🔄 Retry ${attempt}/${AI_CHAT_MODEL_RETRY_COUNT} for model ${model}: ${classifyGenAIError(provider, model, err)}`);
    },
  };
}

/**
 * Reads a streamed OpenAI-compatible delta's text content, handling both the
 * common `string` shape and the rarer `ContentChunk[]` shape (currently only
 * observed from Mistral). Centralizes what was previously 4 near-identical
 * inline reads (openrouter-family factory, groq, cerebras, and a bespoke
 * Mistral copy).
 */
export function extractDeltaText(chunk: { choices?: Array<{ delta?: { content?: unknown } }> | null }): string {
  const delta = chunk.choices?.[0]?.delta?.content;
  if (typeof delta === 'string') return delta;
  if (Array.isArray(delta)) return delta.map((d) => typeof d === 'string' ? d : '').join('');
  return '';
}

/**
 * NVIDIA's raw-fetch request boilerplate, shared by {@link nvidiaPrompt} and
 * `nvidiaStreamGenerator` (ai-chat-stream.ts): API key lookup, the
 * `integrate.api.nvidia.com` URL, auth header, timeout-signal composition,
 * and the non-2xx error path.
 *
 * Returns the composed `signal` alongside the `response` — the streaming
 * caller needs it to check `.aborted` on each read-loop iteration (matching
 * its pre-refactor behavior exactly); the non-streaming caller ignores it.
 *
 * BUG FIX, not just consolidation: the streaming path already composed
 * `AbortSignal.any([signal, timeoutSignal])` with a
 * {@link NVIDIA_REQUEST_TIMEOUT_MS} ceiling; the non-streaming `nvidiaPrompt`
 * had neither a timeout nor any `signal` support at all, so a hung NVIDIA
 * request could only ever be ended by `promptWithFallback`'s own retry logic
 * kicking in — not by the caller's own cancellation. Both paths now share the
 * same timeout + cancellation composition.
 */
export async function nvidiaChatRequest(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ response: Response; signal: AbortSignal }> {
  const apiKey = requireEnv('NVIDIA_API_KEY');
  const timeoutSignal = AbortSignal.timeout(NVIDIA_REQUEST_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(`https://integrate.api.nvidia.com/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: combinedSignal,
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`HTTP ${response.status}: ${errorText}`);
  }
  return { response, signal: combinedSignal };
}

/**
 * Cohere V2 RAG `documents` mapping — each document becomes a `{ data }`
 * item per Cohere's native-RAG contract.
 */
export function mapCohereDocuments(documents?: AIDocument[]): Cohere.V2ChatRequestDocumentsItem[] | undefined {
  return documents && documents.length > 0
    ? documents.map((data) => ({ data }))
    : undefined;
}

/**
 * Creates a prompt function for any OpenAI Chat Completions–compatible provider.
 *
 * Every currently-wired OpenAI-compatible provider is a one-line call to this
 * factory: {@link openrouterPrompt}, {@link cloudflarePrompt},
 * {@link inceptionPrompt}, and the 9 providers wired 2026-08-13
 * ({@link ovhcloudPrompt}, {@link sambanovaPrompt}, {@link ollamaPrompt},
 * {@link modelscopePrompt}, {@link zaiPrompt}, {@link siliconflowPrompt},
 * {@link aionlabsPrompt}, {@link chutesPrompt}, {@link llm7Prompt}). GitHub
 * Models was the 4th (also OpenAI-compatible) provider that used to be
 * defined here — it was removed after GitHub Models' full retirement on
 * 2026-07-30, which is also why this doc comment no longer names it as the
 * canonical example the way it used to.
 *
 * @param provider - Provider name for logging, rate limiting, and config lookups
 * @param getClient - Singleton client getter (e.g. {@link getOpenRouterClient})
 * @returns A prompt function with the standard `(prompt, options) => Promise<AIResponse<string> | null>` signature
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
        const createParams: OpenRouterCreateParams = {
          model,
          messages: buildChatMessages(systemPromptWithDocuments, prompt),
          stream: false,
          ...buildSamplingParams(provider, model, config),
          response_format: buildOpenAIResponseFormat(context, outputAsJson, outputJsonStructure, outputJsonRequired),
          plugins: provider === 'openrouter' ? [
            { id: 'response-healing' } // Prevent "qwen/qwen3-30b-a3b" token leak
          ] : undefined,
        };
        return await getClient().chat.completions.create(createParams);
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

/**
 * @see structured JSON guide - https://developers.openai.com/api/docs/guides/structured-outputs
 */
export const openrouterPrompt = createOpenAICompatiblePrompt('openrouter', getOpenRouterClient);
export const cloudflarePrompt = createOpenAICompatiblePrompt('cloudflare', getCloudflareClient);
export const inceptionPrompt = createOpenAICompatiblePrompt('inception', getInceptionClient);

/**
 * Providers wired 2026-08-13. All 9 are OpenAI Chat Completions–compatible —
 * confirmed against each provider's own docs during the capacity review — so
 * each is a one-line {@link createOpenAICompatiblePrompt} call, identical in
 * shape to the three above. See AI_ORCHESTRATION_ARCHITECTURE.md §17 for the
 * prerequisite client-getter/limiter wiring this assumes exists in
 * `src/utils/ai-clients.ts` and `src/utils/ai-limiters.ts`.
 *
 * `getChutesClient()` specifically: configure its `baseURL` as
 * `https://llm.chutes.ai/v1` (NOT including `/chat/completions` — the OpenAI
 * SDK appends that itself; the base URL Chutes publishes in its own docs
 * already includes the full path, which would double up if pasted as-is).
 */
export const ovhcloudPrompt = createOpenAICompatiblePrompt('ovhcloud', getOvhcloudClient);
export const sambanovaPrompt = createOpenAICompatiblePrompt('sambanova', getSambanovaClient);
export const ollamaPrompt = createOpenAICompatiblePrompt('ollama', getOllamaClient);
export const modelscopePrompt = createOpenAICompatiblePrompt('modelscope', getModelscopeClient);
export const zaiPrompt = createOpenAICompatiblePrompt('zai', getZaiClient);
export const siliconflowPrompt = createOpenAICompatiblePrompt('siliconflow', getSiliconflowClient);
export const aionlabsPrompt = createOpenAICompatiblePrompt('aionlabs', getAionlabsClient);
export const chutesPrompt = createOpenAICompatiblePrompt('chutes', getChutesClient);
export const llm7Prompt = createOpenAICompatiblePrompt('llm7', getLlm7Client);

/**
 * Sends a prompt to Google Gemini via the `generateContent` API and returns structured output.
 *
 * Tries each model in {@link AI_CHAT_MODELS_WRITING.gemini} in order; throttles via {@link geminiLimiter}
 * before each call; respects safety blocks and finish reasons like other chat providers.
 *
 * Kept alongside {@link geminiPromptViaInteractions} specifically for its explicit-caching support
 * (`cachedContentId` → {@link getOrCreateGeminiCache} → `cachedContent`) — the Interactions API does
 * not support explicit caching as of 2026-08-12 (confirmed against
 * https://ai.google.dev/gemini-api/docs/interactions-overview#limitations). {@link geminiPrompt} below
 * dispatches to this function whenever `cachedContentId` is set.
 *
 * @param prompt - User portion of the prompt (system rules are concatenated in the request body)
 * @param options.stopSequences - Optional stop sequences (e.g. `['\\n\\n']` for non–Q&A summarization)
 * @returns {@link AIResponse} or `null` if every model fails
 */
async function geminiPromptViaGenerateContent(
  prompt: string,
  options?: Partial<PromptWithFallbackOptions>
): Promise<AIResponse<string> | null> {
  return promptWithFallback<GenerateContentResponse>(
    'gemini',
    prompt,
    options,
    async (model, prompt, opts) => {
      const { config = AI_CHAT_CONFIG_DEFAULT, outputAsJson, outputJsonStructure, outputJsonRequired } = opts;
      const systemPromptWithDocuments = formatSystemPromptWithDocuments('gemini', opts);
      const responseJsonSchema = buildGeminiResponseJsonSchema(outputAsJson, outputJsonStructure, outputJsonRequired);

      // Helper block to fulfill Gemini's minimum token requirement for explicit caching
      const cachedContent = await resolveGeminiCachedContent(opts, model);

      // Penalty is not enabled for models/gemini-2.5-flash
      const { geminiConfig, maxOutputToken } = buildGeminiConfig(config);

      const params: GenerateContentParameters = {
        model,
        contents: [{ parts: [{ text: prompt }] }],
        config: {
          ...geminiConfig,
          ...(outputAsJson ? { responseMimeType: 'application/json' } : {}),
          maxOutputTokens: getMaxOutputToken('gemini', model, maxOutputToken),
          responseSchema: responseJsonSchema ? convertToGeminiSchema(responseJsonSchema, { minify: true }) : undefined,
          // responseJsonSchema,
          // Cache hit — send only the dynamic prompt
          ...(cachedContent ? { cachedContent } : {
            // Cache miss or unnecessary — do full request (Gemini caches this automatically)
            systemInstruction: { parts: [{ text: systemPromptWithDocuments }] },
          })
        } satisfies GenerateContentConfig,
      };

      const paramsString = JSON.stringify(params, null, 2);
      edgeGroup.wrap(`[geminiPrompt] 📝 Generate content params for ${model} (${isObjectLike(paramsString) ? 'OK' : 'CORRUPT'}, ${paramsString.length} chars):`, async () => {
        console.log(paramsString);
      });

      const response = await getGeminiClient().models.generateContent(params);

      // Prompt-level safety block
      if (response.promptFeedback?.blockReason) {
        throw new Error(`Prompt blocked: ${response.promptFeedback.blockReason}`);
      }

      return response;
    },
    (response) => {
      const candidates = response.candidates ?? [];
      if (candidates.length === 0) {
        console.warn('[gemini] ❓ No candidates in response');
        return null;
      }

      // Pick FIRST acceptable candidate only
      for (const candidate of candidates) {
        // Must be fully completed; reject unsafe or incomplete output
        if (candidate.finishReason !== 'STOP') continue;

        const parts = candidate.content?.parts ?? [];
        if (!Array.isArray(parts) || parts.length === 0) continue;

        const text = parts
          .filter((p) => typeof p?.text === 'string')
          .map((p) => p.text)
          .join('')
          .trim();

        if (!text) continue;
        return text;
      }

      console.warn('[gemini] ❓ No valid candidate contents');
      return null;
    },
    (response) => {
      const { usageMetadata } = response;
      if (!usageMetadata) {
        console.warn('[gemini] ❓ No usage data in response');
        return undefined;
      }

      const cachedTokens = usageMetadata.cachedContentTokenCount;
      const promptTokens = usageMetadata.promptTokenCount;
      const outputTokens = usageMetadata.candidatesTokenCount;
      const totalTokens = usageMetadata.totalTokenCount;
      const cacheHitRate = promptTokens && cachedTokens ? cachedTokens / promptTokens : 0;

      return {
        cachedTokens,
        promptTokens,
        outputTokens,
        totalTokens,
        cacheHitRate,
      };
    },
    (response) => response.candidates?.[0]?.finishReason ?? 'unknown'
  );
}

/**
 * Minimal local shape for the fields this file actually reads off an
 * Interactions API response/resource. Declared locally instead of imported
 * from `@google/genai` because the SDK's exact exported type name for this
 * resource wasn't confirmed against the currently-installed SDK version —
 * the Interactions API needs `@google/genai` >= 2.3.0 (per
 * https://ai.google.dev/gemini-api/docs/interactions-overview#sdks); check
 * `node_modules/@google/genai/package.json` and swap this for the real SDK
 * type once you've confirmed it exports one. Field names/shapes below are
 * sourced directly from https://ai.google.dev/api/interactions-api (fetched
 * 2026-08-12) — re-verify against the OpenAPI spec linked from that page if
 * behavior looks off, since this is a beta (`v1beta`) endpoint.
 */
interface GeminiInteractionUsage {
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_cached_tokens?: number;
  total_tokens?: number;
}
interface GeminiInteractionContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}
interface GeminiInteractionStep {
  type: string;
  content?: GeminiInteractionContentBlock[];
  [key: string]: unknown;
}
interface GeminiInteractionResponse {
  id: string;
  status: 'completed' | 'failed' | 'cancelled' | 'incomplete' | 'budget_exceeded' | 'requires_action' | 'in_progress' | 'queued';
  steps?: GeminiInteractionStep[];
  usage?: GeminiInteractionUsage;
  /** SDK convenience property — joins consecutive trailing text blocks. Falls back to a manual `steps` scan below if an older SDK version doesn't populate it. */
  output_text?: string;
}

/**
 * Sends a prompt to Google Gemini via the Interactions API
 * (https://ai.google.dev/gemini-api/docs/interactions-overview) — GA since
 * June 2026 and where Google says all new models/features will land first.
 *
 * NOT wired into the exported {@link geminiPrompt} dispatcher by default.
 * Two things couldn't be confirmed from Google's own docs as of 2026-08-12,
 * and you should verify both empirically before routing real traffic here:
 *
 * 1. **Temperature / top_p / top_k**: not listed in the documented
 *    `generation_config` schema (only `max_output_tokens`, `seed`,
 *    `stop_sequences`, `thinking_level`, `thinking_summaries`, `tool_choice`
 *    are). If genuinely unsupported, you lose prose-variety control versus
 *    the current `generateContent` path — a real regression for fiction
 *    generation, not a cosmetic one.
 * 2. **Safety settings**: the API reference documents a full
 *    `safety_settings` array (with `block_none`/`off` thresholds — exactly
 *    what you'd want for dark/mature horror content), but the Interactions
 *    API overview page's own "Limitations" section states custom safety
 *    settings are "not supported." These two official pages contradict each
 *    other. Test directly (send a request with `safety_settings: [{ type:
 *    'dangerous_content', threshold: 'block_none' }]` against genuinely dark
 *    content and see whether it actually changes blocking behavior) before
 *    trusting either page.
 *
 * Also does not support explicit caching (see {@link geminiPromptViaGenerateContent}'s
 * doc comment) — this function always passes `store: false` since there's no
 * conversation continuity need for Twistloom's single-shot generation calls,
 * and no reason to pay for interaction storage/retention you won't use.
 *
 * @param prompt - User portion of the prompt (system rules are concatenated into `system_instruction`)
 * @returns {@link AIResponse} or `null` if every model fails
 */
export async function geminiPromptViaInteractions(
  prompt: string,
  options?: Partial<PromptWithFallbackOptions>
): Promise<AIResponse<string> | null> {
  return promptWithFallback<GeminiInteractionResponse>(
    'gemini',
    prompt,
    options,
    async (model, prompt, opts) => {
      const { config = AI_CHAT_CONFIG_DEFAULT, outputAsJson, outputJsonStructure, outputJsonRequired } = opts;
      const systemPromptWithDocuments = formatSystemPromptWithDocuments('gemini', opts);

      // The SDK's exact param type name for this call wasn't confirmed (see
      // the GeminiInteractionResponse comment above) — cast through `any` at
      // the call boundary only; everything downstream of the response is
      // fully typed against GeminiInteractionResponse.
      const response = await (getGeminiClient() as any).interactions.create({
        model,
        input: prompt,
        system_instruction: systemPromptWithDocuments,
        store: false,
        response_format: outputAsJson ? [{
          type: 'text',
          mime_type: 'application/json',
          ...(outputJsonStructure ? {
            schema: buildJsonSchemaObject(outputJsonStructure, outputJsonRequired, { omitAdditionalProperties: true }),
          } : {}),
        }] : undefined,
        generation_config: {
          max_output_tokens: getMaxOutputToken('gemini', model, config.maxOutputToken),
          stop_sequences: config.stopSequences,
          seed: config.seed,
          // temperature / top_p / top_k intentionally omitted — see the
          // doc-gap warning above. Re-add once confirmed supported.
        },
      }) as GeminiInteractionResponse;

      if (response.status === 'failed' || response.status === 'cancelled' || response.status === 'budget_exceeded') {
        throw new Error(`[gemini/interactions] Interaction ${response.status} (id: ${response.id})`);
      }

      return response;
    },
    (response) => {
      if (response.status !== 'completed') {
        console.warn(`[gemini] ❓ Interaction status "${response.status}", not completed`);
        return null;
      }

      if (response.output_text) return response.output_text.trim() || null;

      // Manual fallback: find the model_output step and join its text blocks.
      const outputStep = response.steps?.find((s) => s.type === 'model_output');
      const text = outputStep?.content
        ?.filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('')
        .trim();
      return text || null;
    },
    (response) => {
      const { usage } = response;
      if (!usage) {
        console.warn('[gemini] ❓ No usage data in interaction response');
        return undefined;
      }

      const cachedTokens = usage.total_cached_tokens;
      const promptTokens = usage.total_input_tokens;
      const outputTokens = usage.total_output_tokens;
      const totalTokens = usage.total_tokens;
      const cacheHitRate = promptTokens && cachedTokens ? cachedTokens / promptTokens : 0;

      return { cachedTokens, promptTokens, outputTokens, totalTokens, cacheHitRate };
    },
    (response) => response.status ?? 'unknown'
  );
}

/**
 * Sends a prompt to Google Gemini and returns structured output.
 *
 * Dispatches between two implementations:
 * - `options.cachedContentId` set → {@link geminiPromptViaGenerateContent}
 *   (the original, unchanged `generateContent` path) — kept because the
 *   Interactions API doesn't yet support explicit caching.
 * - Otherwise → still {@link geminiPromptViaGenerateContent} for now.
 *
 * {@link geminiPromptViaInteractions} is fully implemented and exported
 * separately, but deliberately **not** called from here yet — see its doc
 * comment for the two unconfirmed behaviors (temperature/top_p/top_k support,
 * and contradictory safety-settings documentation) worth verifying before
 * this dispatcher routes real traffic to it. Once confirmed, the second
 * branch below is a one-line change.
 *
 * @param prompt - User portion of the prompt (system rules are concatenated in the request body)
 * @param options.stopSequences - Optional stop sequences (e.g. `['\\n\\n']` for non–Q&A summarization)
 * @returns {@link AIResponse} or `null` if every model fails
 */
export async function geminiPrompt(
  prompt: string,
  options?: Partial<PromptWithFallbackOptions>
): Promise<AIResponse<string> | null> {
  return geminiPromptViaGenerateContent(prompt, options);
}

/**
 * Groq AI chat completion (30 RPM)
 *
 * Sends a chat completion request to Groq AI with proper rate limiting,
 * error handling, and model fallback support. Iterates through available models
 * until successful response or all models exhausted.
 *
 * @param prompt - The user prompt to send to the AI
 * @param options - Additional options including configurations, system prompt, models, etc.
 * @returns Normalized AI response with provider, model, output, usage, and finish reason,
 *          or null if all models fail
 * 
 * @see structured JSON guide - https://console.groq.com/docs/structured-outputs
 * 
 * @example
 * ```typescript
 * const response = await groqPrompt('Generate a story about psychological horror');
 * if (response) {
 *   console.log(`Provider: ${response.provider}, Model: ${response.model}`);
 *   console.log(`Story: ${response.output}`);
 * }
 * ```
 */
export async function groqPrompt(
  prompt: string,
  options?: Partial<PromptWithFallbackOptions>
): Promise<AIResponse<string> | null> {
  return promptWithFallback<Groq.Chat.Completions.ChatCompletion>(
    'groq',
    prompt,
    options,
    async (model, prompt, opts) => {
      const { config = AI_CHAT_CONFIG_DEFAULT, context, outputAsJson, outputJsonStructure, outputJsonRequired } = opts;
      const systemPromptWithDocuments = formatSystemPromptWithDocuments('groq', opts);

      const { data, response } = await getGroqClient().chat.completions.create({
        messages: buildChatMessages(systemPromptWithDocuments, prompt),
        model,
        stream: false,
        ...buildSamplingParams('groq', model, config),
        response_format: buildOpenAIResponseFormat(context, outputAsJson, outputJsonStructure, outputJsonRequired),
      } satisfies GroqCompletion.ChatCompletionCreateParamsNonStreaming).withResponse();

      // Log rate limit information from response headers
      const remaining = response.headers.get('x-ratelimit-remaining-requests');
      const limit = response.headers.get('x-ratelimit-limit-requests');
      const resetTime = response.headers.get('x-ratelimit-reset-requests');
      if (remaining || limit || resetTime) {
        console.log(`[groq] 📊 Remaining requests: ${remaining}/${limit} (resets in: ${resetTime})`);
      }

      return data;
    },
    (response) => {
      const content = response.choices[0]?.message?.content;
      if (!content) {
        console.warn('[groq] ❓ No content in response');
        return null;
      }
      return content.trim();
    },
    (response) => {
      const { usage } = response;
      if (!usage) {
        console.warn('[groq] ❓ No usage data in response');
        return undefined;
      }

      const promptTokens = usage.prompt_tokens;
      const completionTokens = usage.completion_tokens;
      const totalTokens = usage.total_tokens;
      const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
      const cacheHitRate = promptTokens && cachedTokens ? cachedTokens / promptTokens : 0;

      return {
        promptTokens,
        completionTokens,
        totalTokens,
        cachedTokens,
        cacheHitRate
      };
    },
    (response) => response.choices?.[0]?.finish_reason ?? 'unknown'
  );
}

/**
 * Cohere AI chat completion (100 RPM)
 *
 * Sends a chat completion request to Cohere AI with proper rate limiting,
 * error handling, and model fallback support. Iterates through available models
 * until successful response or all models exhausted.
 *
 * @param prompt - The user prompt to send to the AI
 * @param options - Additional options including configurations, system prompt, models, etc.
 * @returns Normalized AI response with provider, model, output, usage, and finish reason,
 *          or null if all models fail
 *
 * @example
 * ```typescript
 * const response = await coherePrompt('Analyze this text for emotional themes');
 * if (response) {
 *   console.log(`Provider: ${response.provider}, Model: ${response.model}`);
 *   console.log(`Analysis: ${response.output}`);
 * }
 * ```
 */
export async function coherePrompt(
  prompt: string,
  options?: Partial<PromptWithFallbackOptions>
): Promise<AIResponse<string> | null> {
  return promptWithFallback<Cohere.V2ChatResponse>(
    'cohere',
    prompt,
    options,
    async (model, prompt, opts) => {
      const { documents, context, config = AI_CHAT_CONFIG_DEFAULT, outputAsJson, outputJsonStructure, outputJsonRequired } = opts;
      return await getCohereClient().chat({
        model,
        messages: buildChatMessages(formatSystemPromptWithDocuments('cohere', opts), prompt),
        documents: mapCohereDocuments(documents),
        maxTokens: getMaxOutputToken('cohere', model, config.maxOutputToken),
        temperature: config.temperature,
        p: config.topP,
        k: config.topK,
        stopSequences: config.stopSequences,
        frequencyPenalty: config.frequencyPenalty,
        seed: config.seed,
        responseFormat: buildCohereResponseFormat({ context, outputAsJson, outputJsonStructure, outputJsonRequired }) as Cohere.ResponseFormatV2 | undefined,
      } satisfies Cohere.V2ChatRequest);
    },
    (response) => {
      const { message } = response;
      const contentText = message?.content?.[0]?.type === 'text' ? message.content[0].text : null;
      const text = message?.content
        ?.find((item): item is { type: 'text'; text: string } => item.type === 'text')
        ?.text ?? contentText;
      if (!text) {
        console.warn('[cohere] ❓ No text in response');
        return null;
      }
      return text;
    },
    (response) => {
      const { usage } = response;
      if (!usage) {
        console.warn('[cohere] ❓ No usage data in response');
        return undefined;
      }
      return {
        inputTokens: usage.tokens?.inputTokens,
        outputTokens: usage.tokens?.outputTokens,
        cachedTokens: usage.cachedTokens,
        billedInputTokens: usage.billedUnits?.inputTokens,
        billedOutputTokens: usage.billedUnits?.outputTokens,
      };
    },
    (response) => response.finishReason
  );
}

/** Cerebras AI chat completion (30 RPM / 14,400 RPD)
 *
 * Sends a chat completion request to Cerebras AI with proper rate limiting,
 * error handling, and model fallback support. Iterates through available models
 * until successful response or all models exhausted.
 *
 * @param prompt - The user prompt to send to the AI
 * @param options - Additional options including configurations, system prompt, models, etc.
 * @returns Normalized AI response with provider, model, output, usage, and finish reason,
 *          or null if all models fail
 *
 * @example
 * ```typescript
 * const response = await cerebrasPrompt('Summarize this article about Islamic finance');
 * if (response) {
 *   console.log(`Provider: ${response.provider}, Model: ${response.model}`);
 *   console.log(`Summary: ${response.output}`);
 * }
 * ```
 */
export async function cerebrasPrompt(
  prompt: string,
  options?: Partial<PromptWithFallbackOptions>
): Promise<AIResponse<string> | null> {
  return promptWithFallback<Cerebras.ChatCompletion.ChatCompletionResponse>(
    'cerebras',
    prompt,
    options,
    async (model, prompt, opts) => {
      const { context, config = AI_CHAT_CONFIG_DEFAULT, outputAsJson, outputJsonStructure, outputJsonRequired } = opts;
      const systemPromptWithDocuments = formatSystemPromptWithDocuments('cerebras', opts);

      return await getCerebrasClient().chat.completions.create({
        model,
        messages: buildChatMessages(systemPromptWithDocuments, prompt),
        stream: false,
        ...buildSamplingParams('cerebras', model, config),
        response_format: buildOpenAIResponseFormat(context, outputAsJson, outputJsonStructure, outputJsonRequired),
      } satisfies Cerebras.ChatCompletionCreateParamsNonStreaming) as Cerebras.ChatCompletion.ChatCompletionResponse;
    },
    (response) => {
      const content = response.choices[0]?.message?.content;
      if (!content) {
        console.warn('[cerebras] ❓ No content in response');
        return null;
      }
      return content.trim();
    },
    (response) => {
      // BUG FIX: this previously returned snake_case keys
      // (completion_tokens/prompt_tokens/total_tokens) — the one raw pass-
      // through of Cerebras's own wire field names in the file, while every
      // other provider's extractUsage callback (including the sibling
      // OpenAI-compatible factory) normalizes to camelCase. AIResponse.usage
      // and incrementDailyUsageCount() both read the camelCase field names,
      // so Cerebras's token counts were silently recorded as undefined in
      // the usage ledger. Verify with a query against your `usage` table —
      // Cerebras rows should show non-null input/output token counts after
      // this fix that were previously null.
      return {
        promptTokens: response.usage?.prompt_tokens,
        completionTokens: response.usage?.completion_tokens,
        totalTokens: response.usage?.total_tokens,
      };
    },
    (response) => response.choices?.[0]?.finish_reason ?? 'unknown'
  );
}

/**
 * Mistral AI chat completion (60 RPM)
 *
 * Sends a chat completion request to Mistral AI with proper rate limiting,
 * error handling, and model fallback support. Iterates through available models
 * until successful response or all models exhausted.
 *
 * @param prompt - The user prompt to send to the AI
 * @param options - Additional options including configurations, system prompt, models, etc.
 * @returns Normalized AI response with provider, model, output, usage, and finish reason,
 *          or null if all models fail
 *
 * @example
 * ```typescript
 * const response = await mistralPrompt('Analyze this Islamic text for key themes');
 * if (response) {
 *   console.log(`Provider: ${response.provider}, Model: ${response.model}`);
 *   console.log(`Analysis: ${response.output}`);
 * }
 * ```
 */
export async function mistralPrompt(
  prompt: string,
  options?: Partial<PromptWithFallbackOptions>
): Promise<AIResponse<string> | null> {
  return promptWithFallback<ChatCompletionResponse>(
    'mistral',
    prompt,
    options,
    async (model, prompt, opts) => {
      const { config = AI_CHAT_CONFIG_DEFAULT, context, outputAsJson, outputJsonStructure, outputJsonRequired, cachedContentId } = opts;
      const { maxOutputToken, temperature, topP, stopSequences, frequencyPenalty, seed } = config;
      const systemPromptWithDocuments = formatSystemPromptWithDocuments('mistral', opts);

      return await getMistralClient().chat.complete({
        model,
        messages: buildChatMessages(systemPromptWithDocuments, prompt),
        maxTokens: getMaxOutputToken('mistral', model, maxOutputToken),
        temperature,
        topP,
        stop: stopSequences,
        frequencyPenalty,
        randomSeed: seed,
        stream: false,
        // Cache key mirrors Gemini's cachedContentId so the Mistral prefix
        // cache and the Gemini explicit cache bust on the same content change
        // (characters/places). Fall back to a shared key for callers that
        // don't pass cachedContentId (pen.ts, canon-validation.ts, etc.).
        // NOTE: the SDK's public property is camelCase `promptCacheKey`; it is
        // serialised to the wire field `prompt_cache_key` internally.
        promptCacheKey: buildMistralPromptCacheKey(cachedContentId),
        responseFormat: buildMistralResponseFormat({ context, outputAsJson, outputJsonStructure, outputJsonRequired }) as ChatCompletionRequest['responseFormat'],
      } satisfies ChatCompletionRequest);
    },
    (response) => {
      const content = response.choices[0]?.message?.content;
      if (!content) {
        console.warn('[mistral] ❓ No content in response');
        return null;
      }
      return Array.isArray(content) 
        ? content.map(chunk => chunk.type === 'text' ? chunk.text || '' : '').join(' ').trim()
        : content?.trim() || null;
    },
    (response) => {
      return {
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        totalTokens: response.usage.totalTokens,
      };
    },
    (response) => response.choices?.[0]?.finishReason ?? 'unknown'
  );
}

/** NVIDIA NIM chat completion (40 RPM)
 *
 * Sends a chat completion request to NVIDIA NIM HTTP API with proper rate limiting,
 * error handling, and model fallback support. Iterates through available models
 * until successful response or all models exhausted.
 *
 * @param prompt - The user prompt to send to the AI
 * @param stopSequences - Optional stop sequences to control output generation
 * @returns Normalized AI response with provider, model, output, usage, and finish reason,
 *          or null if all models fail
 * 
 * @see docs - https://docs.api.nvidia.com/nim/reference/create_chat_completion_v1_chat_completions_post
 * @see structured JSON guide - https://docs.nvidia.com/nim/large-language-models/1.13.0/structured-generation.html
 * 
 * @remarks
 * - The doc covers self-hosted NIM containers (which you deploy yourself with docker run), where extra_body.nvext.guided_json works. But your code hits the NVIDIA Integrate cloud API (integrate.api.nvidia.com), which is a different product — an OpenAI-compatible hosted endpoint that strips vendor extensions.
 * - NVIDIA is a single-model fallback provider with no structured output support.
 * 
 * @example
 * ```typescript
 * const response = await nvidiaPrompt('Generate a short thriller story');
 * if (response) {
 *   console.log(`Provider: ${response.provider}, Model: ${response.model}`);
 *   console.log(`Concepts: ${response.output}`);
 * }
 * ```
 */
export async function nvidiaPrompt(
  prompt: string,
  options?: Partial<PromptWithFallbackOptions>
): Promise<AIResponse<string> | null> {
  return promptWithFallback<NvidiaChatCompletionResponse>(
    'nvidia',
    prompt,
    options,
    async (model, prompt, opts) => {
      const { config = AI_CHAT_CONFIG_DEFAULT, signal } = opts;
      const systemPromptWithDocuments = formatSystemPromptWithDocuments('nvidia', opts);

      const { response } = await nvidiaChatRequest({
        model,
        messages: buildChatMessages(systemPromptWithDocuments, prompt),
        stream: false,
        ...buildSamplingParams('nvidia', model, config),

        // NVIDIA's hosted API doesn't support structured output extensions.
        // ...(outputAsJson ? {
        //   extra_body: {
        //     nvext: {
        //       guided_json: {
        //         type: "object",
        //         ...(outputJsonStructure ? {
        //           properties: outputJsonStructure,
        //           required: outputJsonRequired,
        //           additionalProperties: false
        //         } : {})
        //       } satisfies AIJsonProperty // Falls back to a generic JSON object if no structural layout is passed
        //     }
        //   }
        // } : {}),
      }, signal);

      return await response.json().catch(() => null) as NvidiaChatCompletionResponse;
    },
    (response) => {
      const content = response.choices[0]?.message?.content;
      if (!content) {
        console.warn('[nvidia] ❓ No content in response');
        return null;
      }
      return content.trim();
    },
    (response) => response.usage,
    (response) => response.choices?.[0]?.finish_reason ?? 'unknown'
  );
}

/**
 * Orchestrates AI providers and models with 2-level fallback to get the best AI result from a given prompt.
 * 
 * This function implements a sophisticated fallback strategy:
 * - **Provider-level fallback**: Tries providers in priority order (as defined in modelSelection)
 * - **Model-level fallback**: Within each provider, tries models in order until one succeeds
 * - **Prompt length validation**: Skips providers that cannot handle the total prompt length (system + user)
 * - **Rate limiting**: Applies per-provider throttling to respect API limits
 * - **Evaluation phase**: Optionally runs a second AI prompt to score, evaluate, and correct the output
 * 
 * ## Configuration Options
 * - `modelSelection`: Priority-ordered map of providers and their models (default: AI_CHAT_MODELS_WRITING)
 * - `config`: Generation parameters (temperature, maxTokens, etc.) (default: AI_CHAT_CONFIG_DEFAULT)
 * - `outputAsJson`: Whether to parse output as JSON object
 * - `outputJsonStructure`: JSON schema definition for structured output
 * - `outputJsonRequired`: Required fields in JSON output
 * - `outputJsonFallbackField`: Fallback field if JSON parsing fails
 * - `systemPrompt`: System prompt to guide AI behavior (default: PROMPT_SYSTEM)
 * - `documents`: Additional context documents for RAG-style prompting
 * - `context`: Logging context for debugging
 * - `logPrompts`: Whether to log full prompts (only on first iteration)
 * - `logEvaluationResult`: Whether to log evaluation phase results
 * 
 * ## Evaluation Phase
 * When `evaluatorPrompt` is provided, the function:
 * 1. Generates initial output using the primary prompt
 * 2. Calls a second AI prompt (using AI_CHAT_MODELS_EVALUATION) to evaluate the output
 * 3. The evaluator scores the output, applies corrections, and returns improved result
 * 4. Returns the evaluated output with metadata (scores, action flags, integrity flags)
 * 
 * ## Progress Callbacks
 * - `onProgress`: Emits SSE events for generation lifecycle (ai_generation_start, ai_generation_complete, ai_evaluation_start, ai_evaluation_complete)
 * - `onGenerationProgress`: Emits story generation steps for UI updates
 * 
 * ## Prompt Length Validation
 * Calculates total prompt length (systemPrompt + prompt) and skips providers that cannot handle it.
 * Each provider has a maximum character limit defined in AI_MAX_PROMPT_LENGTH:
 * - Gemini: 3,600,000 chars (~900K tokens)
 * - Mistral: 1,000,000 chars (~250K tokens)
 * - Cohere/Groq/Cerebras/NVIDIA/OVHcloud: 400,000-500,000 chars (~100-120K tokens)
 * 
 * @param prompt - The user prompt to send to AI
 * @param options - Optional configuration for generation behavior
 * @param evaluatorPrompt - Optional second prompt for evaluation phase (scores and corrects output)
 * @param onProgress - Optional callback for SSE progress events
 * @param onGenerationProgress - Optional callback for story generation step updates
 * @returns AI response with provider, model, output, and optional parsed result, or empty `none` if all fail
 * 
 * @example
 * ```typescript
 * // Basic usage
 * const response = await aiPrompt<StoryPage>('Generate a story about...');
 * if (response.provider !== 'none') {
 *   console.log('Provider:', response.provider, 'Model:', response.model);
 *   console.log('Story:', response.output.text);
 * }
 * 
 * // JSON output with schema
 * const structured = await aiPrompt<StoryData>('Generate a story about...', {
 *   outputAsJson: true,
 *   outputJsonStructure: STORY_SCHEMA_DEFINITION,
 *   outputJsonRequired: ['title', 'content'],
 *   outputJsonFallbackField: 'title'
 * });
 * ```
 */
export async function aiPrompt<T extends Record<string, unknown> | string = string>(
  prompt: string, 
  options: AIPromptOptions & { evaluatorFallbackLimit?: number } = {},
  evaluatorPrompt?: string,
  onProgress?: ProgressCallback,
  onGenerationProgress?: (step: StoryGenerationStep) => Promise<void>,
): Promise<AIResponse<T>> {
  const {
    modelSelection = AI_CHAT_MODELS_WRITING,
    config = AI_CHAT_CONFIG_DEFAULT,
    outputAsJson = false,
    outputJsonFallbackField,
    outputJsonStructure,
    outputJsonRequired,
    systemPrompt: originalSystemPrompt = PROMPT_SYSTEM,
    documents = [],
    context = 'ai',
    logPrompts = false,
    meta,
    validateOutput,
    minOutputLength,
  } = options;

  // Early exit: Define provider order from modelSelection or use empty array
  // If no modelSelection provided, return empty response
  const providers = Object.keys(modelSelection) as AIChatProvider[];
  if (providers.length === 0) return { provider: 'none', output: '' };

  // Flag whether structured output is active
  const supportsStructuredOutput = Boolean(outputJsonStructure && outputJsonRequired?.length);

  // Mark AI generation start event
  await onProgress?.({ type: 'ai_generation_start' });
  await onGenerationProgress?.('ai_generation');

  // Shared counter for cross-provider fallback limit
  const fallbackCounter = options.fallbackLimit !== undefined ? { count: 0 } : undefined;

  // Try each provider in order
  for (const provider of providers) {
    const isFirstIteration = providers.indexOf(provider) === 0;
    let result: AIResponse<string> | null = null;

    // Append outputFormat to systemPrompt when structured output is active or provider is gemini
    const shouldAppendOutputFormat = options.outputFormat && (supportsStructuredOutput || provider === 'gemini');
    // Labeled (external review, checkpoint 7, Finding 2 Fix B): a plain
    // `---\n${format}` separator with no heading reads, to a model, as
    // "more free-form instructions" rather than "the JSON shape you must
    // match" — indistinguishable from other unlabeled `---`-separated
    // blocks already in the prompt (task, field instructions, review
    // checklist). Purely additive/cosmetic; does not change when this
    // block is appended, only how the model is told to read it.
    const systemPrompt = shouldAppendOutputFormat ? `${originalSystemPrompt}\n\n---\nEXPECTED OUTPUT JSON FORMAT (the exact shape the response must match):\n${options.outputFormat}` : originalSystemPrompt;

    try {
      const models = modelSelection[provider];
      if (!models || models.length === 0) continue; // Skip to next provider

      // Validate prompt length (incl. documents) against the provider's max,
      // and that its daily request budget isn't exhausted.
      const gate = await assertPromptAllowed(provider, systemPrompt, prompt, documents);
      if (!gate.allowed) {
        console.log(`[${provider}] ⏩ ${gate.reason}`);
        continue;
      }

      // AI provider is available and ready to be used
      console.log(`[${provider}] 🧠 Ready with task (${models.length} models)...`);
      
      // Only log prompts on the very first iteration
      const shouldLogPrompts = logPrompts && isFirstIteration;
      logAIPrompt(provider, '💬 Built user prompt', prompt, shouldLogPrompts);

      const opts: Partial<PromptWithFallbackOptions> = {
        ...options,
        models,
        config,
        outputAsJson,
        systemPrompt,
        logPrompts: shouldLogPrompts,
        meta,
        _fallbackCounter: fallbackCounter,
      };
      
      // Pre-call check: when the schema exceeds Gemini's constrained-decoder
      // limits, don't skip Gemini outright — fall back to string-wrapped JSON
      // output instead, mirroring the same tradeoff resolveUseStringEvaluator
      // already makes for the evaluation pass, and for the identical reason
      // (Gemini's constrained decoder can't compile an overly complex schema,
      // but has no trouble producing a JSON *string* containing that same
      // shape when the format is described in prose — which options.outputFormat
      // already does for every gemini call via shouldAppendOutputFormat above).
      //
      // Only opts.outputJsonStructure/outputJsonRequired are overridden here —
      // the outer outputJsonStructure/outputJsonRequired (used by the shared
      // parseAISafely call after the switch below) stay untouched, so once
      // geminiStringModeWrapperKey's unwrap step runs, Gemini's output is
      // validated against the REAL schema through the same repair pipeline
      // every other provider's output goes through — not a bespoke bare
      // JSON.parse the way the evaluation pass's string mode works today.
      const geminiStringModeWrapperKey = 'output';
      const geminiUsesStringMode = provider === 'gemini' && isSchemaTooComplex(outputJsonStructure);
      if (geminiUsesStringMode) {
        console.warn(`[gemini] 📝 Schema exceeds complexity limits Gemini's constrained decoder can compile — using string-wrapped JSON output instead of skipping`);
        opts.outputJsonStructure = {
          [geminiStringModeWrapperKey]: {
            type: 'string',
            description: 'The complete JSON object described in the output format above, as a single escaped JSON string.',
          },
        };
        opts.outputJsonRequired = [geminiStringModeWrapperKey];
      }

      // Provider-agnostic stack
      switch (provider) {
        case 'gemini':     result = await geminiPrompt(prompt, opts); break;     // ✅ JSON schema | ☑️ document via system prompt
        case 'cohere':     result = await coherePrompt(prompt, opts); break;     // ✅ JSON schema | ✅ document via RAG
        case 'mistral':    result = await mistralPrompt(prompt, opts); break;    // ✅ JSON schema | ☑️ document via system prompt
        case 'groq':       result = await groqPrompt(prompt, opts); break;       // ✅ JSON schema | ☑️ document via system prompt
        case 'cerebras':   result = await cerebrasPrompt(prompt, opts); break;   // ✅ JSON schema | ☑️ document via system prompt
        case 'nvidia':     result = await nvidiaPrompt(prompt, opts); break;     // ☑️ JSON via prompt instructions | ☑️ document via system prompt
        case 'openrouter': result = await openrouterPrompt(prompt, opts); break; // OpenAI-compatible factory
        case 'cloudflare': result = await cloudflarePrompt(prompt, opts); break; // OpenAI-compatible factory
        case 'inception':  result = await inceptionPrompt(prompt, opts); break;  // Diffusion LLM — strict json_schema may not be honored; trial measures it
        case 'ovhcloud':    result = await ovhcloudPrompt(prompt, opts); break;    // OpenAI-compatible factory
        case 'sambanova':   result = await sambanovaPrompt(prompt, opts); break;   // OpenAI-compatible factory
        case 'ollama':      result = await ollamaPrompt(prompt, opts); break;      // OpenAI-compatible factory — free tier is GPU-time/session-quota, not token-based; see AI_RATE_LIMITS.ollama
        case 'modelscope':  result = await modelscopePrompt(prompt, opts); break;  // OpenAI-compatible factory
        case 'zai':         result = await zaiPrompt(prompt, opts); break;         // OpenAI-compatible factory
        case 'siliconflow': result = await siliconflowPrompt(prompt, opts); break; // OpenAI-compatible factory
        case 'aionlabs':    result = await aionlabsPrompt(prompt, opts); break;    // OpenAI-compatible factory — tiny ~20K token/day budget, scoped to AI_CHAT_MODELS_IDEA only
        case 'chutes':      result = await chutesPrompt(prompt, opts); break;      // OpenAI-compatible factory — decentralized; only TEE-flagged models are wired into the model pools
        case 'llm7':        result = await llm7Prompt(prompt, opts); break;        // OpenAI-compatible factory — unofficial mirror, last-resort fallback only
      }

      // Unwrap string-mode output before it reaches the shared parseAISafely
      // call below. Deliberately tolerant of a failed unwrap: if the wrapper
      // itself doesn't parse (e.g. Gemini emitted malformed JSON even for the
      // simple wrapper shape), `result.output` is left as-is and falls
      // through to parseAISafely's own repair pipeline rather than being
      // discarded — strictly no worse than the previous skip-Gemini behavior,
      // and often better since the repair pipeline gets a chance to salvage it.
      if (geminiUsesStringMode && result?.output) {
        try {
          const wrapper = JSON.parse(result.output) as Record<string, unknown>;
          const inner = wrapper[geminiStringModeWrapperKey];
          if (typeof inner === 'string') {
            result = { ...result, output: inner };
          } else {
            console.warn(`[gemini] ⚠️ String-mode wrapper missing '${geminiStringModeWrapperKey}' field — passing raw output to repair pipeline as-is`);
          }
        } catch {
          console.warn('[gemini] ⚠️ Failed to parse string-mode wrapper JSON — passing raw output to repair pipeline as-is');
        }
      }
    } catch (error) {
      console.log(`[${provider}] ⚠️ Provider failed:`, error);
      result = null;
    }

    await onProgress?.({ type: 'ai_generation_complete' });

    if (result?.output) {
      // Completeness guard (opt-in, mirrors aiStreamSSE's validateOutput /
      // minOutputLength / finishReason checks). A truncated or empty result must
      // be rejected so aiPrompt falls through to the next provider in the
      // fallback chain instead of returning cut-off content. Throwing here routes
      // into the `catch` below, which logs and continues to the next provider.
      if (validateOutput || minOutputLength != null) {
        const fullText = result.output;
        const trimmedLength = fullText.trim().length;
        const tooShort = minOutputLength != null && minOutputLength > 0 && trimmedLength < minOutputLength;
        let invalid = false;
        if (validateOutput) {
          try {
            invalid = !validateOutput(fullText);
          } catch {
            invalid = true;
          }
        }
        const incompleteFinish = !isCompleteFinishReason((result as { finishReason?: string }).finishReason);
        if (tooShort || invalid || incompleteFinish) {
          console.warn(`[${provider}] ⚠️ Completeness guard rejected result (tooShort=${tooShort}, invalid=${invalid}, incompleteFinish=${incompleteFinish}) — trying next provider`);
          throw new Error("Completeness guard rejected result");
        }
      }
      try {
        // Run evaluation phase if provided
        if (evaluatorPrompt) {
          const evaluated = await runEvaluationPass<T>(result, evaluatorPrompt, options, systemPrompt, context, onProgress, onGenerationProgress);
          if (evaluated) return evaluated;
        }

        // Parse the output into the expected type T
        // 1. Best-effort on parsing evaluation result when `evaluatorPrompt` provided (above)
        // 2. If stil fail, try parse original AI response (unevaluated)
        let parsedResult: T;
        
        if (outputAsJson) {
          // For JSON-like output, try to parse as object using parseAISafely
          parsedResult = await parseAISafely(result, {
            logContext: `${provider}-${context}`,
            schema: outputJsonStructure,
            requiredFields: outputJsonRequired,
            fallbackField: outputJsonFallbackField
          }) as T;
        } else {
          // Non-JSON mode — treat the raw output string as the result directly.
          parsedResult = result.output as T;
        }

        if (!parsedResult) {
          throw new Error(`Can't parse ${outputAsJson ? 'JSON' : 'string'} output, got falsy result`);
        }
        
        return {
          ...result,
          result: parsedResult
        } satisfies AIResponse<T>;
      } catch (parseError) {
        console.warn(`[${provider}] ⚠️ Failed to parse as type T, trying next provider:`, parseError);
      }
    }

    // Log fallback if there are more providers to try
    const remainingProviders = providers.slice(providers.indexOf(provider) + 1);
    if (remainingProviders.length > 0) {
      console.log(`[${provider}] ⚠️ Failed, trying remaining fallback: ${remainingProviders.join(' → ')}`);
    }
  }

  await onProgress?.({ type: 'ai_generation_complete' });
  return { provider: 'none', output: '' };
}

/**
 * Runs the evaluation/self-correction pass on an already-generated result.
 * Extracted from aiPrompt's inline `if (evaluatorPrompt)` block (originally
 * only reachable as a private follow-up inside aiPrompt's own provider loop)
 * so the exact same evaluation-call shape — same schema-complexity handling
 * via the outer aiPrompt's own Gemini string-mode fallback, same
 * prompt-length waterfall-skip behavior, same score/correct/re-score
 * contract — can also be invoked directly for a single post-merge evaluation
 * pass in multi-turn page generation (see prompt.ts's
 * evaluateMergedStoryGeneration — MULTI_TURN_PAGE_GENERATION_ROADMAP.md Part
 * 5.5 Q2). aiPrompt's own inline call site now just calls this and returns
 * early on success — behavior is unchanged, this is a pure extraction.
 *
 * @param result - The already-generated content to evaluate (`result.output`
 * is fed to the evaluator as a "GENERATED JSON (from previous AI)" document).
 * @typeParam T - Matches `aiPrompt`'s own constraint (`Record<string, unknown> | string`),
 * not just object shapes — `aiPrompt<T>` calls this internally with its own
 * `T` unchanged (see the inline call site below), so a narrower constraint
 * here would reject exactly the callers `aiPrompt` needs to pass through.
 * Caught as a real `tsc` error (not just an esbuild-syntax gap) during the
 * checkpoint-4 audit: the original narrower `T extends Record<string, unknown>`
 * compiled fine in isolation but broke at aiPrompt's own call site, since
 * `aiPrompt`'s `T` can be `string` and TypeScript can't prove otherwise
 * generically. `buildEvaluationSchemaDefinition<T>` inside this function
 * keeps its own stricter `Record<string, unknown>`-only constraint safely —
 * it's called without an explicit type argument and its parameter doesn't
 * reference `T`, so its inference is independent of this widening.
 * @param systemPrompt - The system prompt to reuse for the evaluation call —
 * pass the SAME (already provider/output-format-resolved) string used for
 * the generation call that produced `result`, not `options.systemPrompt`
 * unresolved, so the evaluator sees identical framing to the generator.
 * @param context - Base context string; the evaluation call itself uses
 * `${context}-evaluation` (matching aiPrompt's original inline behavior).
 * @returns The corrected `AIResponse<T>` on a successful evaluation, or
 * `undefined` if evaluation didn't produce a usable correction — callers
 * should fall back to parsing `result.output` themselves in that case,
 * exactly as aiPrompt's own post-block code already does.
 */
export async function runEvaluationPass<T extends Record<string, unknown> | string>(
  result: AIResponse<string>,
  evaluatorPrompt: string,
  options: AIPromptOptions & { evaluatorFallbackLimit?: number },
  systemPrompt: string,
  context: string,
  onProgress?: ProgressCallback,
  onGenerationProgress?: (step: StoryGenerationStep) => Promise<void>,
): Promise<AIResponse<T> | undefined> {
  const {
    config = AI_CHAT_CONFIG_DEFAULT,
    documents = [],
    logEvaluationResult = false,
    evaluatorFallbackLimit = EVALUATION_FALLBACK_LIMIT,
  } = options;

  // STEP 3: EVALUATING (best-effort)
  // Evaluation must not invalidate a successful generation. If evaluation fails,
  // fall back to the original generated `result.output` below.
  await onProgress?.({ type: 'ai_evaluation_start' });
  await onGenerationProgress?.('ai_evaluation');

  const evaluationContext = `${context}-evaluation`;

  // Resolve 'auto' once at the evaluation level. The resolved boolean threads
  // through to both schema building and result parsing, ensuring they stay in sync.
  //
  // Duplicate-output-format bug fix (external review, checkpoint 7,
  // Finding 2): `options.outputFormat`, when set, is the GENERATION call's
  // schema-shape text — the `systemPrompt` argument passed into this
  // function already has it appended exactly once (aiPrompt's own
  // shouldAppendOutputFormat logic, applied for the generation call that
  // produced `result`). Letting `outputFormat` survive the `...options`
  // spread here means the INNER aiPrompt call below would append it a
  // SECOND time on top of that already-baked-in copy — aiPrompt has no way
  // to know the systemPrompt it's given already carries one. Stripped at
  // the source so neither `evaluationOptions` nor anything spread from it
  // downstream can carry it forward.
  const { outputFormat: _outputFormat, ...optionsWithoutOutputFormat } = options;
  const evaluationOptions: AIPromptOptions = {
    ...optionsWithoutOutputFormat,
    modelSelection: AI_CHAT_MODELS_EVALUATION,
    useStringEvaluatorOutput: resolveUseStringEvaluator({ ...optionsWithoutOutputFormat, modelSelection: AI_CHAT_MODELS_EVALUATION }),
  };

  try {
    // Call second AI prompt to score, evaluate, and output corrected result
    const response = await aiPrompt<AIJsonEvaluation<T>>(evaluatorPrompt, {
      ...evaluationOptions,
      config: {...config, maxOutputToken: config.maxOutputToken + EVALUATION_SCORING_OUTPUT_TOKEN },
      systemPrompt,
      context: evaluationContext,
      fallbackLimit: evaluatorFallbackLimit,

      // Pass generated raw output as document
      documents: [
        ...documents,
        {
          title: 'GENERATED JSON (from previous AI)',
          snippet: result.output,
        }
      ],

      // Evaluation output schema
      outputAsJson: true,
      outputJsonStructure: buildEvaluationSchemaDefinition(evaluationOptions),
      outputJsonRequired: EVALUATION_REQUIRED_FIELDS satisfies (keyof AIJsonEvaluation<T>)[],
      outputJsonFallbackField: 'output' satisfies keyof AIJsonEvaluation<T>

      // CRITICAL: evaluation call should exclude the evaluatorPromptBuilder to prevent the recursive loop
    }, undefined);

    const { result: evaluationResult, provider: evalProvider, model: evalModel } = response;

    if (evaluationResult) {
      const { scoreBefore, scoreAfter, actionFlags, integrityFlags } = evaluationResult;
      if (logEvaluationResult) {
        edgeGroup.wrap(`[${evaluationContext}] 🕵️‍♂️ Evaluation result (score: ${scoreBefore.total} → ${scoreAfter.total}):`, async () => {
          console.log("Score before:", scoreBefore);
          console.log("Score after:", scoreAfter);
          console.log("Action flags:", actionFlags);
          console.log("Integrity flags:", integrityFlags);
        });
      }
      // Process evaluator output based on schema strategy
      // evaluationOptions.useStringEvaluatorOutput is already resolved to a
      // boolean (see resolveUseStringEvaluator above). When true: output is
      // JSON string → parse. When false: output is structured object → use directly.
      //
      // Newline-stripping bug fix (external review, checkpoint 7): this used
      // to be a bare `JSON.parse(raw)` — any minor escaping slip (a raw
      // newline byte instead of `\n`, one stray unescaped quote) threw,
      // silently discarding the ENTIRE correction and falling back to the
      // pre-correction text. Routing through parseAISafely instead — the
      // same multi-stage repair pipeline (sanitise → extract → jsonrepair →
      // isdk-repair → heuristic fixes) every OTHER provider's structured
      // output already goes through, and the same fix already applied to
      // aiPrompt's own Gemini string-mode fallback for the identical
      // constrained-decoder-limit reason — means a minor escaping issue gets
      // *repaired*, not discarded.
      //
      // Instantiated as parseAISafely<Record<string, unknown>> rather than
      // parseAISafely<T> — T here can be `string` (inherited from aiPrompt's
      // own wider constraint so this function can be called from inside it),
      // which parseAISafely's own `T extends Record<string, unknown>`
      // constraint would reject; the result is cast to T below instead,
      // which is always valid since T is constrained to be assignable from
      // Record<string, unknown> whenever this string-mode branch is
      // meaningfully reached (correcting free-form `string` output via a
      // JSON-object evaluator wrapper isn't a real usage pattern).
      // `options.outputJsonStructure`/`outputJsonRequired`/
      // `outputJsonFallbackField` are T's own schema/required-fields/fallback
      // (not the AIJsonEvaluation<T> wrapper's — those already flow into
      // `evaluationOptions` for the wrapper build above), so reusing them
      // here is exactly correct: the same schema T's generation call was
      // validated against.
      let correctedOutput: T | undefined;
      if (evaluationOptions.useStringEvaluatorOutput) {
        const raw = evaluationResult.output as unknown as string;
        if (raw) {
          try {
            const parsed = await parseAISafely<Record<string, unknown>>(
              { output: raw, provider: evalProvider },
              {
                schema: options.outputJsonStructure,
                requiredFields: options.outputJsonRequired ?? [],
                fallbackField: options.outputJsonFallbackField,
                logContext: evaluationContext,
              },
            );
            correctedOutput = parsed && Object.keys(parsed).length > 0 ? (parsed as T) : undefined;
          } catch {
            // parseAISafely is designed not to throw on malformed input (it
            // repairs rather than rejects), but this local catch is kept —
            // matching the original bare-JSON.parse code's own local
            // try/catch — so an unexpected failure here still gets the
            // specific warning below instead of falling through to the
            // outer catch's more generic "evaluation failed" message.
          }
          if (!correctedOutput) {
            console.warn(`[${evaluationContext}] ⚠️ Failed to parse evaluator string output as JSON — falling back to original`);
          }
        }
      } else {
        correctedOutput = evaluationResult.output;
      }

      if (correctedOutput) {
        return {
          ...result,
          evalProvider,
          evalModel,
          scoreBefore: scoreBefore.total,
          scoreAfter: scoreAfter.total,
          result: correctedOutput
        } satisfies AIResponse<T>;
      }
    } else if (logEvaluationResult) {
      console.warn(`[${evaluationContext}] ❓ Evaluation returned no result — falling back to generation output`);
    }
  } catch (evalError) {
    console.warn(`[${evaluationContext}] ⚠️ Evaluation failed — falling back to generation output:`, evalError);
    // Continue to parsing original generated result
  } finally {
    try {
      // Ensure we emit evaluation complete regardless of outcome to keep
      // progress lifecycle consistent (best-effort)
      await onProgress?.({ type: 'ai_evaluation_complete' });
    } catch {
      // Never let a progress callback mask a real evaluation error
    }
  }

  return undefined;
}


/**
 * Calculates whether a JSON schema is too complex for Gemini's constrained decoder.
 * 
 * Gemini's structured output uses constrained decoding, which builds a state graph
 * from the schema. Schemas with too many properties, enum values, deep nesting, or
 * large serialized size can exceed the graph compilation budget and produce
 * "too many states for serving" errors.
 * 
 * Thresholds (empirically determined):
 * - >100 properties → too many structural branches
 * - >100 total enum items → too many token alternatives at decision points
 * - >6 max depth → nested state explosion (arrays of objects within arrays)
 * - schema JSON larger than MAX_SCHEMA_LENGTH (config/ai-chat.ts, 30KB) → payload itself exceeds decoder limits
 * 
 * @param schema - The JSON schema properties object to evaluate
 * @returns True if the schema exceeds complexity thresholds
 */
export function isSchemaTooComplex(schema: Record<string, AIJsonProperty> | undefined): boolean {
  if (!schema || Object.keys(schema).length === 0) return false;

  const schemaStr = JSON.stringify(schema);
  let props = 0;
  let enumItems = 0;
  let maxDepth = 0;

  function measure(obj: unknown, depth: number = 0): void {
    if (depth > maxDepth) maxDepth = depth;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;

    const record = obj as Record<string, unknown>;

    if (Array.isArray(record.enum)) {
      enumItems += record.enum.length;
    }

    if (record.properties && typeof record.properties === 'object') {
      props += Object.keys(record.properties).length;
      for (const val of Object.values(record.properties)) {
        measure(val, depth + 1);
      }
    }

    if (record.items && typeof record.items === 'object' && !Array.isArray(record.items)) {
      measure(record.items, depth + 1);
    }
  }

  // Recursing into each property's value (which is a real schema node).
  props = Object.keys(schema).length;
  for (const val of Object.values(schema)) {
    measure(val, 1);
  }

  const isComplex = props > 100 || enumItems > 100 || maxDepth > 6 || schemaStr.length > MAX_SCHEMA_LENGTH;
  if (isComplex) {
    console.warn(`[schema-complexity] ⚠️ Schema too complex: ${schemaStr.length} chars (${schemaStr.length / 1024 | 0}KB), ${props} props, ${enumItems} enum items, depth ${maxDepth}`);
  }

  return isComplex;
}

/**
 * Resolves the `useStringEvaluatorOutput` option to a concrete boolean.
 *
 * Three modes:
 * – `'auto'` (default): Checks the evaluator's model selection for Gemini.
 *   If Gemini is present → `true` (string mode, avoids Gemini's constrained-decoder limits).
 *   If Gemini is absent → `false` (structured mode, tighter provider-enforced validation).
 * – `true`: Always use string mode (small schema, no structural validation at provider level).
 * – `false`: Always use structured mode (provider enforces field names, types, required).
 *
 * The auto mode adapts automatically to provider config changes. If Gemini is removed
 * from or added to the evaluator chain in the future, the strategy switches accordingly.
 *
 * @param options - Prompt options containing the raw flag value and model selection
 * @returns Resolved boolean for use in schema building and result parsing
 */
export function resolveUseStringEvaluator(options: { useStringEvaluatorOutput?: boolean | 'auto'; modelSelection?: AIModelSelection }): boolean {
  const setting = options.useStringEvaluatorOutput;
  if (setting === false) return false;
  if (setting === true) return true;
  // 'auto' (default): use string mode when Gemini is in the evaluator provider chain
  return options.modelSelection ? 'gemini' in options.modelSelection : true;
}

/**
 * Type-safe AI prompt options builder
 * 
 * Creates AI prompt options with JSON schema and required fields automatically applied.
 * This eliminates the need to manually specify outputJsonStructure and outputJsonRequired
 * when using structured JSON output with AI providers.
 * 
 * @param schema - Schema definition mapping field names to their JSON property types
 * @param required - Array of required field names that must be present in AI response
 * @param baseOptions - Additional AI prompt options (config, modelSelection, etc.)
 * @returns Complete AI prompt options with schema applied and JSON output enabled
 * 
 * @example
 * ```typescript
 * // Create options for StoryGeneration type
 * const storyOptions = createAIOptionsWithSchema({
 *   text: { type: 'string' },
 *   mood: { type: 'string' },
 *   actions: { type: 'array', items: { type: 'object' } }
 * }, ['text', 'actions'], {
 *   modelSelection: AI_CHAT_MODELS_WRITING,
 *   context: 'story-generation'
 * });
 * 
 * // Use with aiPrompt
 * const response = await aiPrompt<StoryGeneration>(prompt, storyOptions);
 * ```
 */
export function createAIOptionsWithSchema<T extends Record<string, unknown>>(
  configs: AIPromptForJson<T>
): AIPromptOptions {
  const { schema, requiredFields, fallbackField, baseOptions } = configs;
  return {
    ...baseOptions,
    outputAsJson: true,
    outputJsonStructure: schema,
    outputJsonRequired: requiredFields as string[],
    outputJsonFallbackField: fallbackField as string
  };
}

/**
 * Formats AI documents into a prompt string
 * 
 * @param documents - Array of AI documents to format
 * @returns Formatted string with document titles and snippets, or empty string if no documents
 * 
 * @example
 * ```typescript
 * const formatted = formatDocumentsToPrompt([
 *   { title: 'Story Context', snippet: 'User is in a dark forest...' },
 *   { title: 'Character Info', snippet: 'Main character: John...' }
 * ]);
 * ```
 */
export function formatDocumentsToPrompt(documents?: AIDocument[]): string {
  if (!documents?.length) return '';

  return documents
    .filter((doc): doc is AIDocument => !!doc)
    .map((doc) => `${doc.title ? `${doc.title}:\n` : ''}${doc.snippet}`.trim())
    .join('\n\n');
}

/**
 * Formats system prompt with documents for AI providers
 * 
 * This function handles document attachment differently based on provider capabilities:
 * - RAG providers (Cohere): Documents sent via dedicated `documents` field
 * - System prompt providers (OpenAI-compatible providers, Gemini, etc.): Documents embedded in system prompt
 * 
 * @param options - AI prompt options containing system prompt and documents
 * @returns Formatted system prompt string with documents properly attached
 * 
 * @example
 * ```typescript
 * const formatted = formatSystemPromptWithDocuments({
 *   systemPrompt: 'You are a helpful assistant...',
 *   documents: [
 *     { title: 'Context', snippet: 'User is exploring...' },
 *     { title: 'Rules', snippet: 'Be concise...' }
 *   ]
 * });
 * ```
 */
export function formatSystemPromptWithDocuments(provider: AIChatProvider, options: Pick<AIPromptOptions, 'systemPrompt' | 'documents' | 'logPrompts'>): string {
  const { systemPrompt = PROMPT_SYSTEM, documents, logPrompts = false } = options;
  
  // Early return when no document or provider is Cohere's V2 API which
  // natively supports RAG via documents field.
  if (!documents?.length || provider === 'cohere') {
    logAIPrompt(provider, '💬 Built system prompt', systemPrompt, logPrompts);
    return systemPrompt;
  }
  
  const formattedDocuments = formatDocumentsToPrompt(documents);
  const systemPromptWithDocs = `${systemPrompt}\n\n---\n${formattedDocuments}`;
  const message = `🧾 Built system prompt with ${documents.length} document${documents.length > 1 ? 's' : ''}`;
  logAIPrompt(provider, message, systemPromptWithDocs, logPrompts);
  return systemPromptWithDocs;
}