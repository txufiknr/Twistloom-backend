/**
 * Content Safety Service — AI Waterfall Safety Scrubber
 *
 * Provides multi-provider safety signal normalization, creative-contextual
 * false-positive detection, and pre-generation input classification.
 *
 * When Provider A returns a safety block on a legitimate creative prompt
 * (e.g. fantasy combat, horror investigation), the system detects the false
 * positive and reroutes to Provider B instead of penalizing the user.
 *
 * @see docs/roadmap/TRUST_AND_SAFETY_ROADMAP.md §TS.5
 */

import { matchesCreativeWhitelist } from "../config/custom-actions.js";
import { recordViolationEvent } from "./trust-safety.js";

// ============================================================================
// Types
// ============================================================================

export interface SafetyClassification {
  /** Whether this is a genuine policy violation or suspected creative false positive */
  isGenuineViolation: boolean;
  /** Confidence score (0-1) that this is a genuine violation */
  confidence: number;
  /** Human-readable reason for the classification */
  reason: string;
  /** Whether this prompt should be retried with an alternate provider */
  shouldRetryWithAlternateProvider: boolean;
  /** Whether this prompt should be escalated (logged + user penalized) */
  shouldEscalate: boolean;
  /** Violation type if genuine */
  violationType?: 'ai_policy' | 'prompt_injection' | 'content_policy';
}

export interface ProviderSafetySignal {
  /** Provider that returned the safety block */
  provider: string;
  /** Model that returned the safety block */
  model: string;
  /** Raw error message from the provider */
  rawError: string;
  /** Normalized safety code from classifyGenAIError */
  normalizedCode: string;
  /** The original prompt that was blocked */
  prompt: string;
  /** User ID (if available) */
  userId?: string;
}

// ============================================================================
// Safety Signal Normalization
// ============================================================================

/**
 * Provider-specific safety error patterns.
 * Maps raw error messages to normalized safety categories.
 */
const PROVIDER_SAFETY_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  category: 'csam' | 'violence' | 'hate' | 'sexual' | 'self_harm' | 'harassment' | 'spam' | 'injection' | 'unknown';
  providers: readonly string[];
}> = [
  // CSAM — always genuine, never retry
  { pattern: /child.*sexual|csam|minor.*sexual|underage/i, category: 'csam', providers: ['gemini', 'groq', 'mistral', 'cohere', 'openai', 'nvidia'] },
  // Real-world violence (not fictional)
  { pattern: /real.*(violence|threat|harm)|actual.*weapon|terrorist|extremist/i, category: 'violence', providers: ['gemini', 'groq', 'mistral', 'cohere', 'openai', 'nvidia'] },
  // Hate speech
  { pattern: /hate.*speech|racial|ethnic.*slur|discriminatory/i, category: 'hate', providers: ['gemini', 'groq', 'mistral', 'cohere', 'openai', 'nvidia'] },
  // Explicit sexual content (non-fictional context)
  { pattern: /sexually.*explicit|pornographic|nsfw/i, category: 'sexual', providers: ['gemini', 'groq', 'mistral', 'cohere', 'openai', 'nvidia'] },
  // Self-harm encouragement
  { pattern: /self.*harm|suicide.*encourag|cut.*yourself/i, category: 'self_harm', providers: ['gemini', 'groq', 'mistral', 'cohere', 'openai', 'nvidia'] },
  // Harassment / bullying
  { pattern: /harass|bully|stalk|intimidat/i, category: 'harassment', providers: ['gemini', 'groq', 'mistral', 'cohere', 'openai', 'nvidia'] },
  // Generic safety block (Gemini-style)
  { pattern: /safety.*block|blocked.*safety|content.*policy.*violat/i, category: 'unknown', providers: ['gemini', 'groq', 'mistral', 'cohere', 'openai', 'nvidia'] },
];

/**
 * Maps a raw provider safety error to a normalized safety category.
 */
