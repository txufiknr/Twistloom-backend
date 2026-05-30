import type { AIChatProvider, AIDocument, AIJsonEvaluation, AIPromptForJson, AIPromptOptions, AIResponse, NvidiaChatCompletionResponse, PromptWithFallbackOptions } from "../types/ai-chat.js";
import { AI_PROVIDER_API_KEYS, getCerebrasClient, getCohereClient, getGeminiClient, getGitHubClient, getGroqClient, getMistralClient } from "./ai-clients.js";
import { AI_CHAT_CONFIG_DEFAULT } from "../config/ai-chat.js";
import { AI_CHAT_MODELS_EVALUATION, AI_CHAT_MODELS_WRITING, AI_MAX_PROMPT_LENGTH } from "../config/ai-clients.js";
import { getRateLimiter, incrementDailyUsageCount } from './ai-limiters.js';
import { requireEnv } from "./env.js";
import { PROMPT_SYSTEM } from "./prompt.js";
import { logAISuccess, logAIFailure } from './ai-logger.js';
import { classifyGenAIError, getErrorMessage } from "./error.js";
import { parseAISafely } from "./parser.js";
import type Groq from 'groq-sdk';
import type { ChatCompletionCreateParamsBase, ChatCompletion as OpenAIChatCompletion } from 'openai/resources/chat/completions.js';
import { type GenerateContentConfig, Type, type GenerateContentParameters, type GenerateContentResponse, type Schema } from "@google/genai";
import type { ResponseFormatV2, V2ChatRequest, V2ChatRequestDocumentsItem, V2ChatResponse } from "cohere-ai/api";
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from "@cerebras/cerebras_cloud_sdk/resources/index.mjs";
import type { ChatCompletionRequest, ChatCompletionResponse } from "@mistralai/mistralai/models/components";
import { buildEvaluationSchemaDefinition, EVALUATION_REQUIRED_FIELDS } from "../schema/story.js";
import { group } from '@actions/core';
import type { ProgressCallback } from "../types/sse.js";
import type { StoryGenerationStep } from "../types/book.js";

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
    try {
      // Rate limiting: Apply throttling before making API call
      await getRateLimiter(provider).throttle();
      
      // Only respect logPrompts for the very first model index
      const modelOptions = i === 0 ? options : { ...options, logPrompts: false };
      
      // API call: Execute the actual request to the AI provider
      const response = await apiCall(model, prompt, modelOptions);
      
      // Response extraction: Get the output content from the response
      const output = extractOutput(response);
      
      // Success handling: Process valid response and return result
      if (output) {
        const usage = extractUsage(response);
        const finishReason = extractFinishReason(response);
        const aiResponse: AIResponse<string> = {
          provider,
          model,
          output,
          result: output, // Add result property for string type
          usage,
          finishReason
        };
        
        // Logging: Log successful AI response
        logAISuccess(aiResponse);
        // Usage tracking: Increment daily usage counter on successful AI response
        await incrementDailyUsageCount(provider, options.context ?? 'ai-prompt');
        return aiResponse;
      }

      // Empty response handling: Log when no content is received
      logAIFailure(provider, model, 'No output content received');
    } catch (error) {
      // Error handling: Classify error and decide on retry strategy
      const code = classifyGenAIError(error);
      if (i < models.length - 1) {
        // Model fallback: Try next model if more are available
        console.warn(`[${provider}] 💥 Model ${model} failed, trying next model:`, code);
      } else {
        // Final failure: All models have been exhausted
        console.error(`[${provider}] ❌ All models failed:`, code);
      }
    }
  }

  // 4️⃣ Complete failure: Return null when all models fail
  return null;
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
 */
