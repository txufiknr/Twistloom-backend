/**
 * Generates a SHA-256 hash of a string using the runtime-agnostic Web Crypto API.
 * 
 * This implementation relies on `crypto.subtle.digest`, making it universally 
 * compatible across Edge, Node, Deno, and Bun environments without requiring 
 * the `node:crypto` dependency. 
 *
 * @param input - The UTF-8 string to hash (e.g., a session token or plain text content).
 * @returns A promise that resolves to the hex-encoded SHA-256 hash string.
 */
export async function hashSHA256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Returns a stable DJB2-style hash (32-bit output) of the content that will be cached.
 * Fast, deterministic, tiny implementation, good enough for cache key comparison.
 * If the hash changes (e.g. story summary updated), we invalidate.
 * 
 * Use {@link hashSHA256} if you want collision safety.
 */
export function hashDJB2(content: string): string {
  let h = 5381;
  for (let i = 0; i < content.length; i++) {
    // h = (h * 33) ^ content.charCodeAt(i); // uses floating-point arithmetic internally
    h = ((h << 5) + h) ^ content.charCodeAt(i); // force 32-bit arithmetic every iteration
  }
  return (h >>> 0).toString(16);
}