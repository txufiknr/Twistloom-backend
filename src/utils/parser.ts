import type { Gender } from "../types/user.js";

/**
 * Safe JSON parse helper that returns empty object on error
 * @param str - JSON string to parse
 * @returns Parsed object or empty object on error
 */
export function safeJSON(str: string): Record<string, any> {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}

/**
 * Safe string validation and normalization helper
 * @param str - String to validate and normalize
 * @param options - Normalization options
 * @returns Normalized string or null if invalid/empty
 * 
 * @example
 * ```typescript
 * safeString('  HELLO  ', { trim: true, lowercase: true }) // Returns: 'hello'
 * safeString('', { trim: true }) // Returns: null
 * ```
 */
export function safeString(
  str: string | null | undefined,
  options: {
    trim?: boolean;
    lowercase?: boolean;
    minLength?: number;
  } = {}
): string | null {
  const { trim = true, lowercase = false, minLength = 0 } = options;
  
  if (!str || typeof str !== 'string') {
    return null;
  }
  
  let result = str;
  
  if (trim) {
    result = result.trim();
  }
  
  if (lowercase) {
    result = result.toLowerCase();
  }
  
  if (result.length < minLength) {
    return null;
  }
  
  return result;
}

/**
 * Clamps a value between a minimum and maximum
 * @param value - The value to clamp
 * @param min - Minimum allowed value
 * @param max - Maximum allowed value (default: Infinity)
 * @returns The clamped value
 */
export function clamp(value: number, min: number, max: number = Infinity): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Normalizes a value to 0-1 range
 * @param value - The value to normalize
 * @returns Normalized value between 0 and 1
 */
export function normalize(value: number): number {
  return clamp(value, 0, 1);
}

/**
 * Filter array with configurable options
 * @param array - Array to filter
 * @param options - Filtering options
 * @returns Filtered array based on options
 * 
 * @example
 * ```typescript
 * filterArray([1, 2, null, '', 3], { removeFalsy: true }) // [1, 2, 3]
 * filterArray([1, 2, 2, 3], { removeDuplicates: true }) // [1, 2, 3]
 * filterArray([1, null, 2, 2, 3], { removeFalsy: true, removeDuplicates: true }) // [1, 2, 3]
 * ```
 */
export function filterArray<T>(
  array: (T | null | undefined | false | 0 | '')[],
  options: {
    removeFalsy?: boolean;
    removeDuplicates?: boolean;
  } = {}
): T[] {
  const { removeFalsy = false, removeDuplicates = false } = options;
  
  let result = array as T[];
  if (removeFalsy) result = result.filter(Boolean) as T[];
  if (removeDuplicates) result = dedupe(result);
  return result;
}

/**
 * Filter array to remove falsy values and duplicates in one operation
 * @param array - Array to filter and deduplicate
 * @returns Array with only truthy, unique values
 */
export function filterTruthyAndDedupe<T>(array: (T | null | undefined | false | 0 | '')[]): T[] {
  return filterArray<T>(array, { removeFalsy: true, removeDuplicates: true });
}

/**
 * Remove duplicate values from array (generic version)
 * @param array - Array to deduplicate
 * @returns Array with unique values
 */
export function dedupe<T>(array: T[]): T[] {
  return [...new Set(array)];
}

/**
 * Deduplicates an array of strings with validation (backward compatibility)
 * @deprecated Use dedupe() instead for consistency
 * @param arr - Array of strings to deduplicate
 * @returns New array with duplicates removed, preserving first occurrence order
 */
export function dedupeStringArray(arr: string[]): string[] {
  if (!Array.isArray(arr)) return [];
  
  return dedupe(arr);
}

/**
 * Remove keys with null or undefined values from an object
 * @param obj - Object to clean up
 * @returns New object with null/undefined keys removed
 * 
 * @example
 * ```typescript
 * const input = {
 *   guid: undefined,
 *   url: undefined,
 *   pubDate: undefined,
 *   offset: '+5',
 *   strategy: 'offset',
 *   progressiveOnly: true
 * };
 * const cleaned = cleanupObject(input);
 * // Returns: { offset: '+5', strategy: 'offset', progressiveOnly: true }
 * ```
 */
