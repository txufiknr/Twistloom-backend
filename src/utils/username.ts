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
 * Sanitizes a username for storage/lookup.
 * - Trims whitespace
 * - Decodes & removes HTML/control characters via `sanitizeTextForDB`
 * - Converts to lowercase (usernames are treated case-insensitively)
 */
export function sanitizeUsername(username: string): string {
  if (!username || typeof username !== 'string') return '';
  const cleaned = sanitizeTextForDB(username.trim());
  // TODO: remove spaces
  return cleaned.toLowerCase();
}

/**
 * Validates username according to project rules:
 * - Length between 3 and 30 characters
 * - Allowed characters: lowercase letters, numbers, hyphens
 * - No spaces
 * - Cannot start or end with a hyphen
 * - No consecutive hyphens
 * - Not a reserved word
 */
export function validateUsername(username: string): UsernameValidationResult {
  const errors: string[] = [];
  if (!username || typeof username !== 'string') {
    return { valid: false, errors: ['Username is required'] };
  }

  const uname = username.trim();

  if (uname.length < 3) errors.push('Username must be at least 3 characters long');
  if (uname.length > 30) errors.push('Username must not exceed 30 characters');

  // Only allow ASCII letters, numbers and hyphens (enforce lowercase by caller)
  if (!/^[a-z0-9-]+$/.test(uname)) {
    errors.push('Username may only contain letters, numbers, and hyphens');
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

  const lower = uname.toLowerCase();
  if (RESERVED_USERNAMES.includes(lower)) {
    errors.push('That username is reserved');
  }

  return { valid: errors.length === 0, errors };
}

export function convertNameOrEmailToUsername(email: string, name: string): string {
  // TODO: omit @ tail, lowercase, replace space with hypens
  return `${email}${name}`;
}

export function convertEmailToName(email: string): string {
  // TODO: omit @ tail, capitalize, replace dot with space
  return email;
}