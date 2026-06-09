/**
 * Username validation and sanitization utilities
 */
import { APP_NAME_SLUG } from '../config/constants.js';
import { sanitizeTextForDB } from './text-processing.js';

export interface UsernameValidationResult {
  valid: boolean;
  errors: string[];
}

// Reserved usernames that should not be allowed (lowercase)
const RESERVED_USERNAMES = [
  APP_NAME_SLUG,
  'admin',
  'support',
  'root',
  'system',
  'null',
  'undefined',
];

/**
 * Sanitizes a raw string into a well-formed username candidate.
 *
 * Transformations applied (in order):
 * 1. HTML / control-char removal via sanitizeTextForDB
 * 2. Lowercase
 * 3. Spaces, dots, underscores, plus-signs → hyphens
 * 4. Any remaining non-alphanumeric-or-hyphen characters stripped
 * 5. Consecutive hyphens collapsed to one
 * 6. Leading / trailing hyphens stripped
 *
 * The output is a normalised candidate — it still needs to pass
 * validateUsername() to confirm length, reserved-word, etc. constraints.
 *
 * @example
 * sanitizeUsername('John Doe')         // 'john-doe'
 * sanitizeUsername('alice.smith')      // 'alice-smith'
 * sanitizeUsername('  --Bob-- ')       // 'bob'
 * sanitizeUsername('user@name!')       // 'username'
 */
export function sanitizeUsername(username: string): string {
  if (!username || typeof username !== 'string') return '';

  // Strip HTML entities / control characters
  const cleaned = sanitizeTextForDB(username.trim());

  // Lowercase
  const lower = cleaned.toLowerCase();

  // Replace common separators (spaces, dots, underscores, plus signs) with hyphens
  const hyphenated = lower.replace(/[\s._+]+/g, '-');

  // Remove any character that isn't a lowercase letter, digit, or hyphen
  const stripped = hyphenated.replace(/[^a-z0-9-]/g, '');

  // Collapse consecutive hyphens into one
  const collapsed = stripped.replace(/-{2,}/g, '-');

  // Strip leading / trailing hyphens
  return collapsed.replace(/^-+|-+$/g, '');
}

/**
 * Derives a username candidate from a display name or email address.
 *
 * Strategy:
 *   1. If `name` is provided and yields ≥ 3 chars after sanitisation, use it.
 *   2. Otherwise fall back to the email prefix (part before '@').
 *   3. Truncate to 25 chars to leave room for a deduplication suffix (e.g. "-12").
 *   4. Return 'user' if both sources are too short (last resort).
 *
 * The returned string is a raw candidate — it still needs to go through
 * sanitizeUsername() (which sanitizeUserData() does) and findUniqueUsername()
 * (for database-level deduplication).
 *
 * @example
 * convertNameOrEmailToUsername('john.doe@gmail.com', 'John Doe')  // 'john-doe'
 * convertNameOrEmailToUsername('alice@example.com', 'Alice')      // 'alice'
 * convertNameOrEmailToUsername('bob@example.com')                 // 'bob'
 * convertNameOrEmailToUsername('x@y.com', '')                     // 'x'
 */
export function convertNameOrEmailToUsername(email: string, name?: string): string {
  let base = '';

  if (name?.trim()) {
    // Use the display name: lower-case, collapse non-alphanumeric runs to hyphens
    base = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  // Fall back to email prefix if name yields fewer than 3 chars
  if (base.length < 3) {
    const prefix = email.split('@')[0] ?? '';
    base = prefix
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  // Truncate to 25 chars — reserves 5 chars for suffix e.g. "-100"
  const truncated = base.slice(0, 25);

  return truncated.length >= 2 ? truncated : 'user';
}

/**
 * Derives a human-readable display name from an email address.
 *
 * Transformations:
 *   1. Extract the local part (before '@')
 *   2. Replace dots, underscores, hyphens, and plus signs with spaces
 *   3. Title-case each word
 *
 * Used when an OAuth provider does not return a display name.
 *
 * @example
 * convertEmailToName('john.doe@gmail.com')    // 'John Doe'
 * convertEmailToName('alice_smith@corp.io')   // 'Alice Smith'
 * convertEmailToName('bob@example.com')       // 'Bob'
 * convertEmailToName('ray.j+tag@mail.com')    // 'Ray J'
 */
export function convertEmailToName(email: string): string {
  // Extract local part, fall back to full email if malformed
  const local = email.split('@')[0] ?? email;

  // Replace common separators with spaces
  const spaced = local.replace(/[._+-]+/g, ' ').trim();

  // Title-case each word (guard against empty tokens after split)
  const titled = spaced
    .split(/\s+/)
    .filter(word => word.length)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');

  // Fallback: return the raw local part if title-casing yielded nothing
  return titled || local;
}

/**
 * Validates a username candidate against all project rules.
 *
 * Rules:
 * - 3–30 characters
 * - Only lowercase letters (a-z), digits (0-9), and hyphens (-)
 * - No spaces
 * - Cannot start or end with a hyphen
 * - No consecutive hyphens (--)
 * - Not a reserved word (admin, support, root, …)
 *
 * Input should already be sanitized (i.e. passed through sanitizeUsername)
 * before calling this function.
 */
export function validateUsername(username: string): UsernameValidationResult {
  const errors: string[] = [];

  if (!username || typeof username !== 'string') {
    return { valid: false, errors: ['Username is required'] };
  }

  const uname = username.trim();

  if (uname.length < 3)  errors.push('Username must be at least 3 characters long');
  if (uname.length > 30) errors.push('Username must not exceed 30 characters');

  // Only allow ASCII letters, numbers and hyphens (enforce lowercase by caller)
  if (!/^[a-z0-9-]+$/.test(uname)) {
    errors.push('Username may only contain lowercase letters, numbers, and hyphens');
  }

  if (/\s/.test(uname)) {
    errors.push('Username cannot contain spaces');
  }

  if (/^-|-$/.test(uname)) {
    errors.push('Username cannot start or end with a hyphen');
  }

  if (/--/.test(uname)) {
    errors.push('Username cannot contain consecutive hyphens');
  }

  if (RESERVED_USERNAMES.includes(uname.toLowerCase())) {
    errors.push('That username is reserved');
  }

  return { valid: errors.length === 0, errors };
}