function normalizeSafetyCategory(rawError: string, provider: string): string {
  const lower = rawError.toLowerCase();
  for (const entry of PROVIDER_SAFETY_PATTERNS) {
    if (entry.providers.includes(provider) && entry.pattern.test(lower)) {
      return entry.category;
    }
  }
  return 'unknown';
}

// ============================================================================
// Pre-Generation Input Classification
// ============================================================================

/**
 * Classifies a user prompt before it reaches any AI provider.
 *
 * This is the Layer 1 pre-check that determines whether a prompt:
 * 1. Contains genuine policy violations (block immediately)
 * 2. Matches creative fiction patterns (allow with provider fallback)
 * 3. Is ambiguous (allow but log for monitoring)
 *
 * @param prompt - The user's raw input text
 * @param userId - The user ID for telemetry logging
 * @returns Classification result with recommended action
 */
export function classifyPromptSafety(
  prompt: string,
  _userId?: string,
): SafetyClassification {
  const trimmed = prompt.trim();

  // 1. Check for genuine hard-block patterns (real-world harm indicators)
  const hardBlockPatterns: ReadonlyArray<{ pattern: RegExp; reason: string; type: SafetyClassification['violationType'] }> = [
    { pattern: /\bCSAM\b|child\s*sexual|minor\s*explicit/i, reason: 'CSAM content', type: 'ai_policy' },
    { pattern: /\b(real|actual)\s+(weapon|explosive|chemical)\s+(synthesis|instruction|recipe)/i, reason: 'Real-world weapon synthesis', type: 'ai_policy' },
    { pattern: /\b(terrorist|extremist|jihad|bomb\s*making)\b/i, reason: 'Terrorism/extremism', type: 'ai_policy' },
    { pattern: /\b(deepfake|non\s*consensual\s*(intimate|sexual))/i, reason: 'Non-consensual deepfake', type: 'ai_policy' },
  ];

  for (const { pattern, reason, type } of hardBlockPatterns) {
    if (pattern.test(trimmed)) {
      return {
        isGenuineViolation: true,
        confidence: 0.95,
        reason,
        shouldRetryWithAlternateProvider: false,
        shouldEscalate: true,
        violationType: type,
      };
    }
  }

  // 2. Check for prompt injection patterns (Layer 1 defense)
  const injectionPatterns: ReadonlyArray<RegExp> = [
    /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
    /reveal\s+.*(prompt|system|instructions)/i,
    /you\s+are\s+now\s+(a\s+)?(hacker|attacker|malicious)/i,
    /bypass\s+(all\s+)?(safety|filter|guardrail)/i,
    /override\s+(all\s+)?(safety|filter|restriction)/i,
  ];

  for (const pattern of injectionPatterns) {
    if (pattern.test(trimmed)) {
      return {
        isGenuineViolation: true,
        confidence: 0.85,
        reason: 'Prompt injection attempt',
        shouldRetryWithAlternateProvider: false,
        shouldEscalate: true,
        violationType: 'prompt_injection',
      };
    }
  }

  // 3. Check creative whitelist — recognized fiction patterns
  if (matchesCreativeWhitelist(trimmed)) {
    return {
      isGenuineViolation: false,
      confidence: 0.1,
      reason: 'Creative fiction whitelist match',
      shouldRetryWithAlternateProvider: true,
      shouldEscalate: false,
    };
  }

  // 4. Default: allow but monitor
  return {
    isGenuineViolation: false,
    confidence: 0.3,
    reason: 'No hard-block patterns detected',
    shouldRetryWithAlternateProvider: true,
    shouldEscalate: false,
  };
}

// ============================================================================
// Provider Safety Signal Evaluation
// ============================================================================

/**
 * Evaluates a safety block signal from an AI provider and determines
 * whether to retry with an alternate provider or escalate.
 *
 * This is the core of the waterfall safety fallback logic:
 * - If the safety block matches a creative fiction pattern → retry with next provider
 * - If the safety block is a genuine policy violation → escalate and block
 * - If the safety block is ambiguous → retry with next provider and log soft event
 *
 * @param signal - The safety signal from the provider
 * @returns Classification result with recommended action
 */
