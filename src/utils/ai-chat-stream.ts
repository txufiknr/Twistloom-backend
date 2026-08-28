import type { AIChatProvider, AIPromptOptions, AIStreamGenerator, PromptWithFallbackOptions, StreamUsage } from "../types/ai-chat.js";
import { getCerebrasClient, getCloudflareClient, getCohereClient, getGeminiClient, getGroqClient, getInceptionClient, getMistralClient, getOpenRouterClient, getOvhcloudClient, getSambanovaClient, getOllamaClient, getModelscopeClient, getZaiClient, getSiliconflowClient, getAionlabsClient, getChutesClient, getLlm7Client } from "./ai-clients.js";
import { AI_CHAT_CONFIG_DEFAULT } from "../config/ai-chat.js";
import { AI_CHAT_MODELS_WRITING, AI_STREAM_DEFAULT_MODEL } from "../config/ai-clients.js";
import { getRateLimiter, incrementDailyUsageCount } from './ai-limiters.js';
import { PROMPT_SYSTEM } from "./prompt.js";
import { logAIPrompt, logAISuccess } from './ai-logger.js';
import { getErrorMessage } from "./error.js";
import { retryWithBackoff } from "./retry.js";
import { createTextChunkEvent, createErrorEvent, createProviderErrorEvent, createStartEvent, createEndEvent, handleBackpressure } from "./sse.js";
import {
  formatSystemPromptWithDocuments, getMaxOutputToken, isSchemaTooComplex,
  buildChatMessages, buildJsonSchemaObject, buildOpenAIResponseFormat, buildMistralResponseFormat, buildCohereResponseFormat,
  buildGeminiResponseJsonSchema, buildSamplingParams, resolveGeminiCachedContent, buildGeminiConfig, buildMistralPromptCacheKey,
  resolveStreamDefaultModel, sumDocumentChars, assertPromptAllowed, buildModelRetryConfig, extractDeltaText, nvidiaChatRequest,
  mapCohereDocuments,
} from "./ai-chat.js";
import { type GenerateContentConfig, type GenerateContentParameters } from "@google/genai";
import type { AIChatStreamProvider, AIChatStreamResult } from "../types/sse.js";
import type { Cohere } from "cohere-ai";
import type Cerebras from "@cerebras/cerebras_cloud_sdk/resources";
import type OpenAIClient from 'openai';
import type * as OpenAI from "openai/resources";
import type * as Mistral from "@mistralai/mistralai/models/components";
import type * as Groq from "groq-sdk/resources/chat/completions";
import { estimateTokens, logGenerationTelemetry } from "./prompt-telemetry.js";
import { convertToGeminiSchema } from "./gemini.js";

/**
 * SSE-enabled AI streaming function that yields chunks immediately
 * 
 * This function streams AI responses in real-time using Server-Sent Events format.
 * Instead of accumulating all chunks before returning, it yields each chunk as it arrives,
 * making it suitable for SSE responses in serverless environments.
 *
 * This implementation uses an orchestrator-level fallback strategy:
 * - Model fallback is handled at the orchestrator level (this function), not within individual generators
 * - Each provider's generator receives a single model to attempt
 * - Error handling and event sending are centralized in the orchestrator
 * - Rate limiting is applied once per provider, not per model
 * 
 * Benefits:
 * - Centralized fallback logic - easier to maintain and debug
 * - Consistent error handling - error events sent uniformly from single location
 * - Simpler generators - no fallback complexity in individual providers
 * - Better observability - start/end events show which model is being tried
 * - Rate limiting efficiency - applied once per provider
 * - DRY principle - no duplicated fallback logic across 7 generators
 * - Easier debugging - single location for fallback logging/monitoring
 *
 * Trade-offs:
 * - Slightly more complex orchestrator with nested loops
 * - Less encapsulated fallback logic
 *
 * @remarks
 * **Architecture Approach: Orchestrator-Level Fallback**
 * 
 * @remarks
 * **SDK Limitations**
 *
 * The following providers have SDK limitations regarding AbortSignal support:
 * - **Cohere**: The `V2ChatRequest` type does not include an `abortSignal` parameter. Cancellation is only checked during iteration, not at the HTTP request level.
 * - **Gemini**: The Google GenAI SDK does not support AbortSignal. Cancellation is only checked during iteration, not at the HTTP request level.
 *
 * For these providers, the abort signal will still cancel the stream during iteration, but the HTTP request itself cannot be cancelled mid-flight.
 *
 * @remarks
 * **Stream Output Format: What `aiStreamSSE` Emits**
 *
 * `aiStreamSSE` yields a `ReadableStream<Uint8Array>` where each chunk contains
 * binary-encoded, wire-formatted Server-Sent Events (SSE) strings:
 * - `event: start\ndata: {"type":"start","provider":"...","model":"..."}\n\n`
 * - `event: chunk\ndata: {"type":"chunk","content":"<text delta>","done":false}\n\n`
 * - `event: end\ndata: {"type":"end","provider":"...","model":"..."}\n\n`
 * - `event: error\ndata: {"type":"error","message":"..."}\n\n`
 *
 * **CRITICAL USAGE NOTE: Piping vs. Text Extraction**
 * - **Piping to HTTP Client**: Chunks can be written directly to an open SSE response
 *   (e.g. `await stream.write(chunk)` in Hono's `streamSSE`).
 * - **Extracting Clean Text for DB/Cache**: NEVER concatenate and decode the raw `Uint8Array`
 *   chunks via `TextDecoder` (e.g. `new TextDecoder().decode(combined)`). Doing so captures the
 *   raw protocol envelope (`event: ...\ndata: ...`). Instead, use {@link parseSSEStreamContent}
 *   or extract `data.content` from the JSON payload while iterating.
 *
 * @param prompt - The prompt to send to AI
 * @param options - Optional configuration
 * @param signal - Optional AbortSignal for cancellation
 * @returns ReadableStream that yields SSE-formatted chunks
 *
 * @example
 * ```typescript
 * const abortController = new AbortController();
 * const stream = await aiStreamSSE('Tell me a story', {
 *   modelSelection: AI_CHAT_MODELS_WRITING,
 * }, abortController.signal);
 *
 * // In a Hono route (direct streaming to client):
 * for await (const chunk of stream.stream) {
 *   await res.write(chunk);
 * }
 *
 * // If you also need the clean accumulated text:
 * const cleanText = await parseSSEStreamContent(stream.stream);
 * ```
 */
