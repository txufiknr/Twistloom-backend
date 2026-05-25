/**
 * @overview Prompt Cache Configuration
 * 
 * Configuration for the story theme caching system.
 * Controls cache behavior, thresholds, and freshness parameters.
 */

export const PROMPT_CACHE_CONFIG = {
  /** Whether the prompt cache system is enabled */
  enabled: process.env.PROMPT_CACHE_ENABLED === 'true',
  
  /** Minimum number of prompts in cache before using cache */
  threshold: parseInt(process.env.PROMPT_CACHE_THRESHOLD || '100'),
  
  /** Cache hit rate (0-1) for hybrid mode */
  hitRate: parseFloat(process.env.PROMPT_CACHE_HIT_RATE || '0.7'),
  
  /** Target number of active prompts in cache */
  targetSize: parseInt(process.env.PROMPT_CACHE_TARGET_SIZE || '500'),
  
  /** Minimum quality score (0-1) to save a prompt to cache */
  minQuality: parseFloat(process.env.PROMPT_CACHE_MIN_QUALITY || '0.7'),
  
  /** Streaming simulation configuration */
  streaming: {
    /** Number of characters per chunk for simulated streaming */
    chunkSize: parseInt(process.env.PROMPT_STREAM_CHUNK_SIZE || '10'),
    /** Delay between chunks in milliseconds */
    delayMs: parseInt(process.env.PROMPT_STREAM_DELAY_MS || '50'),
  },
  
  /** Expiration configuration (in days) */
  expiration: {
    /** Default expiration for normal quality prompts */
    default: parseInt(process.env.PROMPT_EXPIRE_DEFAULT || '90'),
    /** Expiration for high quality prompts (score >= 0.9) */
    highQuality: parseInt(process.env.PROMPT_EXPIRE_HIGH_QUALITY || '180'),
    /** Expiration for low quality prompts (score < 0.7) */
    lowQuality: parseInt(process.env.PROMPT_EXPIRE_LOW_QUALITY || '30'),
  },
  
  /** Cron job schedules */
  cron: {
    /** Weekly prompt generation schedule (cron expression) */
    generation: process.env.PROMPT_GENERATION_CRON || '0 2 * * 0',
    /** Daily cleanup schedule (cron expression) */
    cleanup: process.env.PROMPT_CLEANUP_CRON || '0 3 * * *',
  },
  
  /** Batch size for weekly prompt generation */
  batchSize: parseInt(process.env.PROMPT_BATCH_SIZE || '10'),
  
  /** Maximum usage count before retiring a prompt */
  maxUsageCount: parseInt(process.env.PROMPT_MAX_USAGE_COUNT || '100'),
} as const;
