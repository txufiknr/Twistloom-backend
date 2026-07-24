/**
 * Standardized logging utilities for AI providers
 * Eliminates code duplication across Gemini, Groq, Cohere, and HuggingFace providers
 */

import type { AIResponse } from "../types/ai-chat.js";
import { edgeGroup } from './edge-group.js';

/**
 * Logs successful AI provider response with standardized format
 * 
 * @param response - The AI provider response data
 */
export function logAISuccess(response: AIResponse<unknown>, requestStartAt?: number): void {
  const { provider, model, output, finishReason = 'unknown', usage } = response;
  const elapsedMs = requestStartAt ? Date.now() - requestStartAt : undefined;

  edgeGroup.wrap(`[${provider}] ✅ ${model} succeeded (${output.length} chars, finish: ${finishReason}${elapsedMs ? `, duration: ${elapsedMs}ms` : ''})`, async () => {
    // Log success with output
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
 * Logs AI summarization prompt with standardized format
 * 
 * @param provider - The AI provider name
 * @param prompt - The generated prompt content
 * @param maxPromptLength - Maximum allowed prompt length for the provider
 * @param promptSystem - System prompt content (default from summarize.ts)
 */
export function logAIPrompt(
  provider: string,
  prompt: string,
  maxPromptLength: number,
  promptSystem: string = ''
): void {
  if (prompt != null) {
    const totalLength = prompt.length + promptSystem.length;
    console.log(`[${provider}] 💬 Built complete prompt (${totalLength}/${maxPromptLength} chars):`, prompt);
  }
}
