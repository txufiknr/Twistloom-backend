/**
 * Password Validation Utilities
 * 
 * Provides comprehensive password strength validation to ensure
 * users create secure passwords that meet security best practices.
 * 
 * Validation Requirements:
 * - Minimum 8 characters, maximum 128 characters
 * - At least one uppercase letter
 * - At least one lowercase letter
 * - At least one number
 * - At least one special character
 * - Must not contain common password patterns
 * 
 * @example
 * ```typescript
 * import { validatePasswordStrength } from '../utils/password-validation.js';
 * 
 * const result = validatePasswordStrength('weak');
 * if (!result.valid) {
 *   console.error(result.errors); // ['Password must be at least 8 characters long', ...]
 * }
 * 
 * const strongResult = validatePasswordStrength('Str0ngP@ssw0rd!');
 * console.log(strongResult.valid); // true
 * ```
 */

/**
 * Result of password strength validation
 */
export interface PasswordValidationResult {
  /** Whether the password meets all requirements */
  valid: boolean;
  /** Array of error messages for failed validations */
  errors: string[];
}

/**
 * Common passwords that should be rejected
 */
const COMMON_PASSWORDS = [
  'password',
  '123456',
  '12345678',
  'qwerty',
  'abc123',
  'monkey',
  'master',
  'dragon',
  '111111',
  'baseball',
  'iloveyou',
  'trustno1',
  'sunshine',
  'princess',
  'admin',
  'welcome',
  'shadow',
  'ashley',
  'football',
  'jesus',
  'michael',
  'ninja',
  'mustang',
  'password1',
];

/**
 * Validates password strength against security requirements
 * 
 * @param password - The password to validate
 * @returns Validation result with validity status and error messages
 * 
 * @example
 * ```typescript
 * const result = validatePasswordStrength('Str0ngP@ssw0rd!');
 * if (result.valid) {
 *   // Password is strong enough
 * } else {
 *   // Show errors to user
 *   console.error(result.errors);
 * }
 * ```
 */
export function validatePasswordStrength(password: string): PasswordValidationResult {
  const errors: string[] = [];

  // Length validation
  if (password.length < 8) {
    errors.push('Password must be at least 8 characters long');
  }
  if (password.length > 128) {
    errors.push('Password must not exceed 128 characters');
  }

  // Character type validation
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }
  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number');
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    errors.push('Password must contain at least one special character');
  }

  // Common password validation (exact match only - entire password must match a common password)
  const lowercasePassword = password.toLowerCase();
  if (COMMON_PASSWORDS.includes(lowercasePassword)) {
    errors.push('Password is too common');
  }

  // Sequential characters validation (e.g., "123", "abc")
  if (hasSequentialChars(password)) {
    errors.push('Password contains sequential characters (e.g., "123", "abc")');
  }

  // Repeated characters validation (e.g., "aaa", "111")
  if (hasRepeatedChars(password)) {
    errors.push('Password contains repeated characters (e.g., "aaa", "111")');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Checks if password contains sequential characters
 * 
 * @param password - The password to check
 * @returns True if sequential characters are found
 */
function hasSequentialChars(password: string): boolean {
  const lower = password.toLowerCase();
  
  for (let i = 0; i < lower.length - 2; i++) {
    const a = lower.charCodeAt(i);
    const b = lower.charCodeAt(i + 1);
    const c = lower.charCodeAt(i + 2);
    
    // Check for ascending sequences (e.g., "abc", "123")
    if (b === a + 1 && c === a + 2) {
      return true;
    }
    
    // Check for descending sequences (e.g., "cba", "321")
    if (b === a - 1 && c === a - 2) {
      return true;
    }
  }
  
  return false;
}

/**
 * Checks if password contains repeated characters
 * 
 * @param password - The password to check
 * @returns True if repeated characters are found
 */
function hasRepeatedChars(password: string): boolean {
  for (let i = 0; i < password.length - 2; i++) {
    const char = password[i];
    if (char === password[i + 1] && char === password[i + 2]) {
      return true;
    }
  }
  
  return false;
}