/**
 * Finish reasons that mean the provider cleanly completed generation.
 * Anything else (including `unknown`, `length`, `content_filter`, `error`,
 * `timeout`, `cancelled`, `tool_calls`) is treated by {@link aiStreamSSE} as a
 * non-completion and triggers fallback to the next model/provider.
 *
 * Note: `unknown` is deliberately NOT in this set. Providers surface `unknown`
 * when the stream was cut off (connection reset, mid-stream drop) and the SDK
 * could not determine a real reason — exactly the silent-truncation symptom
 * observed in production. We fail those rather than ship a partial result.
 *
 * `finishReason` is only consulted when the provider actually reports it (it is
 * `null`/`undefined` for generators that don't surface one). When absent, the
 * `minOutputLength` / `validateOutput` guards provide the fallback safety net,
 * so providers that omit the field see no behavior change.
 */
const FINISH_REASONS_COMPLETE = new Set<string>([
  'stop',
  'complete',
  'completed',
  'stop_sequence',
  'end_turn',
  'finished',
  'final',
]);

/**
 * Whether a provider's `finishReason` indicates a clean completion.
 *
 * `null`/`undefined` is treated as complete (providers that omit the field see
 * no behavior change); any other value must be in the allow-list. This is the
 * same whitelist `aiStreamSSE` uses for its streaming completeness guard, lifted
 * here so the non-streaming `aiPrompt` engine can apply the identical check.
 */
export function isCompleteFinishReason(reason: string | null | undefined): boolean {
  if (reason == null) return true;
  return FINISH_REASONS_COMPLETE.has(reason.toLowerCase());
}

/**
 * Accumulates streaming `usage` + `finishReason` for a single generation and
 * serializes it back into the `StreamUsage | undefined` value a generator
 * returns when exhausted.
 *
 * Every streaming generator used to hand-roll `let usage` / `let finishReason`
 * plus an ad-hoc `return { ...(usage ?? {}), ...(finishReason ? { finishReason } : {}) }`
 * merge — duplicated across 6 generators, so any change to how finish reasons
 * are surfaced meant editing each one. This builder is the single place that
 * owns that shape. Returns `undefined` when nothing was captured (so the
 * orchestrator's `usage = value || undefined` stays correct) rather than an
 * empty `{}`, which also avoids a previously-hidden truthy-`{}` edge case.
 */
function createStreamUsageBuilder() {
  let usage: StreamUsage | undefined;
  let finishReason: string | undefined;

  return {
    /** Merge a partial usage payload (e.g. prompt/cached token counts). */
    setUsage(u: StreamUsage | undefined): void {
      if (u) usage = { ...usage, ...u };
    },
    /** Record the provider's stop reason; later/non-empty values win. */
    setFinishReason(fr: string | null | undefined): void {
      if (fr) finishReason = fr;
    },
    /** Serialize to the generator's `StreamUsage | undefined` return value. */
    build(): StreamUsage | undefined {
      if (!usage && !finishReason) return undefined;
      return { ...(usage ?? {}), ...(finishReason ? { finishReason } : {}) };
    },
  };
}

