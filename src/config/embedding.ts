/**
 * @overview pgvector Semantic Memory — Embedding Configuration
 *
 * Central config for Jina AI embeddings (jina-embeddings-v5-text-small, free
 * tier) and pgvector retrieval. See PGVECTOR_SEMANTIC_MEMORY_ROADMAP.md for
 * the full design rationale and fact-check notes behind each value below.
 */

/**
 * Jina embedding model. "Latest over stable" per Twistloom's experimentation-
 * phase preference — v5-text-small matches jina-embeddings-v4 (3.8B) on
 * retrieval quality at 5.6x smaller, and outperforms jina-embeddings-v3
 * across all task types. Keeps the same 1024-dim default and hosted-API
 * task-string format as v3, so nothing downstream depends on this specific
 * model beyond this one constant.
 */
export const EMBEDDING_MODEL = 'jina-embeddings-v5-text-small';

/**
 * Output vector dimensions. 1024 is v5-text-small's default (Matryoshka-
 * truncatable down to 32, but kept at full resolution here — storage isn't
 * the bottleneck at Twistloom's scale, so there's no reason to trade quality
 * for it). Must match the `dimensions` param on every embed request AND the
 * `vector(embedding, { dimensions: N })` column definition in schema.ts.
 */
export const EMBEDDING_DIMENSIONS = 1024;

/** Default number of similar items to retrieve per semantic query (page context, character interactions, place events, etc.) */
export const MAX_VECTOR_RESULTS_PER_QUERY = 5;

/** Wider retrieval budget for finale/ending generation, which can afford to pull more callbacks across the whole book. */
export const MAX_VECTOR_RESULTS_FINALE = 15;

/** Minimum cosine similarity for a retrieved result to be considered relevant enough to surface in a prompt. */
export const EMBEDDING_SIMILARITY_THRESHOLD = 0.5;

/** pgvector index type used on every embedding table's HNSW index. Requires pgvector >= 0.8.2 (see db/extensions.ts). */
export const VECTOR_INDEX_TYPE = 'hnsw';

/** In-memory embedding cache TTL, in ms. Avoids redundant Jina calls for the same text within one generation cycle. */
export const EMBEDDING_CACHE_TTL = 5 * 60 * 1000;

/** Max entries in the in-memory embedding cache before oldest entries are evicted. */
export const EMBEDDING_CACHE_MAX_SIZE = 100;

/**
 * Max embeddings to backfill per cron run.
 *
 * Jina free tier: 100 RPM / 100,000 TPM / 2 concurrent requests — a per-minute
 * ceiling, not a fixed daily budget. At EMBEDDING_GENERATION_DELAY (below)
 * plus the RateLimiter's own ~652ms spacing (100 RPM, 8% safety buffer), a
 * 100-item run takes roughly 100-150 seconds and stays well under both the
 * RPM and TPM ceilings even at worst-case ~400 tokens/embedding.
 */
export const EMBEDDING_GENERATION_LIMIT = 100;

/** Delay (ms) between backfill embedding calls, on top of getJinaLimiter().throttle()'s own spacing. */
export const EMBEDDING_GENERATION_DELAY = 1000;
