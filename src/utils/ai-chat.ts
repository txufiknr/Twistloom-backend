import type { AIChatProvider, AIDocument, AIJsonEvaluation, AIJsonProperty, AIPromptForJson, AIPromptOptions, AIResponse, AIModelSelection, NvidiaChatCompletionResponse, OpenRouterCreateParams, PromptWithFallbackOptions } from "../types/ai-chat.js";
import { AI_PROVIDER_API_KEYS, getCerebrasClient, getCloudflareClient, getCohereClient, getGeminiClient, getGitHubClient, getGroqClient, getMistralClient, getOpenRouterClient } from "./ai-clients.js";
import { AI_CHAT_CONFIG_DEFAULT, EVALUATION_FALLBACK_LIMIT, EVALUATION_SCORING_OUTPUT_TOKEN } from "../config/ai-chat.js";
import { AI_CHAT_MODELS_EVALUATION, AI_CHAT_MODELS_WRITING, AI_MAX_PROMPT_LENGTH } from "../config/ai-clients.js";
import { canUseAIToday, getRateLimiter, incrementDailyUsageCount } from './ai-limiters.js';
import { requireEnv } from "./env.js";
import { PROMPT_SYSTEM } from "./prompt.js";
import { logAISuccess, logAIFailure } from './ai-logger.js';
import { classifyGenAIError, isGenAIErrorRetryable } from "./error.js";
import { retryWithBackoff } from "./retry.js";
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
        {
          maxRetries: AI_CHAT_MODEL_RETRY_COUNT,
          shouldRetry: (err) => isGenAIErrorRetryable(classifyGenAIError(provider, model, err)),
          onRetry: (attempt, err) => {
            console.warn(`[${provider}] 🔄 Retry ${attempt}/${AI_CHAT_MODEL_RETRY_COUNT} for model ${model}: ${classifyGenAIError(provider, model, err)}`);
          },
        }
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
        // const createParams: OpenAI.ChatCompletionCreateParamsNonStreaming = {
        const createParams: OpenRouterCreateParams = {
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
              } satisfies AIJsonProperty
            }
          } : { type: 'json_object' }) : undefined,
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
 * Sends a prompt to GitHub Models inference (`models.github.ai`, OpenAI-compatible chat completions).
 *
 * Tries each model in order. Applies {@link githubLimiter}
 * before each request. On success, returns an {@link AIResponse} with token usage and finish reason;
 * on failure, logs and tries the next model, matching the control flow of {@link geminiPrompt}.
 *
 * @param prompt - User message body (article plus instructions; system rules are sent separately)
 * @param options.stopSequences - Optional stop sequences — for non–Q&A content use `['\\n\\n']` to mirror {@link geminiPrompt}
 * @returns Structured response or `null` if every model fails
 * 
 * @see structured JSON guide - https://developers.openai.com/api/docs/guides/structured-outputs
 */
export const githubPrompt = createOpenAICompatiblePrompt('github', getGitHubClient);
export const openrouterPrompt = createOpenAICompatiblePrompt('openrouter', getOpenRouterClient);
export const cloudflarePrompt = createOpenAICompatiblePrompt('cloudflare', getCloudflareClient);

/**
 * Sends a prompt to Google Gemini and returns structured output.
 *
 * Tries each model in {@link AI_CHAT_MODELS_WRITING.gemini} in order; throttles via {@link geminiLimiter}
 * before each call; respects safety blocks and finish reasons like other chat providers.
 *
 * @param prompt - User portion of the prompt (system rules are concatenated in the request body)
 * @param options.stopSequences - Optional stop sequences (e.g. `['\\n\\n']` for non–Q&A summarization)
 * @returns {@link AIResponse} or `null` if every model fails
 */