export async function aiStreamSSE(
  prompt: string, 
  options: AIPromptOptions = {},
  signal?: AbortSignal
): Promise<AIChatStreamResult> {
  const {
    modelSelection = AI_CHAT_MODELS_WRITING,
    config = AI_CHAT_CONFIG_DEFAULT,
    systemPrompt = PROMPT_SYSTEM,
    context,
    logPrompts = false,
    minOutputLength = 0,
    validateOutput,
  } = options;

  const providers = Object.keys(modelSelection) as AIChatProvider[];
  
  if (providers.length === 0) {
    const errorStream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(createErrorEvent('No providers configured')));
        controller.close();
      }
    });
    return { stream: errorStream };
  }

  const encoder = new TextEncoder();

  // Promise that resolves to the provider+model actually used for this stream.
  // Attached to the returned stream as `aiUsed` so callers can await it.
  let aiUsedResolve: (value: AIChatStreamProvider) => void;
  let aiUsedResolved = false;
  const aiUsed = new Promise<AIChatStreamProvider>((resolve) => {
    aiUsedResolve = resolve;
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let providerSucceeded = false;
      let abortHandler: (() => void) | null = null;
      
      // Handle abort signal
      if (signal) {
        abortHandler = () => {
          controller.close();
        };
        signal.addEventListener('abort', abortHandler);
      }
      
      try {
        for (const provider of providers) {
          if (providerSucceeded) break;
          
          // Check if aborted before starting next provider
          if (signal?.aborted) {
            controller.close();
            return;
          }
          
          const models = modelSelection[provider];
          if (!models || models.length === 0) continue; // Skip to next provider

          // Validate prompt length (incl. documents) against the provider's
          // max, and that its daily request budget isn't exhausted.
          //
          // BUG FIX: this gate previously measured only
          // `systemPrompt.length + prompt.length`, omitting `options.documents`
          // entirely — while the telemetry logged a few lines below it *did*
          // count them (see the totalDocumentsLength line there). A request
          // with sizeable documents could pass this gate for a provider whose
          // true total (with documents) exceeded AI_MAX_PROMPT_LENGTH, only to
          // fail against the provider's own limit mid-request. Both the
          // non-streaming (`aiPrompt`, ai-chat.ts) and streaming gates now
          // share this one measurement via assertPromptAllowed so they can't
          // re-diverge.
          const gate = await assertPromptAllowed(provider, systemPrompt, prompt, options.documents);
          if (!gate.allowed) {
            console.log(`[${provider}] ⏩ ${gate.reason}`);
            continue;
          }
          
          console.log(`[${provider}] 🧠 Starting SSE streaming task (${models.length} models)...`);
          
          const shouldLogPrompts = logPrompts;
          logAIPrompt(provider, '💬 Built user prompt', prompt, shouldLogPrompts);

          // Apply rate limiting before streaming
          await getRateLimiter(provider).throttle();

          // Try each model in the array for this provider
          for (const model of models) {
            if (providerSucceeded) break;
            
            // Check if aborted before trying next model
            if (signal?.aborted) {
              controller.close();
              return;
            }

            const opts: Partial<PromptWithFallbackOptions> = {
              ...options,
              models: [model],
              config,
              systemPrompt,
              logPrompts: shouldLogPrompts,
              signal,
            };
            
            try {
              // Pre-call check: Skip Gemini if the schema exceeds its constrained decoder limits.
              if (provider === 'gemini' && isSchemaTooComplex(options.outputJsonStructure)) {
                console.warn(`[gemini] ⏩ Skipping Gemini — schema exceeds complexity limits that Gemini's constrained decoder can compile`);
                continue;
              }

              // Establish stream connection with retry for retryable errors.
              // The generator creation + first .next() is retried together so that
              // each attempt gets a fresh HTTP connection. Only on success do we
              // send the start event and begin normal streaming.
              const { streamGenerator, firstResult } = await retryWithBackoff(
                async (): Promise<{
                  streamGenerator: AIStreamGenerator;
                  firstResult: IteratorResult<string, StreamUsage | void>;
                }> => {
                  let gen: AIStreamGenerator;

                  switch (provider) {
                    case 'gemini': gen = geminiStreamGenerator(prompt, opts); break;
                    case 'cohere': gen = cohereStreamGenerator(prompt, opts); break;
                    case 'mistral': gen = mistralStreamGenerator(prompt, opts); break;
                    case 'groq': gen = groqStreamGenerator(prompt, opts); break;
                    case 'cerebras': gen = cerebrasStreamGenerator(prompt, opts); break;
                    case 'nvidia': gen = nvidiaStreamGenerator(prompt, opts); break;
                    case 'openrouter': gen = openrouterStreamGenerator(prompt, opts); break;
                    case 'cloudflare': gen = cloudflareStreamGenerator(prompt, opts); break;
                    case 'inception': gen = inceptionStreamGenerator(prompt, opts); break;
                    case 'ovhcloud':    gen = ovhcloudStreamGenerator(prompt, opts); break;
                    case 'sambanova':   gen = sambanovaStreamGenerator(prompt, opts); break;
                    case 'ollama':      gen = ollamaStreamGenerator(prompt, opts); break;
                    case 'modelscope':  gen = modelscopeStreamGenerator(prompt, opts); break;
                    case 'zai':         gen = zaiStreamGenerator(prompt, opts); break;
                    case 'siliconflow': gen = siliconflowStreamGenerator(prompt, opts); break;
                    case 'aionlabs':    gen = aionlabsStreamGenerator(prompt, opts); break;
                    case 'chutes':      gen = chutesStreamGenerator(prompt, opts); break;
                    case 'llm7':        gen = llm7StreamGenerator(prompt, opts); break;
                    // TODO: wire new providers: ovhcloud, sambanova, ollama, modelscope, zai, siliconflow, aionlabs, chutes, llm7
                    default: throw new Error(`Unknown streaming provider: ${provider}`);
                  }

                  const first = await gen.next();
                  return { streamGenerator: gen, firstResult: first };
                },
                buildModelRetryConfig(provider, model),
              );

              // Connection established — send start event
              controller.enqueue(encoder.encode(createStartEvent(provider, model)));

              const requestStartedAt = Date.now();

              // Calculate estimated tokens for telemetry
              const promptChars = (options.systemPrompt?.length ?? 0) + prompt.length + sumDocumentChars(options.documents);
              let firstTokenAt: number | null = null;
              let usage: StreamUsage | undefined;
              let fullText = '';

              // Process the first result (if the generator finished immediately,
              // firstResult.done is true and its value holds the usage)
              if (firstResult.done) {
                usage = firstResult.value || undefined;
              } else {
                const chunk = firstResult.value;

                // Check if aborted during streaming
                if (signal?.aborted) {
                  controller.close();
                  return;
                }

                // Track TTFT
                if (!firstTokenAt && chunk.length > 0) {
                  firstTokenAt = Date.now();
                }

                // Handle backpressure
                await handleBackpressure(controller);

                fullText += chunk;
                controller.enqueue(encoder.encode(createTextChunkEvent(chunk)));
              }

              // Continue streaming remaining chunks (if not already done)
              if (!firstResult.done) {
                try {
                  while (true) {
                    const { value, done } = await streamGenerator.next();

                    if (done) {
                      usage = value || undefined;  // generator's return value, if any
                      break;
                    }

                    const chunk = value; // value is `string` while done === false

                    // Check if aborted during streaming
                    if (signal?.aborted) {
                      controller.close();
                      return;
                    }

                    // Track TTFT
                    if (!firstTokenAt && chunk.length > 0) {
                      firstTokenAt = Date.now();
                    }

                    // Handle backpressure
                    await handleBackpressure(controller);

                    fullText += chunk;
                    controller.enqueue(encoder.encode(createTextChunkEvent(chunk)));
                  }
                } catch (streamError) {
                  console.log(`[${provider}] ⚠️ Model ${model} streaming error after first chunk:`, getErrorMessage(streamError));
                  controller.enqueue(encoder.encode(createProviderErrorEvent(`Model ${model} streaming failed: ${getErrorMessage(streamError)}`)));
                  // Mid-stream errors are not retried — continue to next model
                  continue;
                }
              }

              // Completeness validation: a provider stream that ends (cleanly surfaced
              // `done`) is NOT automatically success. A truncated response, a silent
              // connection reset, or a mid-stream drop can all surface as a normal
              // `done`, in which case shipping the partial output would corrupt the
              // client UI (and, for /prompt, get cached as a "good" prompt). We reject
              // the result when ANY guard fails and fall through to the next
              // model/provider:
              //   - `finishReason`: the provider's own stop signal. A value other than
              //     an explicit completion reason (e.g. `unknown`, `length`,
              //     `content_filter`) means the stream did NOT finish cleanly — this is
              //     the strongest, provider-attested completeness signal and the
              //     definitive fix for silently-truncated streams (Vercel logs showed
              //     `finishReason: "unknown"` on the broken `/prompt` responses).
              //   - `minOutputLength`: raw length floor (prose streams).
              //   - `validateOutput`: caller-supplied semantic check (JSON streams).
              const trimmedLength = fullText.trim().length;
              const tooShort = minOutputLength > 0 && trimmedLength < minOutputLength;
              let invalid = false;
              try {
                invalid = !!(validateOutput && !validateOutput(fullText));
              } catch (validationError) {
                console.warn(`[${provider}] ⚠️ Model ${model} validateOutput threw — treating as failure:`, getErrorMessage(validationError));
                invalid = true;
              }
              const finishReason = usage?.finishReason ?? null;
              // Providers are inconsistent about casing (OpenAI uses `stop`,
              // Gemini uses `STOP`), so normalize before the whitelist check.
              const incompleteFinish = finishReason != null && !FINISH_REASONS_COMPLETE.has(finishReason.toLowerCase());
              if (tooShort || invalid || incompleteFinish) {
                const reason = incompleteFinish
                  ? `finishReason "${finishReason}" is not a clean completion`
                  : tooShort
                    ? `output too short (${trimmedLength} < ${minOutputLength} chars)`
                    : `validateOutput rejected result`;
                console.warn(`[${provider}] ⚠️ Model ${model} stream ended but ${reason} — treating as failure, trying next`);
                controller.enqueue(encoder.encode(createProviderErrorEvent(`Model ${model} returned truncated output`)));
                continue;
              }

              // Send end event
              controller.enqueue(encoder.encode(createEndEvent(provider, model)));
              providerSucceeded = true;

              const completedAt = Date.now();

              // Log telemetry
              logGenerationTelemetry({
                provider,
                model,
                context: options.context,
                promptChars,
                estimatedPromptTokens: estimateTokens(promptChars),
                requestStartedAt,
                firstTokenAt,
                completedAt,
                ttftMs: firstTokenAt ? firstTokenAt - requestStartedAt : null,
                generationMs: firstTokenAt ? completedAt - firstTokenAt : null,
                cachedTokens: usage?.cachedTokens,
                cacheHitRate: (usage?.promptTokens && usage?.cachedTokens != null)
                  ? usage.cachedTokens / usage.promptTokens
                  : undefined,
              });

              // Resolve aiUsed promise with selected provider/model
              try {
                if (!aiUsedResolved) {
                  aiUsedResolved = true;
                  aiUsedResolve({ provider, model });
                }
              } catch {
                // ignore
              }

              // Log success and increment usage with telemetry metrics
              const durationMs = completedAt - requestStartedAt;
              logAISuccess({ provider, model, output: '[SSE Stream]', result: '[SSE Stream]', durationMs });
              await incrementDailyUsageCount(provider, context ?? 'ai-stream-sse', {
                model,
                inputTokens: usage?.promptTokens,
                cachedTokens: usage?.cachedTokens,
                durationMs,
              });
              break; // Success - break out of model loop
            } catch (error) {
              console.log(`[${provider}] ⚠️ Model ${model} failed:`, getErrorMessage(error));
              controller.enqueue(encoder.encode(createProviderErrorEvent(`Model ${model} failed: ${getErrorMessage(error)}`)));
              // Continue to next model in the array
            }
          }
        }
        
        if (!providerSucceeded) {
          controller.enqueue(encoder.encode(createErrorEvent('All providers failed')));
        }

        controller.close();
      } finally {
        // Clean up event listener to prevent memory leak
        if (abortHandler && signal) {
          signal.removeEventListener('abort', abortHandler);
        }

        // If no provider/model was chosen, resolve aiUsed with null
        try {
          if (!aiUsedResolved) {
            aiUsedResolved = true;
            aiUsedResolve(null);
          }
        } catch {
          // ignore
        }
      }
    }
  });

  // Attach metadata promise to stream for callers to inspect which AI provider/model was used.
  return { stream, provider: aiUsed };

}

