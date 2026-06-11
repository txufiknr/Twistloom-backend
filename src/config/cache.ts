/** Default cache TTL in minutes */
export const CACHE_TTL_MINUTES: number = 10;

/**
 * Why 16 KB?
 * - Small enough that cache keys remain lightweight.
 * - Large enough that ordinary objects stay human-readable.
 * - Large AI context objects, RAG metadata, story state snapshots, etc. will automatically switch to hashing.
 * 
 * | Stable JSON size | Recommendation          |
 * | ---------------- | ----------------------- |
 * | < 1 KB           | Definitely keep raw     |
 * | 1–8 KB           | Usually keep raw        |
 * | 8–16 KB          | Either approach is fine |
 * | 16–32 KB         | Good hashing threshold  |
 * | > 32 KB          | I'd definitely hash     |
 * | > 100 KB         | Always hash             |
 */
export const CACHE_KEY_HASH_THRESHOLD = 16 * 1024; // 16 KB
