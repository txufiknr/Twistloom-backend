/**
 * Authentication Configuration
 * 
 * Feature flags and configuration for authentication-related features.
 */

/**
 * Feature flag: Lazy Guest Creation
 * 
 * When enabled, the system uses a two-tier session system:
 * - Tier 1: Temporary sessions (LRU cache + database backup) for read-only operations
 * - Tier 2: Guest users (database) for write operations requiring persistence
 * 
 * This reduces guest user creation by 80-90% by only creating guest accounts
 * when users actually perform actions that require persistence.
 * 
 * @default false (disabled by default, enable after testing)
 */
export const ENABLE_LAZY_GUEST_CREATION = process.env.ENABLE_LAZY_GUEST_CREATION === 'true';

/**
 * Temporary session configuration for lazy guest creation
 */
export const TEMP_SESSION_CONFIG = {
  /** TTL for temporary sessions in seconds (1 hour) */
  TTL_SEC: 3600,
  
  /** Maximum number of sessions to keep in LRU cache */
  LRU_MAX_SIZE: 10000,
  
  /** Cookie name for temporary session ID */
  COOKIE_NAME: 'twistloom_temp_session_id',
  
  /** Cookie TTL in milliseconds (1 hour) */
  COOKIE_TTL_MS: 60 * 60 * 1000,
} as const;

/**
 * Guest user configuration
 */
export const GUEST_CONFIG = {
  /** Cookie name for guest user ID */
  COOKIE_NAME: 'twistloom_guest_id',
  
  /** Cookie TTL in milliseconds (30 days) */
  COOKIE_TTL_MS: 60 * 60 * 24 * 30 * 1000,
  
  /** Maximum retries for guest user creation (UUID collision handling) */
  MAX_CREATION_RETRIES: 3,
  
  /** IP-based cache TTL for recent guests in seconds (5 minutes) */
  IP_CACHE_TTL_SEC: 300,
} as const;