/**
 * Creates a streaming generator for any OpenAI Chat Completions–compatible
 * provider. Every currently-wired OpenAI-compatible streaming provider is a
 * one-line call to this factory — see the export block below it. (GitHub
 * Models used to be the 4th; removed after its 2026-07-30 retirement, which
 * is also why this doc comment no longer names it as the example.)
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
    const { signal, context, config = AI_CHAT_CONFIG_DEFAULT, outputAsJson, outputJsonStructure, outputJsonRequired } = options;
    const systemPromptWithDocuments = formatSystemPromptWithDocuments(provider, options);

    const model = options.models?.[0] || defaultModel;
    const stream = await getClient().chat.completions.create({
      model,
      messages: buildChatMessages(systemPromptWithDocuments, prompt),
      stream: true,
      stream_options: { include_usage: true },
      ...buildSamplingParams(provider, model, config),
      response_format: buildOpenAIResponseFormat(context, outputAsJson, outputJsonStructure, outputJsonRequired),
    } satisfies OpenAI.ChatCompletionCreateParamsStreaming, { signal });

    const usageBuilder = createStreamUsageBuilder();

    for await (const chunk of stream) {
      if (signal?.aborted) return usageBuilder.build();

      // Final chunk (stream_options.include_usage) has usage + empty choices
      if (chunk.usage) {
        usageBuilder.setUsage({
          promptTokens: chunk.usage.prompt_tokens,
          cachedTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
        });
      }

      // Capture the provider's stop signal for completeness validation.
      const fr = (chunk as { choices?: Array<{ finish_reason?: string }> | null })?.choices?.[0]?.finish_reason;
      usageBuilder.setFinishReason(fr);

      const delta = extractDeltaText(chunk);
      if (delta) yield delta;
    }

    // Always surface finishReason to the orchestrator; when no usage chunk
    // arrived we still want the stop reason so truncation can be detected.
    return usageBuilder.build();
  };
}

export const openrouterStreamGenerator = createOpenAICompatibleStreamGenerator('openrouter', getOpenRouterClient, AI_STREAM_DEFAULT_MODEL.openrouter);
export const cloudflareStreamGenerator = createOpenAICompatibleStreamGenerator('cloudflare', getCloudflareClient, AI_STREAM_DEFAULT_MODEL.cloudflare);
export const inceptionStreamGenerator = createOpenAICompatibleStreamGenerator('inception', getInceptionClient, AI_STREAM_DEFAULT_MODEL.inception);

/**
 * Providers wired 2026-08-13 — same one-line factory pattern, see
 * ai-chat.ts's matching provider block for the shared rationale (all 9 are
 * OpenAI-compatible; Chutes' `getChutesClient()` base URL needs the
 * `/chat/completions` suffix removed).
 */
export const ovhcloudStreamGenerator = createOpenAICompatibleStreamGenerator('ovhcloud', getOvhcloudClient, AI_STREAM_DEFAULT_MODEL.ovhcloud);
export const sambanovaStreamGenerator = createOpenAICompatibleStreamGenerator('sambanova', getSambanovaClient, AI_STREAM_DEFAULT_MODEL.sambanova);
export const ollamaStreamGenerator = createOpenAICompatibleStreamGenerator('ollama', getOllamaClient, AI_STREAM_DEFAULT_MODEL.ollama);
export const modelscopeStreamGenerator = createOpenAICompatibleStreamGenerator('modelscope', getModelscopeClient, AI_STREAM_DEFAULT_MODEL.modelscope);
export const zaiStreamGenerator = createOpenAICompatibleStreamGenerator('zai', getZaiClient, AI_STREAM_DEFAULT_MODEL.zai);
export const siliconflowStreamGenerator = createOpenAICompatibleStreamGenerator('siliconflow', getSiliconflowClient, AI_STREAM_DEFAULT_MODEL.siliconflow);
export const aionlabsStreamGenerator = createOpenAICompatibleStreamGenerator('aionlabs', getAionlabsClient, AI_STREAM_DEFAULT_MODEL.aionlabs);
export const chutesStreamGenerator = createOpenAICompatibleStreamGenerator('chutes', getChutesClient, AI_STREAM_DEFAULT_MODEL.chutes);
export const llm7StreamGenerator = createOpenAICompatibleStreamGenerator('llm7', getLlm7Client, AI_STREAM_DEFAULT_MODEL.llm7);

