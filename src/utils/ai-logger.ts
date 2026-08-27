/**
 * Standardized logging utilities for AI providers
 * Eliminates code duplication across Gemini, Groq, Cohere, and HuggingFace providers
 */

import type { AIChatProvider, AIResponse } from "../types/ai-chat.js";
import { edgeGroup } from './edge-group.js';
import { IS_VERCEL } from '../config/env.js';

/**
 * Logs successful AI provider response with standardized format
 * 
 * @param response - The AI provider response data
 */
export function logAISuccess(response: AIResponse<unknown>, requestStartAt?: number): void {
  const { provider, model, output, finishReason = 'unknown', usage } = response;
  const elapsedMs = requestStartAt ? Date.now() - requestStartAt : undefined;
  const title = `[${provider}] ✅ ${model} succeeded (${output.length} chars, finish: ${finishReason}${elapsedMs ? `, duration: ${elapsedMs}ms` : ''})`;

  // On Vercel serverless functions, dumping massive multi-KB LLM outputs into stdout
  // burns active CPU cycles and floods serverless logs. On Vercel, emit a clean 1-liner.
  if (IS_VERCEL) {
    console.log(title);
    return;
  }

  edgeGroup.wrap(title, async () => {
    // Log success with full output (active in GitHub Actions CI / Local Dev)
    console.log(`"""\n${output}\n"""`);
    
    // Log usage if provided
    if (usage) {
      console.log(`[${provider}] 📊 Token usage:`, usage);
    }
  });
}

/**
 * Logs AI provider failure with standardized format
 * 
 * @param provider - The AI provider name
 * @param model - The model name
 * @param reason - Failure reason or error message
 * @param options - Optional logging configuration
 * 
 * @example
 * ```typescript
 * logAIFailure('groq', 'llama3-70b-8192', 'No output', { finishReason: 'length' });
 * logAIFailure('huggingface', 'facebook/bart-large-cnn', 'API Error: Rate limit exceeded');
 * ```
 */
export function logAIFailure(
  provider: string,
  model: string,
  reason: string,
  options: { finishReason?: string; logPrefix?: string } = {}
): void {
  const { finishReason, logPrefix = '' } = options;
  const prefix = `${logPrefix}[${provider}]`;
  
  if (finishReason) {
    console.warn(`${prefix} ❓ ${model} failed: ${reason} (finish: ${finishReason})`);
  } else {
    console.warn(`${prefix} ❌ ${model} failed: ${reason}`);
  }
}

/**
 * Logs AI provider quota/rate limit information
 * 
 * @param provider - The AI provider name
 * @param quotaInfo - Quota or rate limit information
 * @param options - Optional logging configuration
 */
export function logAIQuota(
  provider: string,
  quotaInfo: Record<string, any>,
  options: { logPrefix?: string } = {}
): void {
  const { logPrefix = '' } = options;
  console.log(`${logPrefix}[${provider}] 📊 Quota info:`, quotaInfo);
}

/**
 * Logs a prompt with clear section boundaries (separators above and below)
 * 
 * @param provider - AI provider name for logging context
 * @param message - Descriptive message with emoji (e.g., "💬 Built user prompt")
 * @param content - The actual prompt content to log
 * @param shouldLog - Whether to log (respects logPrompts flag)
 */
export function logAIPrompt(provider: AIChatProvider, message: string, content: string, shouldLog: boolean): void {
  if (!shouldLog) return;

  const title = `[${provider}] ${message} (${content.length} chars)`;
  
  if (IS_VERCEL) {
    console.log(title);
    return;
  }

  edgeGroup.wrap(title, async () => {
    console.log(content);
  });
}