export async function githubPrompt(
  prompt: string,
  options?: Partial<PromptWithFallbackOptions>
): Promise<AIResponse<string> | null> {
  return promptWithFallback<OpenAIChatCompletion>(
    'github',
    prompt,
    options,
    async (model, prompt, opts) => {
      const { context, config = AI_CHAT_CONFIG_DEFAULT, outputAsJson, outputJsonStructure, outputJsonRequired } = opts;
      const systemPromptWithDocuments = formatSystemPromptWithDocuments('github', opts);
      return await getGitHubClient().chat.completions.create({
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
            }
          }
        } : { type: 'json_object' }) : undefined,
      } satisfies ChatCompletionCreateParamsNonStreaming);
    },
    (response) => {
      const content = response.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        console.warn('[github] Invalid or empty model response');
        return null;
      }
      return content.trim();
    },
    (response) => {
      const { usage } = response;
      if (!usage) {
        console.warn('[github] No usage data in response');
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
}

// Helper function to convert JSON schema to Gemini schema recursively
export const convertToGeminiSchema = (jsonSchema: any): Schema => {
  if (jsonSchema.type === 'array' && jsonSchema.items) {
    return {
      type: Type.ARRAY,
      items: convertToGeminiSchema(jsonSchema.items),
    };
  } else if (jsonSchema.type === 'object' && jsonSchema.properties) {
    return {
      type: Type.OBJECT,
      properties: Object.entries(jsonSchema.properties).reduce((acc, [k, v]) => {
        acc[k] = convertToGeminiSchema(v);
        return acc;
      }, {} as Record<string, Schema>),
      required: jsonSchema.required || [],
    };
  } else {
    // Map JSON schema types to Gemini enum types
    const typeMapping: Record<string, Type> = {
      'string': Type.STRING,
      'number': Type.NUMBER,
      'integer': Type.INTEGER,
      'boolean': Type.BOOLEAN,
      'array': Type.ARRAY,
      'object': Type.OBJECT,
      'null': Type.NULL,
    };
    
    const geminiType = typeMapping[jsonSchema.type] || Type.TYPE_UNSPECIFIED;
    
    const schema: Schema = {
      type: geminiType,
    };
    
    // Add enum values if specified
    if (jsonSchema.enum && Array.isArray(jsonSchema.enum)) {
      (schema as any).enum = jsonSchema.enum;
    }
    
    // Add format for string types (e.g., date-time, email, etc.)
    if (jsonSchema.type === 'string' && jsonSchema.format) {
      (schema as any).format = jsonSchema.format;
    }
    
    // Add minimum/maximum for number types
    if (jsonSchema.type === 'number' || jsonSchema.type === 'integer') {
      if (typeof jsonSchema.minimum === 'number') {
        (schema as any).minimum = jsonSchema.minimum;
      }
      if (typeof jsonSchema.maximum === 'number') {
        (schema as any).maximum = jsonSchema.maximum;
      }
    }
    
    return schema;
  }
};

/**
 * Sends a prompt to Google Gemini and returns structured output.
 *
 * Tries each model in {@link AI_CHAT_MODELS.gemini} in order; throttles via {@link geminiLimiter}
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
      const { config = AI_CHAT_CONFIG_DEFAULT, outputAsJson, outputJsonStructure, outputJsonRequired } = opts;
      const responseSchema = outputAsJson ? {
        type: Type.OBJECT,
        properties: outputJsonStructure ? Object.entries(outputJsonStructure).reduce((acc, [key, value]) => {
          acc[key] = convertToGeminiSchema(value);
          return acc;
        }, {} as Record<string, Schema>) : undefined,
        required: outputJsonRequired || []
      } satisfies Schema : undefined;

      const systemPromptWithDocuments = formatSystemPromptWithDocuments('gemini', opts);
      const response = await getGeminiClient().models.generateContent({
        model,
        contents: [{ parts: [{ text: `${systemPromptWithDocuments}\n\n${prompt}` }] }],
        config: { ...config, responseSchema } satisfies GenerateContentConfig,
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
      return {
        promptTokens: usageMetadata.promptTokenCount,
        outputTokens: usageMetadata.candidatesTokenCount,
        totalTokens: usageMetadata.totalTokenCount,
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
      const { maxOutputToken, temperature, topP, stopSequences } = config;
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
            }
          }
        } : { type: 'json_object' }) : undefined,
      } satisfies ChatCompletionCreateParamsBase).withResponse();

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
      if (!response.choices || response.choices.length === 0) {
        console.warn('[groq] No choices in response');
        return null;
      }

      const choice = response.choices[0];
      const content = choice.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        console.warn('[groq] No valid content in response');
        return null;
      }
      return content.trim();
    },
    (response) => {
      const { usage } = response;
      if (!usage) {
        console.warn('[groq] No usage data in response');
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
  return promptWithFallback<V2ChatResponse>(
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
        documents: documents && documents.length > 0
          ? documents.map((data: AIDocument) => ({ data })) satisfies V2ChatRequestDocumentsItem[]
          : undefined,
        maxTokens: config.maxOutputToken,
        temperature: config.temperature,
        p: config.topP,
        k: config.topK,
        stopSequences: config.stopSequences,
        responseFormat: outputAsJson ? {
          type: "json_object",
          jsonSchema: outputJsonStructure ? {
            type: "object",
            properties: outputJsonStructure,
            required: outputJsonRequired,
            additionalProperties: false
          } : undefined
        } satisfies ResponseFormatV2 : undefined,
      } satisfies V2ChatRequest);
    },
    (response) => {
      const message = response.message;
      const contentText = message?.content?.[0]?.type === 'text' ? message.content[0].text : null;
      const text = message?.content
        ?.find((item): item is { type: 'text'; text: string } => item.type === 'text')
        ?.text ?? contentText;
      if (!text) {
        console.warn('[cohere] No text in response');
        return null;
      }
      return text;
    },
    (response) => {
      const { usage } = response;
      if (!usage) {
        console.warn('[cohere] No usage data in response');
        return undefined;
      }
      return {
        inputTokens: usage.tokens?.inputTokens,
        outputTokens: usage.tokens?.outputTokens,
        cachedTokens: usage.cachedTokens,
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
  return promptWithFallback<ChatCompletion.ChatCompletionResponse>(
    'cerebras',
    prompt,
    options,
    async (model, prompt, opts) => {
      const { context, config = AI_CHAT_CONFIG_DEFAULT, outputAsJson, outputJsonStructure, outputJsonRequired } = opts;
      const { maxOutputToken, temperature, topP, stopSequences } = config;
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
      } satisfies ChatCompletionCreateParamsBase) as ChatCompletion.ChatCompletionResponse;
    },
    (response) => {
      const content = response.choices?.[0]?.message?.content;
      if (!content) {
        console.warn('[cerebras] No content in response');
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
      const { maxOutputToken, temperature, topP, stopSequences } = config;
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
            }
          }
        } : { type: 'json_object' }) : undefined,
      } satisfies ChatCompletionRequest);
    },
    (response) => {
      const content = response.choices?.[0]?.message?.content;
      if (!content) {
        console.warn('[mistral] No content in response');
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
 * @example
 * ```typescript
 * const response = await nvidiaPrompt('Extract key Islamic concepts from this text');
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
      const { config = AI_CHAT_CONFIG_DEFAULT } = opts;
      const systemPromptWithDocuments = formatSystemPromptWithDocuments('nvidia', opts);
      const apiKey = requireEnv('NVIDIA_API_KEY');

      // docs: https://docs.api.nvidia.com/nim/reference/create_chat_completion_v1_chat_completions_post
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
          max_tokens: config.maxOutputToken,
          temperature: config.temperature,
          top_p: config.topP,
          stop: config.stopSequences,
          stream: false,
        }),
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => 'Unknown error');
        throw new Error(`HTTP ${res.status}: ${errorText}`);
      }

      return await res.json().catch(() => null) as NvidiaChatCompletionResponse;
    },
    (response) => {
      const content = response.choices?.[0]?.message?.content;
      if (!content) {
        console.warn('[nvidia] No content in response');
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
  options: AIPromptOptions = {},
  evaluatorPrompt?: string,
  onProgress?: ProgressCallback,
  onGenerationProgress?: (step: StoryGenerationStep) => Promise<void>,
): Promise<AIResponse<T>> {
  const {
    modelSelection = AI_CHAT_MODELS_WRITING,
    config = AI_CHAT_CONFIG_DEFAULT,
    outputAsJson = false,
    outputJsonFallbackField,
    systemPrompt = PROMPT_SYSTEM,
    documents,
    context = 'ai',
    logPrompts = false,
    logEvaluationResult = false,
  } = options;

  // Define provider order from modelSelection or use empty array
  const providers = Object.keys(modelSelection) as AIChatProvider[];
  
  // If no modelSelection provided, return empty response
  if (providers.length === 0) return { provider: 'none', output: '' };

  await onProgress?.({ type: 'ai_generation_start' });
  await onGenerationProgress?.('ai_generation');

  // Try each provider in order
  for (const provider of providers) {
    const isFirstIteration = providers.indexOf(provider) === 0;
    let result: AIResponse<string> | null = null;

    try {
      const models = modelSelection[provider];
      if (!models || models.length === 0) continue; // Skip to next provider

      // Validate prompt length against provider's maximum limit
      const totalPromptLength = systemPrompt.length + prompt.length;
      const maxPromptLength = AI_MAX_PROMPT_LENGTH[provider];
      if (totalPromptLength > maxPromptLength) {
        console.log(`[${provider}] ⚠️ Prompt length (${totalPromptLength.toLocaleString()} chars) exceeds limit (${maxPromptLength.toLocaleString()} chars), skipping`);
        continue;
      }

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
      };
      
      switch (provider) {
        case 'github': result = await githubPrompt(prompt, opts); break;     // ✅ JSON schema | ☑️ document via system prompt
        case 'gemini': result = await geminiPrompt(prompt, opts); break;     // ✅ JSON schema | ☑️ document via system prompt
        case 'cohere': result = await coherePrompt(prompt, opts); break;     // ☑️ JSON object | ✅ document via RAG
        case 'mistral': result = await mistralPrompt(prompt, opts); break;   // ✅ JSON schema | ☑️ document via system prompt
        case 'groq': result = await groqPrompt(prompt, opts); break;         // ✅ JSON schema | ☑️ document via system prompt
        case 'cerebras': result = await cerebrasPrompt(prompt, opts); break; // ✅ JSON schema | ☑️ document via system prompt
        case 'nvidia': result = await nvidiaPrompt(prompt, opts); break;     // ❌ No structured JSON (HTTP API limitation) | ☑️ document via system prompt
      }
    } catch (error) {
      console.log(`[${provider}] ⚠️ Provider failed:`, getErrorMessage(error));
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
          try {
            // Call second AI prompt to score, evaluate, and output corrected result
            const response = await aiPrompt<AIJsonEvaluation<T>>(evaluatorPrompt, {
              ...options,
              modelSelection: AI_CHAT_MODELS_EVALUATION,
              config,
              systemPrompt,
              context: evaluationContext,

              // Pass generated raw output as document
              documents: [
                ...(documents || []),
                {
                  title: 'GENERATED JSON (from previous AI)',
                  snippet: result.output,
                }
              ],

              // Evaluation output schema
              outputAsJson: true,
              outputJsonStructure: buildEvaluationSchemaDefinition(options),
              outputJsonRequired: EVALUATION_REQUIRED_FIELDS satisfies (keyof AIJsonEvaluation<T>)[],
              outputJsonFallbackField: 'output' satisfies keyof AIJsonEvaluation<T>

              // CRITICAL: evaluation call should exclude the evaluatorPromptBuilder to prevent the recursive loop
            }, undefined);

            const { result: evaluationResult } = response;

            // Emit evaluation complete event
            await onProgress?.({ type: 'ai_evaluation_complete' });

            if (evaluationResult) {
              const { scoreBefore, scoreAfter, actionFlags, integrityFlags } = evaluationResult;
              if (logEvaluationResult) {
                group(`[${evaluationContext}] 🕵️‍♂️ Evaluation result (score: ${scoreBefore} → ${scoreAfter}):`, async () => {
                  console.log("Score before:", scoreBefore);
                  console.log("Score after:", scoreAfter);
                  console.log("Action flags:", actionFlags);
                  console.log("Integrity flags:", integrityFlags);
                });
              }
              return {
                ...result,
                result: evaluationResult.output
              } satisfies AIResponse<T>;
            } else if (logEvaluationResult) {
              console.log(`[${evaluationContext}] Evaluation returned no result — falling back to generation output`);
            }
          } catch (evalError) {
            console.warn(`[${evaluationContext}] ⚠️ Evaluation failed — falling back to generation output:`, getErrorMessage(evalError));
            // Ensure we still emit evaluation complete to keep progress lifecycle consistent
            await onProgress?.({ type: 'ai_evaluation_complete' });
            // continue to parsing original generated result
          }
        }

        // Parse the output into the expected type T
        let parsedResult: T;
        
        if (outputAsJson) {
          // For JSON-like output, try to parse as object using parseAISafely
          const compatibleResponse: AIResponse<Record<string, unknown>> = {
            ...result,
            result: undefined
          };
          parsedResult = parseAISafely(compatibleResponse, {
            logContext: `${provider}-${context}`,
            fallbackField: outputJsonFallbackField
          }) as T;
        } else {
          // For non-JSON output, treat as string
          parsedResult = result.output as T;
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
      console.log(`${provider} failed, trying remaining fallback: ${remainingProviders.join(' → ')}`);
    }
  }

  await onProgress?.({ type: 'ai_generation_complete' });
  return { provider: 'none', output: '' };
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
 * // Returns: "Story Context\nUser is in a dark forest...\n\nCharacter Info\nMain character: John..."
 * ```
 */
function formatDocumentsToPrompt(documents?: AIDocument[]): string {
  return documents 
    ? documents
        .filter((doc): doc is AIDocument => !!doc)
        .map((doc) => `${doc.title ? `${doc.title}:\n` : ''}${doc.snippet}`.trim())
        .join('\n\n')
    : '';
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
 * // Returns: "You are a helpful assistant...\n\nContext\nUser is exploring...\n\nRules\nBe concise..."
 * ```
 */
export function formatSystemPromptWithDocuments(provider: AIChatProvider, options: Pick<AIPromptOptions, 'systemPrompt' | 'documents' | 'logPrompts'>): string {
  const { systemPrompt: customSystemPrompt, documents, logPrompts = false } = options;
  const systemPrompt = customSystemPrompt ?? PROMPT_SYSTEM;
  
  // Early return when no document or provider is Cohere's V2 API which
  // natively supports RAG via documents field.
  if (!documents || documents.length === 0 || provider === 'cohere') {
    logPromptWithSeparators(provider, '💬 Built system prompt', systemPrompt, logPrompts);
    return systemPrompt;
  }
  
  const formattedDocuments = formatDocumentsToPrompt(documents);
  const systemPromptWithDocs = `${systemPrompt}\n\n${formattedDocuments}`;
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
  
  // const separator = '═'.repeat(80);
  // console.log(`\n${separator}`);
  // console.log(`[${provider}] ${message} (${content.length} chars):`, content);
  // console.log(`${separator}\n`);

  group(`[${provider}] ${message} (${content.length} chars):`, async () => {
    console.log(content);
  });
}