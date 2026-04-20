/**
 * Password Hashing Utilities
 * 
 * Provides secure password hashing and verification using bcrypt.
 * 
 * Security Features:
 * - Uses bcrypt with 12 salt rounds (recommended for production)
 * - Automatic salt generation (no need to store separate salt)
 * - Constant-time comparison (prevents timing attacks)
 * - Compatible with Node.js crypto API
 * 
 * @example
 * ```typescript
 * import { hashPassword, verifyPassword } from '../utils/password.js';
 * 
 * // Hash a password during signup
 * const hashedPassword = await hashPassword('user123');
 * 
 * // Verify a password during login
 * const isValid = await verifyPassword('user123', hashedPassword);
 * ```
 */

import bcrypt from 'bcrypt';

const SALT_ROUNDS = 12; // Recommended for production (balance of security & performance)

/**
 * Hashes a plaintext password using bcrypt
 * 
 * @param password - The plaintext password to hash
 * @returns Promise resolving to the hashed password
 * 
 * @example
 * ```typescript
 * const hashedPassword = await hashPassword('mySecurePassword123');
 * // Store hashedPassword in database (password_hash field)
 * ```
 */
export async function hashPassword(password: string): Promise<string> {
  return await bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Verifies a plaintext password against a hashed password
 * 
 * @param password - The plaintext password to verify
 * @param hashedPassword - The hashed password from the database
 * @returns Promise resolving to true if password matches, false otherwise
 * 
 * @example
 * ```typescript
 * const isValid = await verifyPassword('mySecurePassword123', storedHash);
 * if (isValid) {
 *   // Password is correct, proceed with login
 * } else {
 *   // Password is incorrect, return error
 * }
 * ```
 */
export async function verifyPassword(password: string, hashedPassword: string): Promise<boolean> {
  return await bcrypt.compare(password, hashedPassword);
}