export function cleanupObject<T extends Record<string, any>>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  
  for (const [key, value] of Object.entries(obj)) {
    // Only include keys with non-null and non-undefined values
    if (value !== null && value !== undefined) {
      (result as any)[key] = value;
    }
  }
  
  return result;
}

/**
 * Filter object entries to include only non-null and non-empty values
 * @param obj - Object to filter
 * @returns New object with only non-null and non-empty values
 * 
 * @example
 * filterObjectEntries({ name: 'John', age: null, email: '' })
 * // Returns: { name: 'John' }
 */
export function filterObjectEntries<T extends Record<string, any>>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  
  for (const [key, value] of Object.entries(obj)) {
    // Skip null, undefined, and empty strings
    if (value !== null && value !== undefined && value !== '') {
      // For strings, also trim whitespace and check if empty after trim
      if (typeof value === 'string') {
        const trimmed = safeString(value);
        if (trimmed) {
          (result as any)[key] = trimmed;
        }
      } else {
        (result as any)[key] = value;
      }
    }
  }
  
  return result;
}

/**
 * Safely dedupes array fields in an object, handling undefined/null values
 * 
 * @param obj - Object containing string array fields
 * @param fields - Array of field names to dedupe
 * @returns New object with specified fields deduped
 * 
 * @example
 * ```typescript
 * const obj = {
 *   madhahib: ['shafi', 'hanafi', 'shafi'],
 *   topics: ['fiqh', 'history', 'fiqh']
 * };
 * dedupeObjectFields(obj, ['madhahib', 'topics'])
 * // Returns: {
 * //   madhahib: ['shafi', 'hanafi'],
 * //   topics: ['fiqh', 'history']
 * // }
 * ```
 */
export function dedupeObjectFields<T extends Record<string, any>>(
  obj: T,
  fields: (keyof T)[]
): T {
  const result = { ...obj };
  
  for (const field of fields) {
    const value = result[field];
    if (Array.isArray(value)) {
      result[field] = dedupe(value) as T[keyof T];
    }
  }
  
  return result;
}

/**
 * Performs shallow equality comparison between two objects
 * 
 * Compares only the first-level properties of objects without deep recursion.
 * Fast and efficient for simple object comparisons.
 * 
 * @advantages
 * - O(n) time complexity where n is number of properties
 * - No recursion overhead
 * - Memory efficient with minimal stack usage
 * - Fast for flat objects and primitive values
 * 
 * @limitations
 * - Only compares first-level properties
 * - Cannot detect differences in nested objects
 * - Reference equality for objects (not deep comparison)
 * - Does not handle circular references
 * - May fail with objects that have non-enumerable properties
 * 
 * @param obj1 - First object to compare
 * @param obj2 - Second object to compare
 * @returns True if objects have same properties with equal values, false otherwise
 */
export function shallowEqual(obj1: Record<string, any>, obj2: Record<string, any>): boolean {
  const keys1 = Object.keys(obj1);
  const keys2 = Object.keys(obj2);

  if (keys1.length !== keys2.length) return false;

  return keys1.every(key => obj1[key] === obj2[key]);
}

/**
 * Performs deep equality comparison between two objects with recursion
 * 
 * Recursively compares all properties including nested objects and arrays.
 * More comprehensive than shallowEqual but with higher computational cost.
 * 
 * @advantages
 * - Comprehensive comparison of all nested properties
 * - Handles objects with arbitrary depth
 * - Detects differences in nested structures
 * - Works with mixed data types (objects, arrays, primitives)
 * 
 * @limitations
 * - O(n*m) time complexity in worst case (n=properties, m=depth)
 * - Stack overflow risk with deeply nested objects (>1000 levels)
 * - Higher memory usage due to recursion
 * - Slower than shallowEqual for simple comparisons
 * - May cause performance issues with large circular object graphs
 * - JSON.stringify fallback may lose type information (Date, RegExp, etc.)
 * 
 * @param obj1 - First object to compare
 * @param obj2 - Second object to compare
 * @returns True if objects are deeply equal, false otherwise
 */
