/**
 * Theme Validation Utility Module
 * 
 * Provides heuristic and AI-based validation for story theme inputs.
 * Implements two-layer validation approach:
 * 1. Heuristic validation (fast): blacklist words, suspicious patterns, POV instructions
 * 2. AI validation (smart): contextual analysis for policy violations
 * 
 * Aligns with frontend theme validation specification for consistency.
 */

import { THEME_BLACKLIST, THEME_SUSPICIOUS_PATTERNS, INVALID_POV_PATTERNS, INVALID_THEME_PATTERNS, MIN_THEME_LENGTH, MAX_THEME_LENGTH } from '../config/theme-validation.js';
import { THEME_VALIDATION_CATEGORIES, THEME_VALIDATION_DETECTED_ITEM_TYPES, THEME_VALIDATION_SCHEMA } from '../schema/book.js';
import { BOOK_TITLE_LENGTH, MAX_CHARACTER_AGE, MIN_CHARACTER_AGE } from '../config/story.js';
import { AI_CHAT_CONFIG_DEFAULT } from '../config/ai-chat.js';
import { AI_CHAT_MODELS_VALIDATOR } from '../config/ai-clients.js';
import { executePromptForJSON, formatOneOf } from './prompt.js';
import { hasKeywords } from './text-processing.js';
import type { HeuristicValidationResult, AIValidationResult, ThemeValidationResult, ThemeValidationErrorDetails, ThemeValidationCategory } from '../types/theme-validation.js';
import type { ProgressCallback } from '../types/sse.js';
import type { Response } from "express";
import type { ErrorResponse } from './error.js';

/**
 * Performs heuristic validation on theme input
 * 
 * Fast validation that checks:
 * - Blacklist words
 * - Suspicious patterns
 * - POV instructions
 * - Basic format validation
 * 
 * @param theme - Theme string to validate
 * @returns Heuristic validation result with detected violations
 * 
 * @example
 * ```typescript
 * const result = validateThemeHeuristic("A story about prophet muhammad");
 * // Returns: { isValid: false, detectedWords: ["prophet muhammad"], detectedPatterns: [], povViolation: false }
 * ```
 */
export function validateThemeHeuristic(theme: string): HeuristicValidationResult {
  const normalizedTheme = theme.toLowerCase().trim();
  const detectedPatterns: string[] = [];
  let povViolation = false;

  // 1. Check length constraints
  if (normalizedTheme.length < MIN_THEME_LENGTH) {
    return {
      isValid: false,
      detectedWords: [],
      detectedPatterns: [`Theme too short (min ${MIN_THEME_LENGTH} characters)`],
      povViolation: false,
    };
  }

  if (normalizedTheme.length > MAX_THEME_LENGTH) {
    return {
      isValid: false,
      detectedWords: [],
      detectedPatterns: [`Theme too long (max ${MAX_THEME_LENGTH} characters)`],
      povViolation: false,
    };
  }

  // 2. Check blacklist words (using word boundaries to prevent false positives)
  const detectedWords = hasKeywords(normalizedTheme, THEME_BLACKLIST);

  // 3. Check suspicious patterns
  for (const pattern of THEME_SUSPICIOUS_PATTERNS) {
    if (pattern.test(theme)) {
      detectedPatterns.push(pattern.source);
    }
  }

  // 4. Check POV instructions
  for (const pattern of INVALID_POV_PATTERNS) {
    if (pattern.test(theme)) {
      povViolation = true;
      detectedPatterns.push(`Invalid POV instruction: ${pattern.source}`);
    }
  }

  // 5. Check invalid theme patterns (gibberish, etc.)
  for (const pattern of INVALID_THEME_PATTERNS) {
    if (pattern.test(theme)) {
      detectedPatterns.push(`Invalid theme format: ${pattern.source}`);
    }
  }

  const isValid = detectedWords.length === 0 && detectedPatterns.length === 0 && !povViolation;

  return {
    isValid,
    detectedWords,
    detectedPatterns,
    povViolation,
  };
}

