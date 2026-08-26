import { CUSTOM_ACTION_SECURITY_PATTERNS } from "../config/custom-actions.js";
import { MAX_PROMPT_APPEND_LENGTH } from "../config/book-creation.js";
import { COMPANION_ASK_MIN_CHARS, COMPANION_ASK_MAX_CHARS } from "../config/story.js";
import { cleanText, removeControlCharacters } from "./text-processing.js";

// ============================================================================
// PROMPT APPEND SECURITY & SANITIZATION
// ============================================================================

/**
 * Result of validating a promptAppend value
 */
export interface PromptAppendValidationResult {
  /** Whether the value passed all security checks */
  valid: boolean;
  /** Sanitized value (safe to use). Empty string if input was null/undefined. */
  sanitized: string;
  /** Rejection reason, if invalid */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Prompt-injection patterns specific to promptAppend (broader than custom
// actions because the appended text goes directly into the AI prompt).
// ---------------------------------------------------------------------------

export const PROMPT_APPEND_SECURITY_PATTERNS: RegExp[] = [
  ...CUSTOM_ACTION_SECURITY_PATTERNS,

  // HTML/XML injection
  /<script[\s>]/i,
  /<\s*!\[CDATA\[/i,

  // Encoded / base64 payloads
  /(?:base64|b64)[\s:]*[A-Za-z0-9+/]{40,}={0,2}/i,

  // System-level prompt overrides
  /\b(?:override|disable|bypass)\s+(?:all\s+)?(?:safety|filter|guardrail|restriction)/i,

  // Role-switching
  /\byou\s+are\s+(?:now\s+)?(?:an?\s+)?(?:assistant|chatbot|ai|model|system|developer)/i,

  // Prompt leakage attempts
  /output\s+(?:the\s+)?(?:full|entire|complete)\s+(?:prompt|system|instructions)/i,
];

// ---------------------------------------------------------------------------
// Valid-text pattern — more permissive than custom actions because promptAppend
// supports natural narrative instructions in any language.
// ---------------------------------------------------------------------------

/**
 * Pattern for valid promptAppend characters.
 * Allows Unicode letters/numbers, spaces, newlines, and common punctuation.
 */
export const PROMPT_APPEND_VALID_TEXT_PATTERN = /^[\p{L}\p{N}\s.,!?;:'"()\-[\]{}@#$%^&*+=_~/\\|`<>]+$/u;

/**
 * Sanitizes a raw promptAppend value.
 *
 * Strips control characters, HTML tags, normalises Unicode, trims, and
 * caps the length at `MAX_PROMPT_APPEND_LENGTH`.
 *
 * This is a pure function — safe to reuse at any layer (route + appending site).
 *
 * @param raw - Raw input value (string, null, or undefined)
 * @returns Sanitized string (empty if input was falsy or stripped to nothing)
 */
export function sanitizePromptAppend(raw: string | null | undefined): string {
  if (!raw || typeof raw !== 'string') return '';

  let cleaned = cleanText(raw);

  cleaned = removeControlCharacters(cleaned);
  cleaned = cleaned.trim();

  if (cleaned.length > MAX_PROMPT_APPEND_LENGTH) {
    cleaned = cleaned.slice(0, MAX_PROMPT_APPEND_LENGTH);
  }

  return cleaned;
}

/**
 * Validates and sanitizes a promptAppend value.
 *
 * Returns a {@link PromptAppendValidationResult} with:
 * - `valid: false` + `reason` when the value is rejected outright
 * - `valid: true` + clean `sanitized` value when it passes all checks
 * - `sanitized` is always the securely-cleaned version, regardless of validity
 *
 * @param raw - Raw input value
 * @returns Validation result with sanitized value
 *
 * @example
 * ```typescript
 * const result = validatePromptAppend("Make the story scarier");
 * if (!result.valid) {
 *   return res.status(400).json({ error: result.reason });
 * }
 * useValue(result.sanitized);
 * ```
 */
export function validatePromptAppend(raw: string | null | undefined): PromptAppendValidationResult {
  // 1. Sanitize first (strip dangerous characters)
  const sanitized = sanitizePromptAppend(raw);

  // 2. Empty after sanitization → allow (treated as "no input")
  if (!sanitized) {
    return { valid: true, sanitized: '' };
  }

  // 3. Normalise for pattern matching
  const normalized = sanitized.normalize('NFKC');

  // 4. Check for prompt injection patterns
  for (const pattern of PROMPT_APPEND_SECURITY_PATTERNS) {
    if (pattern.test(normalized)) {
      return {
        valid: false,
        sanitized,
        reason: 'Input contains a pattern that looks like prompt injection',
      };
    }
  }

  // 5. Valid character check (rejects control chars, zero-width, etc.)
  if (!PROMPT_APPEND_VALID_TEXT_PATTERN.test(normalized)) {
    return {
      valid: false,
      sanitized,
      reason: 'Input contains invalid characters',
    };
  }

  return { valid: true, sanitized };
}

/**
 * Sanitizes a raw companion question.
 * Normalizes Unicode, strips control characters & HTML tags, allows emojis, and caps to COMPANION_ASK_MAX_CHARS.
 */
export function sanitizeCompanionQuestion(raw: string | null | undefined): string {
  if (!raw || typeof raw !== 'string') return '';

  let cleaned = cleanText(raw);
  cleaned = removeControlCharacters(cleaned);
  cleaned = cleaned.normalize('NFKC')
    .replace(/[^\p{L}\p{M}\p{N}\p{P}\p{Sc}\p{Sm}\p{Extended_Pictographic}\p{So}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length > COMPANION_ASK_MAX_CHARS) {
    cleaned = cleaned.slice(0, COMPANION_ASK_MAX_CHARS);
  }

  return cleaned;
}

/**
 * Validates a companion question for malicious injection patterns and character bounds.
 */
export function validateCompanionQuestion(raw: string | null | undefined): { valid: boolean; sanitized: string; reason?: string } {
  const sanitized = sanitizeCompanionQuestion(raw);

  if (!sanitized) {
    return { valid: false, sanitized: '', reason: 'Question is required' };
  }

  if (sanitized.length < COMPANION_ASK_MIN_CHARS) {
    return {
      valid: false,
      sanitized,
      reason: `Question must be at least ${COMPANION_ASK_MIN_CHARS} characters`,
    };
  }

  for (const pattern of PROMPT_APPEND_SECURITY_PATTERNS) {
    if (pattern.test(sanitized)) {
      return {
        valid: false,
        sanitized,
        reason: 'This question contains text that is not allowed',
      };
    }
  }

  return { valid: true, sanitized };
}