/**
 * Gemini streaming generator via the `generateContent` API that yields chunks.
 *
 * Kept alongside {@link geminiStreamGeneratorViaInteractions} specifically for its explicit-caching
 * support (`cachedContentId` → {@link getOrCreateGeminiCache} → `cachedContent`) — the Interactions
 * API does not support explicit caching as of 2026-08-12. See {@link geminiStreamGenerator}'s comment
 * for the dispatch logic.
 */
async function* geminiStreamGeneratorViaGenerateContent(
  prompt: string,
  options: Partial<PromptWithFallbackOptions>
): AIStreamGenerator {
  const { signal, config = AI_CHAT_CONFIG_DEFAULT, outputAsJson, outputJsonStructure, outputJsonRequired } = options;
  const systemPromptWithDocuments = formatSystemPromptWithDocuments('gemini', options);
  const responseJsonSchema = buildGeminiResponseJsonSchema(outputAsJson, outputJsonStructure, outputJsonRequired);

  // Helper block to fulfill Gemini's minimum token requirement for explicit caching
  const model = resolveStreamDefaultModel('gemini', options);
  const cachedContent = await resolveGeminiCachedContent(options, model);

  // Penalty is not enabled for models/gemini-2.5-flash
  const { geminiConfig, maxOutputToken } = buildGeminiConfig(config);

  const response = await getGeminiClient().models.generateContentStream({
    model,
    contents: [{ parts: [{ text: prompt }] }],
    config: {
      ...geminiConfig,
      ...(outputAsJson ? { responseMimeType: 'application/json' } : {}),
      maxOutputTokens: getMaxOutputToken('gemini', model, maxOutputToken),
      responseSchema: responseJsonSchema ? convertToGeminiSchema(responseJsonSchema, { minify: true }) : undefined,
      // responseJsonSchema,
      // Cache hit path — send only the dynamic prompt
      ...(cachedContent ? { cachedContent } : {
        // Cache miss or unnecessary — do full request (Gemini caches this automatically)
        systemInstruction: { parts: [{ text: systemPromptWithDocuments }] },
      })
    } satisfies GenerateContentConfig,
  } satisfies GenerateContentParameters);
  
  const usageBuilder = createStreamUsageBuilder();

  for await (const chunk of response) {
    if (signal?.aborted) break;

    // Gemini sends cumulative usageMetadata on each chunk; the last one
    // received before the stream ends holds the final totals.
    if (chunk.usageMetadata) {
      usageBuilder.setUsage({
        promptTokens: chunk.usageMetadata.promptTokenCount,
        cachedTokens: chunk.usageMetadata.cachedContentTokenCount,
      });
    }

    usageBuilder.setFinishReason(chunk.candidates?.[0]?.finishReason);

    if (chunk.candidates?.[0]?.content?.parts) {
      const text = chunk.candidates[0].content.parts
        .filter((p) => typeof p?.text === 'string')
        .map((p) => p.text)
        .join('');
      if (text) yield text;
    }
  }

  return usageBuilder.build();
}

/**
 * Minimal local shape for the SSE event fields this file actually reads from
 * an Interactions API stream. See the matching comment on
 * `GeminiInteractionResponse` in ai-chat.ts for why this is declared locally
 * rather than imported, and the SDK version requirement (`@google/genai`
 * >= 2.3.0). Sourced from https://ai.google.dev/api/interactions-api (the
 * `InteractionSseEvent` / `StepDelta` / `TextDelta` resources), fetched
 * 2026-08-12 — this is a beta (`v1beta`) endpoint, re-verify if behavior
 * looks off.
 */
interface GeminiInteractionStreamUsage {
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_cached_tokens?: number;
  total_tokens?: number;
}
interface GeminiInteractionStreamEvent {
  event_type: 'interaction.created' | 'interaction.status_update' | 'step.start' | 'step.delta' | 'step.stop' | 'interaction.completed' | 'error';
  delta?: { type: string; text?: string; [key: string]: unknown };
  interaction?: { id?: string; status?: string; usage?: GeminiInteractionStreamUsage };
  error?: { code?: string; message?: string };
  [key: string]: unknown;
}

/**
 * Gemini streaming generator via the Interactions API
 * (https://ai.google.dev/gemini-api/docs/interactions-overview). Streams
 * through the *same* `interactions.create()` call as the non-streaming path
 * (with `stream: true`) rather than a separate endpoint.
 *
 * NOT wired into {@link geminiStreamGenerator} by default — see
 * `geminiPromptViaInteractions`'s doc comment in ai-chat.ts for the two
 * unconfirmed behaviors (temperature/top_p/top_k support, and contradictory
 * safety-settings documentation) that apply identically here. Verify both
 * before routing real traffic through this function.
 *
 * Always passes `store: false` — no conversation continuity needed for
 * Twistloom's single-shot generation calls, and explicit caching (what
 * `cachedContentId` currently buys you) isn't available on this API yet.
 */
export async function* geminiStreamGeneratorViaInteractions(
  prompt: string,
  options: Partial<PromptWithFallbackOptions>
): AIStreamGenerator {
  const { signal, config = AI_CHAT_CONFIG_DEFAULT, outputAsJson, outputJsonStructure, outputJsonRequired } = options;
  const systemPromptWithDocuments = formatSystemPromptWithDocuments('gemini', options);
  const model = resolveStreamDefaultModel('gemini', options);

  // SDK param type name unconfirmed (see comment above) — cast at the call
  // boundary only; the stream's events are fully typed against
  // GeminiInteractionStreamEvent below.
  const stream = await (getGeminiClient() as any).interactions.create({
    model,
    input: prompt,
    system_instruction: systemPromptWithDocuments,
    store: false,
    stream: true,
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
      // doc-gap warning on geminiPromptViaInteractions in ai-chat.ts.
    },
  }) as AsyncIterable<GeminiInteractionStreamEvent>;

  const usageBuilder = createStreamUsageBuilder();

  for await (const event of stream) {
    if (signal?.aborted) break;

    if (event.event_type === 'step.delta' && event.delta?.type === 'text' && typeof event.delta.text === 'string') {
      if (event.delta.text) yield event.delta.text;
    } else if (event.event_type === 'interaction.completed') {
      const finalUsage = event.interaction?.usage;
      if (finalUsage) {
        usageBuilder.setUsage({
          promptTokens: finalUsage.total_input_tokens,
          cachedTokens: finalUsage.total_cached_tokens,
        });
      }
    } else if (event.event_type === 'error') {
      throw new Error(`[gemini/interactions] ${event.error?.code}: ${event.error?.message}`);
    }
  }

  return usageBuilder.build();
}

