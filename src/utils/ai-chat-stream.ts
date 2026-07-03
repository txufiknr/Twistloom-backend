import type { AIChatProvider, AIDocument, AIJsonProperty, AIPromptOptions, AIStreamGenerator, PromptWithFallbackOptions, StreamUsage } from "../types/ai-chat.js";
import { getCerebrasClient, getCloudflareClient, getCohereClient, getGeminiClient, getGitHubClient, getGroqClient, getMistralClient, getOpenRouterClient } from "./ai-clients.js";
import { AI_CHAT_CONFIG_DEFAULT, NVIDIA_REQUEST_TIMEOUT_MS } from "../config/ai-chat.js";
import { AI_CHAT_MODELS_WRITING, AI_MAX_PROMPT_LENGTH } from "../config/ai-clients.js";
import { canUseAIToday, getRateLimiter, incrementDailyUsageCount } from './ai-limiters.js';
import { requireEnv } from "./env.js";
import { PROMPT_SYSTEM } from "./prompt.js";
import { logAISuccess } from './ai-logger.js';
import { classifyGenAIError, getErrorMessage, isGenAIErrorRetryable } from "./error.js";
import { retryWithBackoff } from "./retry.js";
import { AI_CHAT_MODEL_RETRY_COUNT } from "../config/ai-chat.js";
import { createTextChunkEvent, createErrorEvent, createStartEvent, createEndEvent, handleBackpressure } from "./sse.js";
import { formatDocumentsToPrompt, formatSystemPromptWithDocuments, logPromptWithSeparators } from "./ai-chat.js";
import { type GenerateContentConfig, type GenerateContentParameters } from "@google/genai";
import type { AIChatStreamProvider, AIChatStreamResult } from "../types/sse.js";
import type { Cohere } from "cohere-ai";
import type Cerebras from "@cerebras/cerebras_cloud_sdk/resources";
import type OpenAIClient from 'openai';
import type * as OpenAI from "openai/resources";
import type * as Mistral from "@mistralai/mistralai/models/components";
import type * as Groq from "groq-sdk/resources/chat/completions";
import { estimateTokens, logGenerationTelemetry } from "./prompt-telemetry.js";
import { convertToGeminiSchema, getOrCreateGeminiCache } from "./gemini.js";

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
 * // In an Express route:
 * res.setHeader('Content-Type', 'text/event-stream');
 * for await (const chunk of stream) {
 *   res.write(chunk);
 * }
 *
 * // Cancel the stream:
 * abortController.abort();
 * ```
 */
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
          
          console.log(`[${provider}] 🧠 Starting SSE streaming task (${models.length} models)...`);
          
          const shouldLogPrompts = logPrompts;
          logPromptWithSeparators(provider, '💬 Built user prompt', prompt, shouldLogPrompts);

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
                    case 'github': gen = githubStreamGenerator(prompt, opts); break;
                    case 'gemini': gen = geminiStreamGenerator(prompt, opts); break;
                    case 'cohere': gen = cohereStreamGenerator(prompt, opts); break;
                    case 'mistral': gen = mistralStreamGenerator(prompt, opts); break;
                    case 'groq': gen = groqStreamGenerator(prompt, opts); break;
                    case 'cerebras': gen = cerebrasStreamGenerator(prompt, opts); break;
                    case 'nvidia': gen = nvidiaStreamGenerator(prompt, opts); break;
                    case 'openrouter': gen = openrouterStreamGenerator(prompt, opts); break;
                    case 'cloudflare': gen = cloudflareStreamGenerator(prompt, opts); break;
                    default: throw new Error(`Unknown streaming provider: ${provider}`);
                  }

                  const first = await gen.next();
                  return { streamGenerator: gen, firstResult: first };
                },
                {
                  maxRetries: AI_CHAT_MODEL_RETRY_COUNT,
                  shouldRetry: (err) => isGenAIErrorRetryable(classifyGenAIError(err)),
                  onRetry: (attempt, err) => {
                    console.warn(`[${provider}] 🔄 Retry ${attempt}/${AI_CHAT_MODEL_RETRY_COUNT} for model ${model}: ${classifyGenAIError(err)}`);
                  },
                }
              );

              // Connection established — send start event
              controller.enqueue(encoder.encode(createStartEvent(provider, model)));

              const requestStartedAt = Date.now();

              // Calculate estimated tokens for telemetry
              const totalDocumentsLength = options.documents?.reduce((sum, doc) => sum + (doc.title?.length ?? 0) + doc.snippet.length, 0) ?? 0;
              const promptChars = (options.systemPrompt?.length ?? 0) + prompt.length + totalDocumentsLength;
              let firstTokenAt: number | null = null;
              let usage: StreamUsage | undefined;

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

                    controller.enqueue(encoder.encode(createTextChunkEvent(chunk)));
                  }
                } catch (streamError) {
                  console.log(`[${provider}] ⚠️ Model ${model} streaming error after first chunk:`, getErrorMessage(streamError));
                  controller.enqueue(encoder.encode(createErrorEvent(`Model ${model} streaming failed: ${getErrorMessage(streamError)}`)));
                  // Mid-stream errors are not retried — continue to next model
                  continue;
                }
              }

              // Send end event
              controller.enqueue(encoder.encode(createEndEvent(provider, model)));
              providerSucceeded = true;

              // Log telemetry
              logGenerationTelemetry({
                provider,
                model,
                context: options.context,
                promptChars,
                estimatedPromptTokens: estimateTokens(promptChars),
                requestStartedAt,
                firstTokenAt,
                completedAt: Date.now(),
                ttftMs: firstTokenAt ? firstTokenAt - requestStartedAt : null,
                generationMs: firstTokenAt ? Date.now() - firstTokenAt : null,
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

              // Log success and increment usage
              logAISuccess({ provider, model, output: '[SSE Stream]', result: '[SSE Stream]' });
              await incrementDailyUsageCount(provider, context ?? 'ai-stream-sse');
              break; // Success - break out of model loop
            } catch (error) {
              console.log(`[${provider}] ⚠️ Model ${model} failed:`, getErrorMessage(error));
              controller.enqueue(encoder.encode(createErrorEvent(`Model ${model} failed: ${getErrorMessage(error)}`)));
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
      frequency_penalty: config.frequencyPenalty,
      seed: config.seed,
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

/**
 * GitHub streaming generator that yields chunks
 */
const githubStreamGenerator = createOpenAICompatibleStreamGenerator('github', getGitHubClient, 'gpt-4o');
const openrouterStreamGenerator = createOpenAICompatibleStreamGenerator('openrouter', getOpenRouterClient, 'deepseek/deepseek-r1:free');
const cloudflareStreamGenerator = createOpenAICompatibleStreamGenerator('cloudflare', getCloudflareClient, '@cf/meta/llama-3.1-8b-instruct');

/**
 * Gemini streaming generator that yields chunks
 */
async function* geminiStreamGenerator(
  prompt: string,
  options: Partial<PromptWithFallbackOptions>
): AIStreamGenerator {
  const { meta, signal, config = AI_CHAT_CONFIG_DEFAULT, outputAsJson, outputJsonStructure, outputJsonRequired, systemPrompt = PROMPT_SYSTEM, documents, cachedContentId } = options;
  const systemPromptWithDocuments = formatSystemPromptWithDocuments('gemini', options);
  const responseJsonSchema: AIJsonProperty | undefined = outputAsJson ? {
    type: "object",
    ...(outputJsonStructure ? {
      properties: outputJsonStructure,
      required: outputJsonRequired,
      additionalProperties: false
    } : {})
  } : undefined;

  // Helper block to fulfill Gemini's minimum token requirement for explicit caching
  const formattedDocuments = formatDocumentsToPrompt(documents);
  const model = options.models?.[0] || 'gemini-2.5-flash';
  const cachedContent = cachedContentId ? await getOrCreateGeminiCache(
    cachedContentId,
    model,
    systemPrompt,
    formattedDocuments,
    meta?.bookId,
  ) : null;

  const response = await getGeminiClient().models.generateContentStream({
    model,
    contents: [{ parts: [{ text: prompt }] }],
    config: {
      ...config,
      ...(outputAsJson ? { responseMimeType: 'application/json' } : {}),
      responseSchema: responseJsonSchema ? convertToGeminiSchema(responseJsonSchema, { minify: true }) : undefined,
      // responseJsonSchema,
      // Cache hit path — send only the dynamic prompt
      ...(cachedContent ? { cachedContent } : {
        // Cache miss or unnecessary — do full request (Gemini caches this automatically)
        systemInstruction: { parts: [{ text: systemPromptWithDocuments }] },
      })
    } satisfies GenerateContentConfig,
  } satisfies GenerateContentParameters);
  
  let usage: StreamUsage | undefined;

  for await (const chunk of response) {
    if (signal?.aborted) break;

    // Gemini sends cumulative usageMetadata on each chunk; the last one
    // received before the stream ends holds the final totals.
    if (chunk.usageMetadata) {
      usage = {
        promptTokens: chunk.usageMetadata.promptTokenCount,
        cachedTokens: chunk.usageMetadata.cachedContentTokenCount,
      };
    }

    if (chunk.candidates?.[0]?.content?.parts) {
      const text = chunk.candidates[0].content.parts
        .filter((p) => typeof p?.text === 'string')
        .map((p) => p.text)
        .join('');
      if (text) yield text;
    }
  }

  return usage;
}

/**
 * Groq streaming generator that yields chunks
 */
async function* groqStreamGenerator(
  prompt: string,
  options: Partial<PromptWithFallbackOptions>
): AsyncGenerator<string> {
  const { signal, config = AI_CHAT_CONFIG_DEFAULT, outputAsJson, outputJsonStructure, outputJsonRequired } = options;
  const { maxOutputToken, temperature, topP, stopSequences, frequencyPenalty, seed } = config;
  const systemPromptWithDocuments = formatSystemPromptWithDocuments('groq', options);

  const stream = await getGroqClient().chat.completions.create({
    messages: [
      { role: 'system', content: systemPromptWithDocuments },
      { role: 'user', content: prompt },
    ],
    model: options.models?.[0] || 'llama-3.3-70b-versatile',
    max_tokens: maxOutputToken,
    temperature,
    top_p: topP,
    stop: stopSequences,
    frequency_penalty: frequencyPenalty,
    seed: seed,
    stream: true,
    response_format: outputAsJson ? (outputJsonStructure ? {
      type: "json_schema",
      json_schema: {
        name: options.context ?? "output-format",
        strict: true,
        schema: {
          type: "object",
          properties: outputJsonStructure,
          required: outputJsonRequired,
          additionalProperties: false
        }
      }
    } : { type: 'json_object' }) : undefined,
  } satisfies Groq.ChatCompletionCreateParamsStreaming, { signal });
  
  for await (const chunk of stream) {
    if (signal?.aborted) return;
    const delta = chunk.choices[0]?.delta?.content || '';
    if (delta) yield delta;
  }
}

/**
 * Cohere streaming generator that yields chunks
 */
async function* cohereStreamGenerator(
  prompt: string,
  options: Partial<PromptWithFallbackOptions>
): AsyncGenerator<string> {
  const { signal, documents, config = AI_CHAT_CONFIG_DEFAULT, context, outputAsJson, outputJsonStructure, outputJsonRequired } = options;
  const stream = await getCohereClient().chatStream({
    model: options.models?.[0] || 'command-r-plus',
    messages: [
      { role: 'system', content: formatSystemPromptWithDocuments('cohere', options) },
      { role: 'user', content: prompt },
    ],
    documents: documents && documents.length > 0
      ? documents.map<Cohere.V2ChatRequestDocumentsItem>((data: AIDocument) => ({ data }))
      : undefined,
    maxTokens: config.maxOutputToken,
    temperature: config.temperature,
    p: config.topP,
    k: config.topK,
    stopSequences: config.stopSequences,
    frequencyPenalty: config.frequencyPenalty,
    seed: config.seed,
    responseFormat: outputAsJson ? (outputJsonStructure ? {
      type: "json_object",
      jsonSchema: {
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
  } satisfies Cohere.V2ChatStreamRequest);
  
  for await (const chunk of stream) {
    if (signal?.aborted) return;
    if (chunk.type === 'content-delta') {
      const text = chunk.delta?.message?.content?.text || '';
      if (text) yield text;
    }
  }
}

/**
 * Cerebras streaming generator that yields chunks
 */
async function* cerebrasStreamGenerator(
  prompt: string,
  options: Partial<PromptWithFallbackOptions>
): AsyncGenerator<string> {
  const { signal, context, config = AI_CHAT_CONFIG_DEFAULT, outputAsJson, outputJsonStructure, outputJsonRequired } = options;
  const { maxOutputToken, temperature, topP, stopSequences, frequencyPenalty, seed } = config;
  const systemPromptWithDocuments = formatSystemPromptWithDocuments('cerebras', options);

  const stream = await getCerebrasClient().chat.completions.create({
    model: options.models?.[0] || 'gpt-oss-120b',
    messages: [
      { role: 'system', content: systemPromptWithDocuments },
      { role: 'user', content: prompt },
    ],
    max_tokens: maxOutputToken,
    temperature,
    top_p: topP,
    stream: true,
    stop: stopSequences,
    frequency_penalty: frequencyPenalty,
    seed: seed,
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
  } satisfies Cerebras.ChatCompletionCreateParamsStreaming, { signal });
  
  for await (const chunk of stream) {
    if (signal?.aborted) return;
    const chunkTyped = chunk as Cerebras.ChatCompletion.ChatChunkResponse | Cerebras.ChatCompletion.ErrorChunkResponse;
    if ('choices' in chunkTyped) {
      const choices = chunkTyped.choices as Array<Cerebras.ChatCompletion.ChatChunkResponse.Choice> | null;
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
}

/**
 * Mistral streaming generator that yields chunks
 */
async function* mistralStreamGenerator(
  prompt: string,
  options: Partial<PromptWithFallbackOptions>
): AsyncGenerator<string> {
  const { signal, config = AI_CHAT_CONFIG_DEFAULT, outputAsJson, outputJsonStructure, outputJsonRequired } = options;
  const { maxOutputToken, temperature, topP, stopSequences, frequencyPenalty, seed } = config;
  const systemPromptWithDocuments = formatSystemPromptWithDocuments('mistral', options);

  const stream = await getMistralClient().chat.stream({
    model: options.models?.[0] || 'mistral-large-latest',
    messages: [
      { role: 'system', content: systemPromptWithDocuments },
      { role: 'user', content: prompt },
    ],
    maxTokens: maxOutputToken,
    temperature,
    topP,
    stop: stopSequences,
    frequencyPenalty,
    randomSeed: seed,
    stream: true,
    responseFormat: outputAsJson ? (outputJsonStructure ? {
      type: "json_schema",
      jsonSchema: {
        name: options.context ?? "output-format",
        strict: true,
        schemaDefinition: {
          type: "object",
          properties: outputJsonStructure,
          required: outputJsonRequired,
          additionalProperties: false
        }
      }
    } : { type: 'json_object' }) : undefined,
  } satisfies Mistral.ChatCompletionStreamRequest, { signal });
  
  for await (const chunk of stream) {
    if (signal?.aborted) return;
    const delta = chunk.data.choices[0]?.delta?.content || '';
    // Handle both string and ContentChunk[] types
    if (Array.isArray(delta)) {
      const nonStringItems = delta.filter(d => typeof d !== 'string');
      if (nonStringItems.length > 0) {
        console.warn('[mistral] ⚠️ Delta contains non-string items:', nonStringItems);
      }
    }
    const text = typeof delta === 'string' ? delta : Array.isArray(delta) ? delta.map(d => typeof d === 'string' ? d : '').join('') : '';
    if (text) yield text;
  }
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
  const apiKey = requireEnv('NVIDIA_API_KEY');

  // Create timeout signal (using Node.js 24+)
  const timeoutSignal = AbortSignal.timeout(NVIDIA_REQUEST_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  const res = await fetch(`https://integrate.api.nvidia.com/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: options.models?.[0] || 'meta/llama-3.3-70b-instruct',
      messages: [
        { role: 'system', content: systemPromptWithDocuments },
        { role: 'user', content: prompt },
      ],
      max_tokens: config.maxOutputToken,
      temperature: config.temperature,
      top_p: config.topP,
      stop: config.stopSequences,
      frequency_penalty: config.frequencyPenalty,
      seed: config.seed,
      stream: true,
    }),
    signal: combinedSignal,
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => 'Unknown error');
    throw new Error(`HTTP ${res.status}: ${errorText}`);
  }

  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  
  if (reader) {
    try {
      while (true) {
        if (combinedSignal.aborted) return;
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
  let text = "";
  const decoder = new TextDecoder();
  
  for await (const chunk of stream) {
    const chunkText = decoder.decode(chunk, { stream: true });
    
    // Parse SSE format to extract JSON data
    // Format: "event: chunk\ndata: {\"type\":\"chunk\",\"content\":\"...\",\"done\":...}\n\n"
    const lines = chunkText.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.substring(6));
          if (data.type === 'chunk' && data.content) {
            text += data.content;
          }
        } catch {
          // Skip lines that can't be parsed as JSON
        }
      }
    }
  }
  
  return text;
}