export function deepEqual(obj1: any, obj2: any): boolean {
  // Fast path: identical references
  if (obj1 === obj2) return true;
  
  // Handle null/undefined cases and type mismatches
  if (obj1 == null || obj2 == null) return false;
  if (typeof obj1 !== 'object' || typeof obj2 !== 'object') return false;

  const keys1 = Object.keys(obj1);
  const keys2 = Object.keys(obj2);

  if (keys1.length !== keys2.length) return false;

  for (const key of keys1) {
    if (!keys2.includes(key) || !deepEqual(obj1[key], obj2[key])) return false;
  }
  return true;
}

/**
 * Deeply compares two objects for equality using JSON.stringify
 * 
 * Safely handles null, undefined, and object comparison by converting
 * both values to JSON strings and comparing the results.
 * 
 * {@link deepEqual} function is generally more robust but slower, while
 * this is faster but has edge case limitations, e.g. Handles null/undefined
 * identically.
 * 
 * @param obj1 - First object to compare
 * @param obj2 - Second object to compare
 * @returns true if objects are deeply equal, false otherwise
 * 
 * @example
 * ```typescript
 * const obj1 = { text: 'hello', type: 'ending' };
 * const obj2 = { text: 'hello', type: 'ending' };
 * const obj3 = { text: 'different', type: 'ending' };
 * 
 * deepEqualSimple(obj1, obj2); // Returns: true
 * deepEqualSimple(obj1, obj3); // Returns: false
 * deepEqualSimple(null, undefined); // Returns: true
 * ```
 */
export function deepEqualSimple(obj1: any, obj2: any): boolean {
  // Handle null/undefined cases
  if (obj1 === obj2) return true;
  if (obj1 == null || obj2 == null) return false;
  
  // Use JSON.stringify for deep comparison
  return JSON.stringify(obj1) === JSON.stringify(obj2);
}

/**
 * Normalize gender string to 'male' or 'female'
 * @param gender - Gender string to normalize
 * @returns Normalized gender ('male', 'female') or null if input is falsy/empty
 * 
 * @example
 * normalizeGender('FEMALE') // Returns: 'female'
 * normalizeGender('Male') // Returns: 'male'
 * normalizeGender('') // Returns: 'unknown'
 * normalizeGender(null) // Returns: 'unknown'
 */
export function normalizeGender(gender?: string | null): Gender {
  const normalized = safeString(gender, { trim: true, lowercase: true, minLength: 1 });
  if (!normalized) return 'unknown';
  
  return normalized.startsWith('f') ? 'female' : 'male';
}

/**
 * Ensures a URL has a protocol (defaults to https://)
 * @param url - URL to ensure protocol for
 * @param defaultProtocol - Protocol to use if none exists (default: 'https://')
 * @returns URL with guaranteed protocol
 * 
 * @example
 * ```typescript
 * ensureProtocol('example.com') // Returns: 'https://example.com'
 * ensureProtocol('http://example.com') // Returns: 'http://example.com'
 * ensureProtocol('https://example.com') // Returns: 'https://example.com'
 * ensureProtocol('ftp://example.com', 'https://') // Returns: 'ftp://example.com'
 * ```
 */
export function ensureProtocol(url: string, defaultProtocol: string = 'https://'): string {
  if (typeof url !== 'string' || !url.trim()) return url;
  const trimmed = url.trim();
  
  return trimmed.includes('://')
    ? trimmed // If URL already has a protocol, return as-is
    : `${defaultProtocol}${trimmed}`; // Add default protocol
}

export function stripEmptyLines(prompt: string): string {
  return !prompt.trim() ? '' : prompt.trim()
    .split('\n')
    .filter(line => line.trim())
    .join('\n');
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const entries = Object.keys(obj)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableStringify(obj[key])}`);

  return `{${entries.join(',')}}`;
}