/**
 * Gemini streaming generator that yields chunks.
 *
 * Currently always delegates to {@link geminiStreamGeneratorViaGenerateContent}.
 * {@link geminiStreamGeneratorViaInteractions} is fully implemented and
 * exported separately for testing, but not wired in here yet — see its doc
 * comment for what to verify first (temperature/top_p/top_k support and
 * contradictory safety-settings documentation). Once confirmed, branching
 * this on `options.cachedContentId` (Interactions when absent, since explicit
 * caching still requires the generateContent path) is a one-line change.
 */
async function* geminiStreamGenerator(
  prompt: string,
  options: Partial<PromptWithFallbackOptions>
): AIStreamGenerator {
  return yield* geminiStreamGeneratorViaGenerateContent(prompt, options);
}

/**
 * Groq streaming generator that yields chunks.
 *
 * BUG FIX: previously typed `AsyncGenerator<string>` with no return value and
 * no usage capture at all — unlike Gemini and the OpenAI-compatible factory
 * (openrouter/cloudflare/inception/the 9 newer providers), which both track
 * and return {@link StreamUsage}. Groq's REST API is itself OpenAI-compatible
 * and honors the same `stream_options: { include_usage: true }` contract the
 * factory already relies on, so this now captures it the same way. Before
 * this fix, every Groq *streaming* call (the non-streaming `groqPrompt` was
 * unaffected) recorded null input/output token counts in the usage ledger —
 * worth spot-checking your `usage` table for Groq rows with previously-null
 * `promptTokens`/`cachedTokens` after this ships.
 *
 * If `stream_options` isn't recognized by your installed `groq-sdk` version's
 * `ChatCompletionCreateParamsStreaming` type, that means Groq's SDK types
 * haven't caught up with the (documented, OpenAI-compatible) API surface —
 * cast the request object at the call boundary rather than dropping the
 * field, the same way this file already does for Gemini's Interactions API.
 */
async function* groqStreamGenerator(
  prompt: string,
  options: Partial<PromptWithFallbackOptions>
): AIStreamGenerator {
  const { signal, context, config = AI_CHAT_CONFIG_DEFAULT, outputAsJson, outputJsonStructure, outputJsonRequired } = options;
  const systemPromptWithDocuments = formatSystemPromptWithDocuments('groq', options);

  const model = resolveStreamDefaultModel('groq', options);
  const stream = await getGroqClient().chat.completions.create({
    messages: buildChatMessages(systemPromptWithDocuments, prompt),
    model,
    stream: true,
    stream_options: { include_usage: true },
    ...buildSamplingParams('groq', model, config),
    response_format: buildOpenAIResponseFormat(context, outputAsJson, outputJsonStructure, outputJsonRequired),
  // 1. Cast the payload instead of using `satisfies` to bypass the missing `stream_options` type
  // } satisfies Groq.ChatCompletionCreateParamsStreaming, { signal });
  } as Groq.ChatCompletionCreateParamsStreaming & { stream_options?: { include_usage: boolean } }, { signal });

  const usageBuilder = createStreamUsageBuilder();

  for await (const chunk of stream) {
    if (signal?.aborted) return usageBuilder.build();

    // 2. Cast chunk to `any` to bypass the missing `usage` type on ChatCompletionChunk.
    // 3. Add a fallback to `x_groq?.usage` to catch Groq's custom metadata wrapper.
    const rawChunk = chunk as any;
    const chunkUsage = rawChunk.usage || rawChunk.x_groq?.usage;

    // if (chunk.usage) {
    if (chunkUsage) {
      usageBuilder.setUsage({
        promptTokens: chunkUsage.prompt_tokens,
        cachedTokens: chunkUsage.prompt_tokens_details?.cached_tokens ?? 0,
      });
    }

    usageBuilder.setFinishReason(rawChunk?.choices?.[0]?.finish_reason);

    const delta = extractDeltaText(chunk);
    if (delta) yield delta;
  }

  return usageBuilder.build();
}

/**
 * Cohere streaming generator that yields chunks
 */
/**
 * Cohere streaming generator that yields chunks.
 *
 * BUG FIX: previously typed `AsyncGenerator<string>` with no usage capture —
 * same gap as {@link groqStreamGenerator} above. Cohere's V2 chat-stream event
 * taxonomy (content-start → content-delta → content-end → message-end) sends
 * cumulative usage on the final `message-end` event, in the same
 * `{ tokens, billedUnits, cachedTokens }` shape the non-streaming `coherePrompt`
 * already reads from `response.usage` — this reads it from
 * `event.delta.usage` instead, since it arrives as part of the terminal
 * event's delta rather than a top-level response field. Verify against a live
 * stream if the shape looks different from what's below; this wasn't
 * re-confirmed against a live response as part of this refactor.
 */
async function* cohereStreamGenerator(
  prompt: string,
  options: Partial<PromptWithFallbackOptions>
): AIStreamGenerator {
  const { signal, documents, config = AI_CHAT_CONFIG_DEFAULT, context, outputAsJson, outputJsonStructure, outputJsonRequired } = options;
  const model = resolveStreamDefaultModel('cohere', options);
  const stream = await getCohereClient().chatStream({
    model,
    messages: buildChatMessages(formatSystemPromptWithDocuments('cohere', options), prompt),
    documents: mapCohereDocuments(documents),
    maxTokens: getMaxOutputToken('cohere', model, config.maxOutputToken),
    temperature: config.temperature,
    p: config.topP,
    k: config.topK,
    stopSequences: config.stopSequences,
    frequencyPenalty: config.frequencyPenalty,
    seed: config.seed,
    responseFormat: buildCohereResponseFormat({ context, outputAsJson, outputJsonStructure, outputJsonRequired }) as Cohere.ResponseFormatV2 | undefined,
  } satisfies Cohere.V2ChatStreamRequest);

  const usageBuilder = createStreamUsageBuilder();

  for await (const chunk of stream) {
    if (signal?.aborted) return usageBuilder.build();
    if (chunk.type === 'content-delta') {
      const text = chunk.delta?.message?.content?.text || '';
      if (text) yield text;
    } else if (chunk.type === 'message-end') {
      // Loosely typed rather than naming a specific Cohere SDK type here —
      // the exact exported type name for this shape wasn't confirmed (the
      // non-streaming coherePrompt's extractUsage never needs to name it
      // explicitly either, since it flows from response.usage by inference).
      // If your installed cohere-ai version exports a named Usage type,
      // feel free to swap this for it.
      const chunkUsage = (chunk as { delta?: { usage?: { tokens?: { inputTokens?: number }; cachedTokens?: number } } }).delta?.usage;
      if (chunkUsage) {
        usageBuilder.setUsage({
          promptTokens: chunkUsage.tokens?.inputTokens,
          cachedTokens: chunkUsage.cachedTokens,
        });
      }
      usageBuilder.setFinishReason((chunk as { delta?: { finishReason?: string } }).delta?.finishReason);
    }
  }

  return usageBuilder.build();
}