export function evaluateProviderSafetySignal(
  signal: ProviderSafetySignal,
): SafetyClassification {
  const { provider, rawError, prompt, userId } = signal;
  const normalizedCategory = normalizeSafetyCategory(rawError, provider);

  // 1. Hard-block categories — never retry, always escalate
  const hardBlockCategories = ['csam', 'violence', 'hate', 'self_harm', 'sexual', 'harassment'];
  if (hardBlockCategories.includes(normalizedCategory)) {
    // Log violation event for forensic telemetry
    if (userId) {
      recordViolationEvent({
        userId,
        violationType: 'ai_policy',
        source: 'ai_moderator',
        confidenceScore: 0.9,
        rawInput: prompt.slice(0, 500),
        detectionDetails: {
          provider,
          model: signal.model,
          safetyCategory: normalizedCategory,
          rawError: rawError.slice(0, 200),
          action: 'escalated',
        },
      }).catch((err) => console.error(`[ContentSafety] Failed to log violation event:`, err));
    }

    return {
      isGenuineViolation: true,
      confidence: 0.9,
      reason: `Genuine ${normalizedCategory} violation from ${provider}`,
      shouldRetryWithAlternateProvider: false,
      shouldEscalate: true,
      violationType: 'ai_policy',
    };
  }

  // 2. Check if the prompt matches creative fiction patterns
  if (matchesCreativeWhitelist(prompt)) {
    // Creative content flagged by provider — likely false positive
    // Log soft event and retry with next provider
    if (userId) {
      recordViolationEvent({
        userId,
        violationType: 'ai_policy',
        source: 'ai_moderator',
        confidenceScore: 0.2,
        rawInput: prompt.slice(0, 500),
        detectionDetails: {
          provider,
          model: signal.model,
          safetyCategory: normalizedCategory,
          rawError: rawError.slice(0, 200),
          action: 'retrying_alternate_provider',
          reason: 'creative_whitelist_match',
        },
      }).catch((err) => console.error(`[ContentSafety] Failed to log soft event:`, err));
    }

    return {
      isGenuineViolation: false,
      confidence: 0.15,
      reason: `Creative content falsely flagged by ${provider} — retrying alternate provider`,
      shouldRetryWithAlternateProvider: true,
      shouldEscalate: false,
    };
  }

  // 3. Ambiguous safety block — retry with next provider and log for monitoring
  if (userId) {
    recordViolationEvent({
      userId,
      violationType: 'ai_policy',
      source: 'ai_moderator',
      confidenceScore: 0.5,
      rawInput: prompt.slice(0, 500),
      detectionDetails: {
        provider,
        model: signal.model,
        safetyCategory: normalizedCategory,
        rawError: rawError.slice(0, 200),
        action: 'retrying_ambiguously',
      },
    }).catch((err) => console.error(`[ContentSafety] Failed to log ambiguous event:`, err));
  }

  return {
    isGenuineViolation: false,
    confidence: 0.5,
    reason: `Ambiguous safety block from ${provider} (${normalizedCategory}) — retrying`,
    shouldRetryWithAlternateProvider: true,
    shouldEscalate: false,
  };
}

// ============================================================================
// Utility: Is Safety Retry Allowed?
// ============================================================================

/**
 * Determines whether a safety-blocked prompt should be retried with the
 * next provider in the waterfall, based on the provider and error pattern.
 *
 * @param provider - Provider that returned the safety block
 * @param rawError - Raw error message
 * @param retryCount - How many providers have already been tried
 * @param maxRetries - Maximum number of safety retries (default 2)
 * @returns true if retry is allowed
 */
export function shouldRetrySafetyBlock(
  provider: string,
  rawError: string,
  retryCount: number,
  maxRetries: number = 2,
): boolean {
  if (retryCount >= maxRetries) return false;

  const signal: ProviderSafetySignal = {
    provider,
    model: '',
    rawError,
    normalizedCode: 'SAFETY_BLOCKED',
    prompt: '',
  };

  const classification = evaluateProviderSafetySignal(signal);
  return classification.shouldRetryWithAlternateProvider;
}