/**
 * AI validation prompt for theme analysis
 * 
 * @param theme - Theme string to validate
 * @returns Formatted prompt for AI model
 */
function createThemeValidationPrompt(theme: string): string {
  return `Analyze this story theme from user input for policy violations:
"""
${theme}
"""

Determine if this theme violates any content policies. Check for:

1. INAPPROPRIATE CONTENT:
   - Sexual content, pornography, rape, incest
   - Hate speech, racism, antisemitism, Nazi references
   - Drug references (heroin, cocaine, meth, etc.)
   - Religious figures in fictional contexts (prophet muhammad, jesus christ, buddha, etc.)
   - Public figures in inappropriate contexts

2. INVALID THEME FORMAT:
   - Gibberish or random text (e.g., "asdfghjkl", "xyz abc 123")
   - Single words with no context (e.g., "cat", "run", "blue")
   - Non-story content (e.g., "hello world", "test", "checking this")
   - Questions instead of themes (e.g., "how do I write a story?")
   - Commands/instructions (e.g., "generate something", "make it good")
   - Too short/insufficient detail (less than 3 meaningful words)
   - Completely unrelated phrases (e.g., "buy milk", "call mom")
   - Repetitive characters (e.g., "aaaaa", "test test test test")
   - URLs, email addresses, phone numbers
   - Code snippets or technical jargon unrelated to stories

3. POV INSTRUCTIONS (CRITICAL):
   Twistloom STRICTLY generates 1st person POV stories only.
   Reject any input that explicitly requests non-first person POV.
   
   Invalid POV inputs:
   - "Tell this story in third person"
   - "Write from an omniscient perspective"
   - "Use second person POV"
   - "Narrate from outside the character"
   - "Tell it as if observing from above"
   - "Use objective point of view"
   - "Switch between different POVs"
   - Any explicit mention of: "third person", "second person", "omniscient", "objective", "multiple perspectives", "outside observer", "bird's eye view"
   
   Valid POV handling:
   - No POV specification = default 1st person POV (accepted)
   - Implicit 1st person = accepted (e.g., "I want a story about...", "My character...")
   - Any explicit non-1st person instruction = rejected

4. SUSPICIOUS PATTERNS:
   - SQL injection attempts
   - HTML/JavaScript injection
   - Code execution attempts
   - Shell commands`;
}

/**
 * Performs AI validation on theme input
 * 
 * Smart validation that uses AI to analyze theme for:
 * - Contextual inappropriate content
 * - Invalid theme format (gibberish, non-story content)
 * - POV instruction violations
 * - Other policy violations
 * 
 * @param theme - Theme string to validate
 * @returns AI validation result with detailed analysis
 * 
 * @example
 * ```typescript
 * const result = await validateThemeWithAI("Tell a story about a dragon in third person perspective");
 * // Returns: { isViolating: true, category: "INVALID_THEME", confidence: 0.98, detectedItems: [...], suggestion: "..." }
 * ```
 */