/**
 * Cerebras streaming generator that yields chunks.
 *
 * BUG FIX: previously typed `AsyncGenerator<string>` with no usage capture —
 * same gap as {@link groqStreamGenerator}/{@link cohereStreamGenerator} above.
 * Requests `stream_options: { include_usage: true }` on the same
 * OpenAI-compatible assumption as Groq (see that function's doc comment for
 * the "verify against your installed SDK types" caveat — applies here too),
 * and reads the final chunk's `usage` field defensively (via a runtime
 * check rather than a static type, since neither `ChatChunkResponse` nor
 * `ErrorChunkResponse` above declare a `usage` field in what's imported
 * here) rather than assuming a shape that wasn't confirmed against a live
 * response.
 */
async function* cerebrasStreamGenerator(
  prompt: string,
  options: Partial<PromptWithFallbackOptions>
): AIStreamGenerator {
  const { signal, context, config = AI_CHAT_CONFIG_DEFAULT, outputAsJson, outputJsonStructure, outputJsonRequired } = options;
  const systemPromptWithDocuments = formatSystemPromptWithDocuments('cerebras', options);

  const model = resolveStreamDefaultModel('cerebras', options);
  const stream = await getCerebrasClient().chat.completions.create({
    model,
    messages: buildChatMessages(systemPromptWithDocuments, prompt),
    stream: true,
    stream_options: { include_usage: true },
    ...buildSamplingParams('cerebras', model, config),
    response_format: buildOpenAIResponseFormat(context, outputAsJson, outputJsonStructure, outputJsonRequired),
  } satisfies Cerebras.ChatCompletionCreateParamsStreaming, { signal });

  const usageBuilder = createStreamUsageBuilder();

  for await (const chunk of stream) {
    if (signal?.aborted) return usageBuilder.build();
    const chunkTyped = chunk as Cerebras.ChatCompletion.ChatChunkResponse | Cerebras.ChatCompletion.ErrorChunkResponse;
    if ('usage' in chunkTyped && chunkTyped.usage) {
      // Same camelCase-normalization fix as cerebrasPrompt's non-streaming
      // extractUsage (ai-chat.ts) — Cerebras's wire fields are snake_case.
      const rawUsage = chunkTyped.usage as { prompt_tokens?: number };
      usageBuilder.setUsage({ promptTokens: rawUsage.prompt_tokens });
    }
    if ('choices' in chunkTyped) {
      const choices = chunkTyped.choices as Array<Cerebras.ChatCompletion.ChatChunkResponse.Choice> | null;
      usageBuilder.setFinishReason(choices?.[0]?.finish_reason);
      const delta = choices?.[0]?.delta?.content || '';
      if (delta) yield delta;
    } else if ('error' in chunkTyped) {
      // Handle error chunk - log and skip without terminating stream
      const { error, status_code } = chunkTyped as Cerebras.ChatCompletion.ErrorChunkResponse;
      const errorMessage = error?.message || 'Unknown Cerebras error';
      console.warn(`[cerebras] ⚠️ Error chunk (${status_code}):`, errorMessage);
      // Skip this chunk and continue streaming
    } else {
      // Unexpected chunk type - log warning and skip
      console.warn('[cerebras] ⚠️ Unexpected chunk type:', chunk);
    }
  }

  return usageBuilder.build();
}

/**
 * Mistral streaming generator that yields chunks.
 *
 * BUG FIX: previously typed `AsyncGenerator<string>` with no usage capture —
 * same gap as the other three fixed above. Mistral's streaming chunks carry
 * the same `usage` shape as the non-streaming response
 * (`{ promptTokens, completionTokens, totalTokens }`, per `mistralPrompt`'s
 * extractUsage in ai-chat.ts) on the terminal `chunk.data.usage` — not
 * re-confirmed against a live stream as part of this refactor, verify if the
 * shape looks off.
 */
async function* mistralStreamGenerator(
  prompt: string,
  options: Partial<PromptWithFallbackOptions>
): AIStreamGenerator {
  const { signal, config = AI_CHAT_CONFIG_DEFAULT, outputAsJson, outputJsonStructure, outputJsonRequired, cachedContentId, context } = options;
  const { maxOutputToken, temperature, topP, stopSequences, frequencyPenalty, seed } = config;
  const systemPromptWithDocuments = formatSystemPromptWithDocuments('mistral', options);

  const model = resolveStreamDefaultModel('mistral', options);
  const stream = await getMistralClient().chat.stream({
    model,
    messages: buildChatMessages(systemPromptWithDocuments, prompt),
    maxTokens: getMaxOutputToken('mistral', model, maxOutputToken),
    temperature,
    topP,
    stop: stopSequences,
    frequencyPenalty,
    randomSeed: seed,
    stream: true,
    // Cache key mirrors Gemini's cachedContentId — see buildMistralPromptCacheKey's doc comment (ai-chat.ts).
    promptCacheKey: buildMistralPromptCacheKey(cachedContentId),
    responseFormat: buildMistralResponseFormat({ context, outputAsJson, outputJsonStructure, outputJsonRequired }) as Mistral.ChatCompletionStreamRequest['responseFormat'],
  } satisfies Mistral.ChatCompletionStreamRequest, { signal });

  const usageBuilder = createStreamUsageBuilder();

  for await (const chunk of stream) {
    if (signal?.aborted) return usageBuilder.build();

    const rawDelta = chunk.data.choices[0]?.delta?.content;
    if (Array.isArray(rawDelta)) {
      const nonStringItems = rawDelta.filter(d => typeof d !== 'string');
      if (nonStringItems.length > 0) {
        console.warn('[mistral] ⚠️ Delta contains non-string items:', nonStringItems);
      }
    }
    const text = extractDeltaText(chunk.data);
    if (text) yield text;

    usageBuilder.setFinishReason(chunk.data.choices?.[0]?.finishReason);

    const chunkUsage = (chunk.data as { usage?: { promptTokens?: number } }).usage;
    if (chunkUsage) {
      usageBuilder.setUsage({ promptTokens: chunkUsage.promptTokens });
    }
  }

  return usageBuilder.build();
}

