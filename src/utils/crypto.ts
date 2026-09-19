/**
 * Runtime-agnostic Cryptographic Primitives
 *
 * Implements field-level AES-256-GCM encryption, HMAC-SHA256 blind indexing,
 * and account masking using the standard Web Crypto API (`crypto.subtle` &
 * `crypto.getRandomValues`).
 *
 * Completely free of `node:crypto` dependencies for universal compatibility
 * across Bun, Node, Deno, and Edge environments.
 */

// ── Byte / Hex Conversion Helpers ────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const cleanHex = hex.trim();
  const len = cleanHex.length;
  const buffer = new ArrayBuffer(len / 2);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < len; i += 2) {
    bytes[i / 2] = parseInt(cleanHex.substring(i, i + 2), 16);
  }
  return bytes;
}

// ── Key Derivation & Caching ─────────────────────────────────────────────────

let cachedAesKey: CryptoKey | null = null;
let cachedHmacKey: CryptoKey | null = null;

async function getEncryptionKey(): Promise<CryptoKey> {
  if (cachedAesKey) return cachedAesKey;

  const isProduction = process.env.NODE_ENV === "production";
  const hexKey = process.env.PII_ENCRYPTION_KEY_HEX?.trim();
  let rawKeyBytes: Uint8Array;

  if (hexKey && /^[0-9a-fA-F]{64}$/.test(hexKey)) {
    rawKeyBytes = hexToBytes(hexKey);
  } else if (isProduction) {
    throw new Error(
      "FATAL SECURITY CONFIGURATION: PII_ENCRYPTION_KEY_HEX must be set to a valid 64-character hex string in production"
    );
  } else {
    // Local development fallback derived from AUTH_SECRET via SHA-256
    const secret = process.env.AUTH_SECRET || "twistloom_dev_pii_encryption_secret_key_32b";
    const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
    rawKeyBytes = new Uint8Array(hashBuffer);
  }

  cachedAesKey = await crypto.subtle.importKey(
    "raw",
    rawKeyBytes as unknown as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );

  return cachedAesKey;
}

async function getBlindIndexHmacKey(): Promise<CryptoKey> {
  if (cachedHmacKey) return cachedHmacKey;

  const isProduction = process.env.NODE_ENV === "production";
  const salt = process.env.PII_BLIND_INDEX_SALT?.trim();

  let hmacSecret: string;
  if (salt) {
    hmacSecret = salt;
  } else if (isProduction) {
    throw new Error(
      "FATAL SECURITY CONFIGURATION: PII_BLIND_INDEX_SALT must be set in production"
    );
  } else {
    hmacSecret = process.env.AUTH_SECRET ? `${process.env.AUTH_SECRET}_blind_salt` : "twistloom_dev_blind_salt";
  }

  cachedHmacKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(hmacSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  return cachedHmacKey;
}

// ── Field-Level AES-256-GCM Encryption / Decryption ──────────────────────────

/**
 * Encrypts sensitive PII (like raw bank account numbers) using standard Web Crypto AES-256-GCM.
 * Output format: `v1:ivHex:authTagHex:ciphertextHex`
 */
export async function encryptPII(plainText: string): Promise<string> {
  if (!plainText) return "";

  const key = await getEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96 bits standard for AES-GCM
  const encoded = new TextEncoder().encode(plainText);

  // In standard Web Crypto AES-GCM, the returned ArrayBuffer appends the 16-byte tag to the ciphertext
  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    key,
    encoded
  );

  const encryptedWithTag = new Uint8Array(encryptedBuffer);
  const ciphertextBytes = encryptedWithTag.slice(0, -16);
  const authTagBytes = encryptedWithTag.slice(-16);

  return `v1:${bytesToHex(iv)}:${bytesToHex(authTagBytes)}:${bytesToHex(ciphertextBytes)}`;
}

/**
 * Decrypts sensitive PII formatted as `v1:ivHex:authTagHex:ciphertextHex` (or legacy `ivHex:authTagHex:ciphertextHex`)
 * using Web Crypto AES-256-GCM.
 */
export async function decryptPII(encryptedPayload: string): Promise<string> {
  if (!encryptedPayload) return "";
  const parts = encryptedPayload.split(":");
  let ivHex: string;
  let authTagHex: string;
  let cipherHex: string;

  if (parts.length === 4 && parts[0] === "v1") {
    // Versioned format
    [, ivHex, authTagHex, cipherHex] = parts;
  } else if (parts.length === 3) {
    // Legacy unversioned format
    [ivHex, authTagHex, cipherHex] = parts;
  } else {
    return encryptedPayload;
  }

  const iv = hexToBytes(ivHex);
  const authTag = hexToBytes(authTagHex);
  const cipher = hexToBytes(cipherHex);

  // Recombine ciphertext and auth tag for Web Crypto AES-GCM
  const combinedBuffer = new ArrayBuffer(cipher.length + authTag.length);
  const combined = new Uint8Array(combinedBuffer);
  combined.set(cipher, 0);
  combined.set(authTag, cipher.length);

  const key = await getEncryptionKey();
  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource, tagLength: 128 },
    key,
    combined as unknown as BufferSource
  );

  return new TextDecoder().decode(decryptedBuffer);
}

// ── Sybil / Blind Indexing & Presentation Helpers ────────────────────────────

/**
 * Generates an HMAC-SHA256 blind index hash of a normalized account number.
 * Allows deterministic exact-match lookup (for Sybil / multi-account prevention)
 * without exposing or decrypting raw account numbers.
 */
export async function generateBlindIndex(value: string): Promise<string> {
  if (!value) return "";
  const normalized = value.replace(/[\s-]/g, "").trim().toLowerCase();
  const key = await getBlindIndexHmacKey();
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(normalized)
  );

  return bytesToHex(new Uint8Array(signature));
}

/**
 * Extracts the last 4 alphanumeric characters of an account number.
 */
export function extractLast4(accountNumber: string): string {
  const cleaned = accountNumber.replace(/[\s-]/g, "").trim();
  return cleaned.length <= 4 ? cleaned : cleaned.slice(-4);
}

/**
 * Masks an account number, displaying only the last 4 digits (e.g., "••••1234").
 */
export function maskAccountNumber(accountNumber: string): string {
  const last4 = extractLast4(accountNumber);
  if (!last4) return "";
  return `••••${last4}`;
}

/**
 * Compares two strings in constant time to prevent timing attacks.
 * Uses bitwise XOR accumulation over byte representations.
 * Completely runtime-agnostic (zero `node:crypto`).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBuf = encoder.encode(a);
  const bBuf = encoder.encode(b);

  if (aBuf.byteLength !== bBuf.byteLength) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < aBuf.byteLength; i++) {
    diff |= aBuf[i]! ^ bBuf[i]!;
  }
  return diff === 0;
}