export async function validateThemeWithAI(theme: string): Promise<AIValidationResult> {
  const prompt = createThemeValidationPrompt(theme);
  const failSafeResult: AIValidationResult = {
    isViolating: false,
    category: 'OTHER',
    confidence: 0.0,
    detectedItems: [],
    suggestion: '',
    comment: '',
    language: 'en',
    titleIdea: '',
    mcCandidate: {}
  };

  try {
    const response = await executePromptForJSON<AIValidationResult>({
      prompt,
      configs: {
        schema: THEME_VALIDATION_SCHEMA,
        requiredFields: [
          'isViolating',
          'category',
          'confidence',
          'detectedItems',
          'language'
        ] satisfies (keyof AIValidationResult)[],
        fallbackField: 'suggestion',
        baseOptions: {
          config: AI_CHAT_CONFIG_DEFAULT,
          modelSelection: AI_CHAT_MODELS_VALIDATOR,
          context: 'theme-validation',
          logPrompts: true,
        },
      },
      fieldInstructions: `- isViolating: boolean (true if any violation detected)
- category: ${formatOneOf(THEME_VALIDATION_CATEGORIES, ' | ')}
- confidence: number (0.0 to 1.0)
- detectedItems: array of objects with:
  - type: ${formatOneOf(THEME_VALIDATION_DETECTED_ITEM_TYPES, ' | ')}
  - value: the detected text
  - context: brief context of where it was found
  - reason: explanation of why it's a violation
- suggestion: 1-sentence (how to fix the issue, or empty string if theme is valid)
- comment: max 250 chars (a complimentary comment about theme idea. If the theme is invalid, provide an empty string. Use exciting, suspenseful language that matches the thriller genre tone.)
- language: detected language code of theme input (ISO 639-1)
- titleIdea: book title idea for the story based on the theme (${BOOK_TITLE_LENGTH}). If the theme is invalid, provide an empty string. Else if provided in theme, use it.
- mcCandidate: infer a character whose personality makes the theme more psychologically dangerous for them specifically.
  - name: if MC's name provided in theme input, strictly use it. If not provided, generate unusual (rare) but memorable name idea based on age and language context.
  - knownName: Preferred alias or nick referred by other characters.
  - bio: infer from theme if provided. Must include at least one psychological trait that will be used against them.
- futureNotes: add only if theme input is valid and provide any forward-looking narrative obligation. Don't invent.
- characters: add only if theme input is valid and provide any side characters information (beside MC). Don't invent.
- characters.relationships: only between side characters (excluding MC). Empty if characters is less than two.

Comment structure (only if theme is valid):
- Use creative & thriller-themed wording
- Match the SAME LANGUAGE as the theme input
- Express excitement and anticipation before generation

Comment example (use your own wording):
"This is a captivating and ominous concept, hinting at a gripping tale that.... So excited to bring your story to life. Let me plan and write the story—will be ready for you very soon!"`,
      jsonStructure: `{
  "isViolating": <boolean>,
  "category": "One of: ${formatOneOf(THEME_VALIDATION_CATEGORIES)}",
  "confidence": <number between 0.0 and 1.0>,
  "detectedItems": [
    {
      "type": "One of: ${formatOneOf(THEME_VALIDATION_DETECTED_ITEM_TYPES)}",
      "value": "...",
      "context": "...",
      "reason": "..."
    }
  ],
  "suggestion": "...",
  "comment": "...",
  "language": "<ISO 639-1 language code>",
  "titleIdea": "...",
  "mcCandidate": {
    "name": "Full Name",
    "knownName": "Preferred alias or nick",
    "age": <integer between ${MIN_CHARACTER_AGE} and ${MAX_CHARACTER_AGE}>,
    "gender": "One of: 'male', 'female'",
    "bio": "Trait-forward description. Include at least one psychological vulnerability."
  }
}`,
    });

    if (!response.result) {
      console.error('[validateThemeWithAI] ❌ AI response result is undefined');
      // If AI fails, default to allowing the theme (fail-safe)
      return failSafeResult;
    }

    return response.result;
  } catch (error) {
    console.error('[validateThemeWithAI] ❌ AI validation failed:', error);
    // If AI fails completely, default to allowing the theme (fail-safe)
    return failSafeResult;
  }
}

/**
 * Performs complete theme validation (heuristic + AI)
 * 
 * Orchestrates the two-layer validation approach:
 * 1. Fast heuristic validation (blacklist + patterns)
 * 2. Smart AI validation (contextual analysis)
 * 
 * If heuristic validation fails, returns immediately without AI validation.
 * If heuristic validation passes, proceeds to AI validation.
 * 
 * @param theme - Theme string to validate
 * @param onProgress - Optional callback for progress events (SSE)
 * @returns Complete validation result
 * 
 * @example
 * ```typescript
 * // Without progress callback (POST endpoint)
 * const result = await validateTheme("A magical adventure in an enchanted forest");
 * 
 * // With progress callback (SSE endpoint)
 * const result = await validateTheme(theme, (event) => {
 *   res.write(`data: ${JSON.stringify(event)}\n\n`);
 * });
 * ```
 */