export async function geminiPrompt(
  prompt: string,
  options?: Partial<PromptWithFallbackOptions>
): Promise<AIResponse<string> | null> {
  return promptWithFallback<GenerateContentResponse>(
    'gemini',
    prompt,
    options,
    async (model, prompt, opts) => {
      const { meta, config = AI_CHAT_CONFIG_DEFAULT, outputAsJson, outputJsonStructure, outputJsonRequired, systemPrompt = PROMPT_SYSTEM, documents, cachedContentId } = opts;
      const systemPromptWithDocuments = formatSystemPromptWithDocuments('gemini', opts);
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
      const cachedContent = cachedContentId ? await getOrCreateGeminiCache(
        cachedContentId,
        model,
        systemPrompt,
        formattedDocuments,
        meta?.bookId,
      ) : null;

      // Penalty is not enabled for models/gemini-2.5-flash
      const { frequencyPenalty: _fp, ...geminiConfig } = config;

      const response = await getGeminiClient().models.generateContent({
        model,
        contents: [{ parts: [{ text: prompt }] }],
        config: {
          ...geminiConfig,
          ...(outputAsJson ? { responseMimeType: 'application/json' } : {}),
          responseSchema: responseJsonSchema ? convertToGeminiSchema(responseJsonSchema, { minify: true }) : undefined,
          // responseJsonSchema,
          // Cache hit — send only the dynamic prompt
          ...(cachedContent ? { cachedContent } : {
            // Cache miss or unnecessary — do full request (Gemini caches this automatically)
            systemInstruction: { parts: [{ text: systemPromptWithDocuments }] },
          })
        } satisfies GenerateContentConfig,
      } satisfies GenerateContentParameters);
      
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
      const { maxOutputToken, temperature, topP, stopSequences, frequencyPenalty, seed } = config;
      const systemPromptWithDocuments = formatSystemPromptWithDocuments('groq', opts);

      const { data, response } = await getGroqClient().chat.completions.create({
        messages: [
          { role: 'system', content: systemPromptWithDocuments },
          { role: 'user', content: prompt },
        ],
        model,
        max_tokens: maxOutputToken,
        temperature,
        top_p: topP,
        stop: stopSequences,
        frequency_penalty: frequencyPenalty,
        seed: seed,
        stream: false,
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
      const { documents, config = AI_CHAT_CONFIG_DEFAULT, outputAsJson, outputJsonStructure, outputJsonRequired } = opts;
      return await getCohereClient().chat({
        model,
        messages: [
          { role: 'system', content: formatSystemPromptWithDocuments('cohere', opts) },
          { role: 'user', content: prompt },
        ],
        documents: documents?.length
          ? documents.map<Cohere.V2ChatRequestDocumentsItem>(data => ({ data }))
          : undefined,
        maxTokens: config.maxOutputToken,
        temperature: config.temperature,
        p: config.topP,
        k: config.topK,
        stopSequences: config.stopSequences,
        frequencyPenalty: config.frequencyPenalty,
        seed: config.seed,
        responseFormat: outputAsJson ? {
          type: "json_object",
          jsonSchema: outputJsonStructure ? {
            type: "object",
            properties: outputJsonStructure,
            required: outputJsonRequired,
            additionalProperties: false
          } satisfies AIJsonProperty : undefined
        } satisfies Cohere.ResponseFormatV2 : undefined,
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
      const { maxOutputToken, temperature, topP, stopSequences, frequencyPenalty, seed } = config;
      const systemPromptWithDocuments = formatSystemPromptWithDocuments('cerebras', opts);

      return await getCerebrasClient().chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPromptWithDocuments },
          { role: 'user', content: prompt },
        ],
        max_tokens: maxOutputToken,
        temperature,
        top_p: topP,
        stream: false,
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
            } satisfies AIJsonProperty
          }
        } : { type: 'json_object' }) : undefined,
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
      return {
        completion_tokens: response.usage.completion_tokens,
        prompt_tokens: response.usage.prompt_tokens,
        total_tokens: response.usage.total_tokens,
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
      const { config = AI_CHAT_CONFIG_DEFAULT, context, outputAsJson, outputJsonStructure, outputJsonRequired } = opts;
      const { maxOutputToken, temperature, topP, stopSequences, frequencyPenalty, seed } = config;
      const systemPromptWithDocuments = formatSystemPromptWithDocuments('mistral', opts);

      return await getMistralClient().chat.complete({
        model,
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
        stream: false,
        responseFormat: outputAsJson ? (outputJsonStructure ? {
          type: "json_schema",
          jsonSchema: {
            name: context ?? "output-format",
            strict: true,
            schemaDefinition: {
              type: "object",
              properties: outputJsonStructure,
              required: outputJsonRequired,
              additionalProperties: false
            } satisfies AIJsonProperty
          }
        } : { type: 'json_object' }) : undefined,
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
 * @see structured JSON guide - https://docs.nvidia.com/nim/large-language-models/1.13.0/structured-generation.html
 * @see docs - https://docs.api.nvidia.com/nim/reference/create_chat_completion_v1_chat_completions_post
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
      const { config = AI_CHAT_CONFIG_DEFAULT, outputAsJson, outputJsonStructure, outputJsonRequired } = opts;
      const { maxOutputToken, temperature, topP, stopSequences, frequencyPenalty, seed } = config;

      const systemPromptWithDocuments = formatSystemPromptWithDocuments('nvidia', opts);
      const apiKey = requireEnv('NVIDIA_API_KEY');
      const res = await fetch(`https://integrate.api.nvidia.com/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPromptWithDocuments },
            { role: 'user', content: prompt },
          ],
          max_tokens: maxOutputToken,
          temperature,
          top_p: topP,
          stop: stopSequences,
          frequency_penalty: frequencyPenalty,
          seed,
          stream: false,

          // NVIDIA NIM Structured JSON Implementation
          ...(outputAsJson ? {
            extra_body: {
              nvext: {
                guided_json: {
                  type: "object",
                  ...(outputJsonStructure ? {
                    properties: outputJsonStructure,
                    required: outputJsonRequired,
                    additionalProperties: false
                  } : {})
                } satisfies AIJsonProperty // Falls back to a generic JSON object if no structural layout is passed
              }
            }
          } : {}),
        }),
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => 'Unknown error');
        throw new Error(`HTTP ${res.status}: ${errorText}`);
      }

      return await res.json().catch(() => null) as NvidiaChatCompletionResponse;
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
 * - Cohere/Groq/Cerebras/NVIDIA/GitHub: 480,000-500,000 chars (~120K tokens)
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
    logEvaluationResult = false,
    evaluatorFallbackLimit = EVALUATION_FALLBACK_LIMIT,
    meta
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
    const systemPrompt = shouldAppendOutputFormat ? `${originalSystemPrompt}\n\n---\n${options.outputFormat}` : originalSystemPrompt;

    try {
      const models = modelSelection[provider];
      if (!models || models.length === 0) continue; // Skip to next provider

      // Validate prompt length against provider's maximum limit
      const totalDocumentsLength = documents.reduce((sum, doc) => sum + `${doc.title ?? ''}${doc.snippet}`.length, 0);
      const totalPromptLength = systemPrompt.length + prompt.length + totalDocumentsLength;
      const maxPromptLength = AI_MAX_PROMPT_LENGTH[provider];

      // Skip if total prompt length exceeded provider's max prompt length
      if (totalPromptLength > maxPromptLength) {
        console.log(`[${provider}] ⚠️ Prompt length (${totalPromptLength.toLocaleString()} chars) exceeds limit (${maxPromptLength.toLocaleString()} chars), skipping`);
        continue;
      }

      // Skip providers that have already exhausted their daily request budget
      if (!(await canUseAIToday(provider))) {
        console.log(`[${provider}] ⏩ Daily request limit reached, skipping`);
        continue;
      }

      // AI provider is available and ready to be used
      console.log(`[${provider}] 🧠 Ready with task (${models.length} models)...`);
      
      // Only log prompts on the very first iteration
      const shouldLogPrompts = logPrompts && isFirstIteration;
      logPromptWithSeparators(provider, '💬 Built user prompt', prompt, shouldLogPrompts);

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
      
      // Pre-call check: Skip Gemini if the schema exceeds its constrained decoder limits.
      // The remaining providers (Groq, Cerebras, etc.) handle large schemas fine.
      if (provider === 'gemini' && isSchemaTooComplex(outputJsonStructure)) {
        console.warn(`[gemini] ⏩ Skipping Gemini — schema exceeds complexity limits that Gemini's constrained decoder can compile`);
        continue;
      }

      // Provider-agnostic stack
      switch (provider) {
        case 'github':     result = await githubPrompt(prompt, opts); break;         // ✅ JSON schema | ☑️ document via system prompt
        case 'gemini':     result = await geminiPrompt(prompt, opts); break;         // ✅ JSON schema | ☑️ document via system prompt
        case 'cohere':     result = await coherePrompt(prompt, opts); break;         // ✅ JSON schema | ✅ document via RAG
        case 'mistral':    result = await mistralPrompt(prompt, opts); break;       // ✅ JSON schema | ☑️ document via system prompt
        case 'groq':       result = await groqPrompt(prompt, opts); break;             // ✅ JSON schema | ☑️ document via system prompt
        case 'cerebras':   result = await cerebrasPrompt(prompt, opts); break;     // ✅ JSON schema | ☑️ document via system prompt
        case 'nvidia':     result = await nvidiaPrompt(prompt, opts); break;         // ✅ JSON schema via extra_body | ☑️ document via system prompt
        case 'openrouter': result = await openrouterPrompt(prompt, opts); break; // Same as github
        case 'cloudflare': result = await cloudflarePrompt(prompt, opts); break; // Same as github
      }
    } catch (error) {
      console.log(`[${provider}] ⚠️ Provider failed:`, error);
      result = null;
    }

    await onProgress?.({ type: 'ai_generation_complete' });

    if (result?.output) {
      try {
        // Run evaluation phase if provided
        if (evaluatorPrompt) {
          // STEP 3: EVALUATING (best-effort)
          // Evaluation must not invalidate a successful generation. If evaluation fails,
          // fall back to the original generated `result.output` below.
          await onProgress?.({ type: 'ai_evaluation_start' });
          await onGenerationProgress?.('ai_evaluation');

          const evaluationContext = `${context}-evaluation`;

          // Resolve 'auto' once at the evaluation level. The resolved boolean threads
          // through to both schema building and result parsing, ensuring they stay in sync.
          const evaluationOptions: AIPromptOptions = {
            ...options,
            modelSelection: AI_CHAT_MODELS_EVALUATION,
            useStringEvaluatorOutput: resolveUseStringEvaluator({ ...options, modelSelection: AI_CHAT_MODELS_EVALUATION }),
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
              let correctedOutput: T | undefined;
              if (evaluationOptions.useStringEvaluatorOutput) {
                try {
                  const raw = evaluationResult.output as unknown as string;
                  correctedOutput = raw ? JSON.parse(raw) as T : undefined;
                } catch {
                  console.warn(`[${evaluationContext}] ⚠️ Failed to parse evaluator string output as JSON — falling back to original`);
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
 * - >15KB JSON → schema payload itself exceeds decoder limits
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

  measure(schema);

  const isComplex = props > 100 || enumItems > 100 || maxDepth > 6 || schemaStr.length > 15000;

  if (isComplex) {
    console.warn(`[schema-complexity] ⚠️ Schema too complex: ${schemaStr.length / 1024 | 0}KB, ${props} props, ${enumItems} enum items, depth ${maxDepth}`);
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
function resolveUseStringEvaluator(options: { useStringEvaluatorOutput?: boolean | 'auto'; modelSelection?: AIModelSelection }): boolean {
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
 * - System prompt providers (GitHub, Gemini, etc.): Documents embedded in system prompt
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
    logPromptWithSeparators(provider, '💬 Built system prompt', systemPrompt, logPrompts);
    return systemPrompt;
  }
  
  const formattedDocuments = formatDocumentsToPrompt(documents);
  const systemPromptWithDocs = `${systemPrompt}\n\n---\n${formattedDocuments}`;
  const message = `🧾 Built system prompt with ${documents.length} document${documents.length > 1 ? 's' : ''}`;
  logPromptWithSeparators(provider, message, systemPromptWithDocs, logPrompts);
  return systemPromptWithDocs;
}

/**
 * Logs a prompt with clear section boundaries (separators above and below)
 * 
 * @param provider - AI provider name for logging context
 * @param message - Descriptive message with emoji (e.g., "💬 Built user prompt")
 * @param content - The actual prompt content to log
 * @param shouldLog - Whether to log (respects logPrompts flag)
 */
export function logPromptWithSeparators(provider: AIChatProvider, message: string, content: string, shouldLog: boolean): void {
  if (!shouldLog) return;
  
  edgeGroup.wrap(`[${provider}] ${message} (${content.length} chars):`, async () => {
    console.log(content);
  });
}