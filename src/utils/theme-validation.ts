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

import {
  THEME_BLACKLIST,
  THEME_SUSPICIOUS_PATTERNS,
  INVALID_POV_PATTERNS,
  INVALID_THEME_PATTERNS,
  MIN_THEME_LENGTH,
  MAX_THEME_LENGTH,
} from '../config/theme-validation.js';
import type {
  HeuristicValidationResult,
  AIValidationResult,
  ThemeValidationResult,
} from '../types/theme-validation.js';
import { executePromptForJSON } from './prompt.js';
import { AI_CHAT_CONFIG_DEFAULT } from '../config/ai-chat.js';
import { AI_CHAT_MODELS_WRITING } from '../config/ai-clients.js';
import { hasKeywords } from './text-processing.js';

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
  return `Analyze this story theme for policy violations:
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
   - Shell commands

Return JSON with:
- isViolating: boolean (true if any violation detected)
- category: "INAPPROPRIATE_CONTENT" | "SUSPICIOUS_PATTERN" | "INVALID_THEME" | "POLICY_VIOLATION" | "OTHER"
- confidence: number (0.0 to 1.0)
- detectedItems: array of objects with:
  - type: "word" | "pattern" | "pov_instruction" | "invalid_format" | "other"
  - value: the detected text
  - context: brief context of where it was found
  - reason: explanation of why it's a violation
- suggestion: string (how to fix the issue, or empty string if valid)

If the theme is valid and safe, return:
{
  "isViolating": false,
  "category": "NONE",
  "confidence": 1.0,
  "detectedItems": [],
  "suggestion": ""
}`;
}

/**
 * Schema definition for AI validation response
 * 
 * Matches the flat object pattern used in the codebase (see schema/story.ts)
 * instead of nested JSON Schema format.
 */
const THEME_VALIDATION_SCHEMA = {
  isViolating: { type: 'boolean' },
  category: { type: 'string' },
  confidence: { type: 'number' },
  detectedItems: { type: 'array', items: { type: 'object' } },
  suggestion: { type: 'string' }
} as const;

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

  try {
    const response = await executePromptForJSON<AIValidationResult>({
      prompt,
      configs: {
        schema: THEME_VALIDATION_SCHEMA,
        requiredFields: ['isViolating', 'category'],
        fallbackField: 'isViolating',
        baseOptions: {
          config: AI_CHAT_CONFIG_DEFAULT,
          modelSelection: AI_CHAT_MODELS_WRITING,
          context: 'theme-validation',
          logPrompts: true,
        },
      },
      jsonStructure: JSON.stringify(THEME_VALIDATION_SCHEMA, null, 2),
    });

    if (!response.result) {
      console.error('[validateThemeWithAI] AI response result is undefined');
      // If AI fails, default to allowing the theme (fail-safe)
      return {
        isViolating: false,
        category: 'OTHER',
        confidence: 0.0,
        detectedItems: [],
        suggestion: '',
      };
    }

    return response.result;
  } catch (error) {
    console.error('[validateThemeWithAI] AI validation failed:', error);
    // If AI fails completely, default to allowing the theme (fail-safe)
    return {
      isViolating: false,
      category: 'OTHER',
      confidence: 0.0,
      detectedItems: [],
      suggestion: '',
    };
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
 * @returns Complete validation result
 * 
 * @example
 * ```typescript
 * const result = await validateTheme("A magical adventure in an enchanted forest");
 * // Returns: { isValid: true, heuristicResult: {...}, aiResult: {...} }
 * ```
 */
export async function validateTheme(theme: string): Promise<ThemeValidationResult> {
  // 1. Heuristic validation (fast)
  const heuristicResult = validateThemeHeuristic(theme);

  if (!heuristicResult.isValid) {
    // Heuristic failed - return immediately
    return {
      isValid: false,
      heuristicResult,
    };
  }

  // 2. AI validation (smart)
  const aiResult = await validateThemeWithAI(theme);

  if (aiResult.isViolating) {
    // AI validation failed
    return {
      isValid: false,
      heuristicResult,
      aiResult,
    };
  }

  // Both validations passed
  return {
    isValid: true,
    heuristicResult,
    aiResult,
  };
}