export async function validateTheme(
  theme: string,
  onProgress?: ProgressCallback
): Promise<ThemeValidationResult> {
  // Emit validation start event
  await onProgress?.({ type: 'theme_validation_start' });

  // 1. Heuristic validation (fast)
  const heuristicResult = validateThemeHeuristic(theme);

  let result: ThemeValidationResult;
  if (heuristicResult.isValid) {
    // 2. AI validation (smart)
    const aiResult = await validateThemeWithAI(theme);
    result = {
      isValid: !aiResult.isViolating,
      heuristicResult,
      aiResult,
    };
  } else {
    // Heuristic failed - return immediately with validation complete event
    result = { isValid: false, heuristicResult };
  }

  // Emit validation complete event
  await onProgress?.({ type: 'theme_validation_complete', data: result });
  return result;
}

/**
 * Handles theme validation errors with structured response format
 * 
 * Returns error response matching frontend specification for validation errors.
 * Includes detected words, patterns, AI explanations, and suggestions.
 * 
 * @param res - Express response object
 * @param validationResult - Validation result from theme validation
 * @returns Express response with 400 status and structured error body
 * 
 * @example
 * ```typescript
 * const validationResult = await validateTheme(theme);
 * if (!validationResult.isValid) {
 *   return handleThemeValidationError(res, validationResult);
 * }
 * ```
 */
export function handleThemeValidationError(
  res: Response,
  validationResult: ThemeValidationResult,
  statusCode: number = 400
): Response {
  const { heuristicResult, aiResult } = validationResult;
  const { detectedItems = [], suggestion = '', confidence = 0 } = aiResult || {};
  const { detectedWords = [], detectedPatterns = [] } = heuristicResult || {};

  let category: ThemeValidationCategory = 'OTHER';
  let message = 'Your story theme is invalid.';

  // Extract information from heuristic result
  if (heuristicResult) {
    // Determine category from heuristic violations
    if (detectedWords.length > 0) {
      category = 'INAPPROPRIATE_CONTENT';
      message = 'Your story theme contains inappropriate content.';
    } else if (detectedPatterns.some(p => p.includes('Invalid POV'))) {
      category = 'INVALID_THEME';
      message = 'Your story theme contains invalid POV instructions.';
    } else if (detectedPatterns.some(p => p.includes('Invalid theme format'))) {
      category = 'INVALID_THEME';
      message = 'Your story theme is not a valid story theme.';
    } else if (detectedPatterns.length > 0) {
      category = 'SUSPICIOUS_PATTERN';
      message = 'Your story theme contains suspicious patterns.';
    }
  }

  // Extract information from AI result (overrides heuristic if available)
  if (aiResult && aiResult.isViolating) {
    category = aiResult.category;
    message = aiResult.category === 'INAPPROPRIATE_CONTENT'
      ? 'Your story theme contains inappropriate content.'
      : aiResult.category === 'INVALID_THEME'
      ? 'Your story theme is invalid.'
      : 'Your story theme violates content policies.';
  }

  const details: ThemeValidationErrorDetails = {
    category,
    detectedWords,
    detectedPatterns,
    detectedItems,
    confidence,
    suggestion,
  };

  // Build error response
  const errorResponse: ErrorResponse = {
    success: false,
    error: message,
    details,
  };

  // Log validation failure for monitoring
  console.warn(`[handleThemeValidationError] 🙅‍♀️ ${message}`, details);
  return res.status(statusCode).json(errorResponse);
}