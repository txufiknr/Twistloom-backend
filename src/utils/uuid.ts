import { v7 as uuidv7, validate as uuidValidate } from "uuid";

export const generateId = () => uuidv7();

/** UUID v7 is 36 chars, but allow some buffer */
const MAX_UUID_LENGTH = 100;

/**
 * Validates if a value has a valid UUID format
 * @summary Helper function to validate UUID format across the application
 * @description Checks if the provided value is a non-empty string with valid UUID format
 * and reasonable length to prevent invalid operations and potential DoS attacks.
 * 
 * @param uuid - The UUID value to validate
 * @returns `true` if UUID is valid, `false` otherwise
 * 
 * @example
 * ```typescript
 * if (isValidUuid(someId)) {
 *   // Proceed with operation
 *   await db.delete(clusters).where(eq(clusters.id, someId));
 * } else {
 *   console.warn('Invalid UUID format');
 * }
 * ```
 */
export function isValidUuid(uuid: unknown): uuid is string {
  // Type and format validation
  if (!uuid || typeof uuid !== 'string' || !uuidValidate(uuid)) {
    return false;
  }
  
  // Security: Prevent potential DoS attacks with extremely long strings
  if (uuid.length > MAX_UUID_LENGTH) {
    return false;
  }
  
  return true;
}
