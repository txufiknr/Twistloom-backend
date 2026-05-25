/**
 * Theme Validation Type Definitions
 * 
 * Defines TypeScript types for theme validation system including
 * validation results, error responses, and AI detection structures.
 * 
 * Aligns with frontend theme validation specification for consistency
 * across the application.
 */

/**
 * Theme validation error categories
 * 
 * These categories match the frontend specification and are used
 * to classify different types of validation failures.
 */
export type ThemeValidationCategory =
  | 'INAPPROPRIATE_CONTENT'
  | 'SUSPICIOUS_PATTERN'
  | 'INVALID_THEME'
  | 'POLICY_VIOLATION'
  | 'OTHER';

/**
 * Heuristic validation result
 *
 * Result from fast validation layer that checks:
 * - Blacklist words
 * - Suspicious patterns
 * - POV instructions
 * - Basic format validation
 *
 * @example
 * // Valid theme (no violations)
 * const validResult: HeuristicValidationResult = {
 *   isValid: true,
 *   detectedWords: [],
 *   detectedPatterns: [],
 *   povViolation: false
 * };
 *
 * @example
 * // Invalid theme (blacklist word detected)
 * const invalidResult: HeuristicValidationResult = {
 *   isValid: false,
 *   detectedWords: ['prophet muhammad'],
 *   detectedPatterns: [],
 *   povViolation: false
 * };
 *
 * @example
 * // Invalid theme (POV instruction detected)
 * const povResult: HeuristicValidationResult = {
 *   isValid: false,
 *   detectedWords: [],
 *   detectedPatterns: ['Invalid POV instruction: third\\sperson'],
 *   povViolation: true
 * };
 */
export interface HeuristicValidationResult {
  /** Whether the theme passed heuristic validation */
  isValid: boolean;
  /** List of detected blacklist words */
  detectedWords: string[];
  /** List of detected suspicious patterns */
  detectedPatterns: string[];
  /** Whether POV instruction violation was detected */
  povViolation: boolean;
}

/**
 * AI validation detected item
 *
 * Individual item detected by AI validation with context
 * and explanation of why it's a violation.
 *
 * @example
 * // Detected blacklist word
 * const wordItem: AIDetectedItem = {
 *   type: 'word',
 *   value: 'prophet muhammad',
 *   context: 'A story about prophet muhammad',
 *   reason: 'depicting religious figures in fictional stories'
 * };
 *
 * @example
 * // Detected POV instruction
 * const povItem: AIDetectedItem = {
 *   type: 'pov_instruction',
 *   value: 'third person',
 *   context: 'Tell this story in third person perspective',
 *   reason: 'explicit non-1st person POV instruction'
 * };
 */
export interface AIDetectedItem {
  /** Type of detected item */
  type: 'word' | 'pattern' | 'pov_instruction' | 'invalid_format' | 'other';
  /** The actual detected text or pattern */
  value: string;
  /** Context where the item was found */
  context: string;
  /** Explanation of why this is a violation */
  reason: string;
}

/**
 * AI validation result
 *
 * Result from smart validation layer that uses AI to analyze
 * theme for contextual policy violations.
 *
 * @example
 * // Valid theme
 * const validResult: AIValidationResult = {
 *   isViolating: false,
 *   category: 'NONE',
 *   confidence: 0.95,
 *   detectedItems: [],
 *   suggestion: ''
 * };
 *
 * @example
 * // Invalid theme (inappropriate content)
 * const invalidResult: AIValidationResult = {
 *   isViolating: true,
 *   category: 'INAPPROPRIATE_CONTENT',
 *   confidence: 0.98,
 *   detectedItems: [
 *     {
 *       type: 'word',
 *       value: 'prophet muhammad',
 *       context: 'A story about prophet muhammad',
 *       reason: 'depicting religious figures in fictional stories'
 *     }
 *   ],
 *   suggestion: 'Please avoid using real religious figures in your story theme.'
 * };
 */
export interface AIValidationResult {
  /** Whether the theme violates any content policies */
  isViolating: boolean;
  /** Category of the violation (or NONE if valid) */
  category: ThemeValidationCategory | 'NONE';
  /** Confidence score from 0.0 to 1.0 */
  confidence: number;
  /** List of detected items with details */
  detectedItems: AIDetectedItem[];
  /** Suggestion for how to fix the issue */
  suggestion: string;
  /** Complimentary comment about the theme idea using creative & thriller-themed wording in the same language as the input */
  comment: string;
  /** Index signature to satisfy Record<string, unknown> constraint */
  [key: string]: unknown;
}