/**
 * NVIDIA streaming generator that yields chunks
 * @see https://docs.api.nvidia.com/nim/reference/mistralai-mixtral-8x22b-instruct-infer
 */
async function* nvidiaStreamGenerator(
  prompt: string,
  options: Partial<PromptWithFallbackOptions>
): AsyncGenerator<string> {
  const { signal, config = AI_CHAT_CONFIG_DEFAULT } = options;
  const systemPromptWithDocuments = formatSystemPromptWithDocuments('nvidia', options);

  const model = resolveStreamDefaultModel('nvidia', options);
  const { response: res, signal: combinedSignal } = await nvidiaChatRequest({
    model,
    messages: buildChatMessages(systemPromptWithDocuments, prompt),
    stream: true,
    ...buildSamplingParams('nvidia', model, config),
  }, signal);

  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  
  if (reader) {
    try {
      while (true) {
        if (combinedSignal?.aborted) return;
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        
        // Split by double newline to get complete SSE events
        const events = buffer.split('\n\n');
        buffer = events.pop() || ''; // Keep incomplete event in buffer
        
        for (const event of events) {
          const lines = event.split('\n').filter(line => line.trim().startsWith('data:'));
          
          for (const line of lines) {
            const jsonStr = line.trim().slice(5); // Remove 'data:' prefix
            if (jsonStr === '[DONE]') continue;
            
            try {
              const data = JSON.parse(jsonStr);
              if (!data.choices || !data.choices[0]) {
                console.warn('[nvidia] ⚠️ Response missing choices:', data);
                continue;
              }
              const delta = data.choices[0]?.delta?.content || '';
              if (delta) yield delta;
            } catch (e) {
              console.warn('[nvidia] ⚠️ Failed to parse SSE chunk:', getErrorMessage(e));
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

/**
 * Shared SSE line-buffering + `data:` JSON text-extraction core.
 *
 * SSE frames are newline-delimited, but a TCP/HTTP chunk can split a frame
 * mid-line, so we keep the incomplete trailing line in `lineBuffer` across
 * reads and only evaluate complete lines. For each complete `data: ` line we
 * JSON-parse the payload and, when it carries a string `content`, append it to
 * the accumulated text — silently skipping the `[DONE]` sentinel and any
 * unparseable/partial line.
 *
 * This is the single source of truth for turning our wire format
 * (`event: chunk\ndata: {"type":"chunk","content":"..."}`) into clean text,
 * used by both {@link parseSSEStreamContent} (accumulate only) and
 * {@link pipeSSEStreamAndExtractText} (accumulate + forward bytes live).
 * Keeping it in one place means frame-boundary / decoding fixes apply everywhere.
 *
 * Note: this parser is protocol-specific to Twistloom's SSE format, which
 * terminates with `event: end` / `event: done` (see `sse.ts`), NOT the OpenAI
 * `data: [DONE]` sentinel. The OpenAI `[DONE]` convention is handled where it
 * actually occurs — the NVIDIA generator, which proxies OpenAI-style streams —
 * and is intentionally not recognized here. Any malformed/partial `data:` line
 * is simply skipped via the `JSON.parse` try/catch below.
 *
 * @param stream - SSE byte stream
 * @param onChunk - optional callback invoked once per raw byte chunk *before*
 *   extraction (the piping variant uses it to forward bytes to the client);
 *   may be async. Omit for accumulate-only parsing.
 * @returns the accumulated clean text (untrimmed)
 */
async function extractSseText(
  stream: ReadableStream<Uint8Array>,
  onChunk?: (chunk: Uint8Array) => Promise<unknown> | unknown,
): Promise<string> {
  let text = "";
  let lineBuffer = "";
  let currentEventType: string | null;
  const decoder = new TextDecoder();

  for await (const chunk of stream) {
    if (onChunk) await onChunk(chunk);
    lineBuffer += decoder.decode(chunk, { stream: true });

    // Split by newlines while preserving incomplete trailing line in lineBuffer
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('event: ')) {
        currentEventType = trimmed.slice(7).trim();
        // A `start` (new provider attempt), `provider_error` (non-terminal
        // fallback), or `error` (terminal failure) marks a boundary: any text
        // streamed so far came from a provider that will NOT contribute the
        // final output. Discard it so the extracted text is never a
        // partial+full concatenation (which would corrupt cached prompts). The
        // next provider re-streams the full output from scratch.
        if (
          currentEventType === 'start' ||
          currentEventType === 'error' ||
          currentEventType === 'provider_error'
        ) {
          text = '';
        }
      } else if (trimmed.startsWith('data: ')) {
        const rawJson = trimmed.slice(6);
        try {
          const data = JSON.parse(rawJson);
          if (typeof data.content === 'string') text += data.content;
        } catch {
          // Skip partial or non-JSON SSE lines
        }
      }
    }
  }

  // Process any remaining buffered text
  if (lineBuffer.trim().startsWith('data: ')) {
    const rawJson = lineBuffer.trim().slice(6);
    try {
      const data = JSON.parse(rawJson);
      if (typeof data.content === 'string') text += data.content;
    } catch {
      // Ignore trailing partial chunk
    }
  }

  return text;
}

/**
 * Parses SSE-formatted chunks and extracts text content
 * 
 * This function consumes an SSE stream and extracts the actual text content
 * from the JSON-formatted chunks. It handles the SSE format where each chunk
 * contains a JSON payload with type, content, and done fields.
 * 
 * @param stream - ReadableStream of SSE-formatted Uint8Array chunks
 * @returns Promise resolving to the concatenated text content
 */
export async function parseSSEStreamContent(stream: ReadableStream<Uint8Array>): Promise<string> {
  return extractSseText(stream);
}

/**
 * Pipes an SSE ReadableStream to an output writer callback while simultaneously
 * extracting and accumulating the clean text content from `data.content` in real-time.
 *
 * @param stream - ReadableStream of SSE-formatted Uint8Array chunks
 * @param writeChunk - Callback to write each binary chunk (e.g. `chunk => stream.write(chunk)`)
 * @returns Promise resolving to the clean accumulated text (trimmed)
 */
export async function pipeSSEStreamAndExtractText(
  stream: ReadableStream<Uint8Array>,
  writeChunk: (chunk: Uint8Array) => Promise<unknown> | unknown
): Promise<string> {
  // Forward each raw byte chunk live to the client, then extract the same
  // clean text that parseSSEStreamContent would. Trimmed on return to match
  // the historical contract (callers cache/compare the trimmed value).
  return (await extractSseText(stream, writeChunk)).trim();
}