/**
 * Complete theme validation result
 *
 * Orchestrated result from both heuristic and AI validation layers.
 * Includes results from both layers for comprehensive analysis.
 *
 * @example
 * // Valid theme (both layers passed)
 * const validResult: ThemeValidationResult = {
 *   isValid: true,
 *   heuristicResult: {
 *     isValid: true,
 *     detectedWords: [],
 *     detectedPatterns: [],
 *     povViolation: false
 *   },
 *   aiResult: {
 *     isViolating: false,
 *     category: 'NONE',
 *     confidence: 0.95,
 *     detectedItems: [],
 *     suggestion: ''
 *   }
 * };
 *
 * @example
 * // Invalid theme (heuristic failed, no AI check)
 * const heuristicFailed: ThemeValidationResult = {
 *   isValid: false,
 *   heuristicResult: {
 *     isValid: false,
 *     detectedWords: ['prophet muhammad'],
 *     detectedPatterns: [],
 *     povViolation: false
 *   }
 * };
 *
 * @example
 * // Invalid theme (heuristic passed, AI failed)
 * const aiFailed: ThemeValidationResult = {
 *   isValid: false,
 *   heuristicResult: {
 *     isValid: true,
 *     detectedWords: [],
 *     detectedPatterns: [],
 *     povViolation: false
 *   },
 *   aiResult: {
 *     isViolating: true,
 *     category: 'INVALID_THEME',
 *     confidence: 0.92,
 *     detectedItems: [
 *       {
 *         type: 'pov_instruction',
 *         value: 'third person',
 *         context: 'Tell this story in third person perspective',
 *         reason: 'explicit non-1st person POV instruction'
 *       }
 *     ],
 *     suggestion: 'Twistloom generates 1st person POV stories only. Remove POV instructions from your theme.'
 *   }
 * };
 */
export interface ThemeValidationResult {
  /** Whether the theme passed all validation checks */
  isValid: boolean;
  /** Result from heuristic validation layer */
  heuristicResult?: HeuristicValidationResult;
  /** Result from AI validation layer */
  aiResult?: AIValidationResult;
}

/**
 * Theme validation error response
 *
 * Error response format matching frontend specification.
 * Used when theme validation fails to provide structured
 * error information to the client.
 *
 * @example
 * // Error from heuristic validation (blacklist word)
 * const heuristicError: ThemeValidationError = {
 *   error: {
 *     type: 'VALIDATION_ERROR',
 *     code: 'THEME_INVALID',
 *     message: 'Your story theme contains inappropriate content.',
 *     details: {
 *       category: 'INAPPROPRIATE_CONTENT',
 *       detectedWords: ['prophet muhammad'],
 *       detectedPatterns: [],
 *       aiExplanation: undefined,
 *       suggestion: 'Please avoid using real religious figures in your story theme.'
 *     }
 *   }
 * };
 *
 * @example
 * // Error from AI validation (POV instruction)
 * const aiError: ThemeValidationError = {
 *   error: {
 *     type: 'VALIDATION_ERROR',
 *     code: 'THEME_INVALID',
 *     message: 'Your story theme contains invalid POV instructions.',
 *     details: {
 *       category: 'INVALID_THEME',
 *       detectedWords: [],
 *       detectedPatterns: ['Invalid POV instruction: third\\sperson'],
 *       aiExplanation: 'explicit non-1st person POV instruction',
 *       aiConfidence: 0.92,
 *       suggestion: 'Twistloom generates 1st person POV stories only. Remove POV instructions from your theme.'
 *     }
 *   }
 * };
 */
export interface ThemeValidationError {
  error: {
    /** Error type identifier */
    type: 'VALIDATION_ERROR';
    /** Error code for theme validation */
    code: 'THEME_INVALID';
    /** User-friendly error message */
    message: string;
    /** Detailed validation error information */
    details: ThemeValidationErrorDetails;
  }
}

export interface ThemeValidationErrorDetails {
  /** Category of the validation failure */
  category: ThemeValidationCategory;
  /** List of detected blacklist words */
  detectedWords: string[];
  /** List of detected suspicious patterns */
  detectedPatterns: string[];
  /** AI-generated explanation of the violation */
  detectedItems?: AIDetectedItem[];
  /** AI confidence score (0.0 to 1.0) */
  aiConfidence?: number;
  /** Suggestion for how to fix the issue */
  suggestion?: string;
}
