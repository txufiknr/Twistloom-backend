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
import type { StoryPhase } from '../types/story.js';

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

/** Wider retrieval budget for finale/ending/custom action generation, which can afford to pull more callbacks across the whole book. */
export const MAX_VECTOR_RESULTS_HIGH_VALUE = 15;

/**
 * Retrieval budgets by story phase. Keys match StoryPhase from types/story.ts.
 * EARLY: 3 — Story is young; contextHistory is thin, fewer callbacks exist
 * MID: 5 — Standard budget (matches MAX_VECTOR_RESULTS_PER_QUERY)
 * LATE: 7 — Deep history; more callbacks needed for coherence
 * FINALE: 15 — Already handled by MAX_VECTOR_RESULTS_HIGH_VALUE
 */
export const VECTOR_RESULTS_BY_PHASE: Record<StoryPhase, number> = {
  EARLY: 3,
  MID: MAX_VECTOR_RESULTS_PER_QUERY,
  LATE: 7,
  FINALE: MAX_VECTOR_RESULTS_HIGH_VALUE,
};

/**
 * Per-table similarity thresholds. Each embedding table has different content
 * characteristics (page text is ~60 words, character interactions are 1-2 sentences,
 * future notes are 1 sentence). Shorter content produces higher cosine similarity
 * baselines, so thresholds are calibrated per table to maintain consistent precision.
 *
 * page: 0.45 — Longer text → lower baseline similarity; slightly looser to avoid missing
 *        narratively relevant pages that use different vocabulary.
 * character/place: 0.50 — Short focused interactions; standard threshold.
 * futureNote/clue: 0.55 — Very short text → higher scores; slightly tighter to reduce
 *        noise from loosely related notes.
 */
export const EMBEDDING_SIMILARITY_THRESHOLDS = {
  page: 0.45,
  character: 0.50,
  place: 0.50,
  futureNote: 0.55,
  clue: 0.55,
} as const;

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

/**
 * Global kill-switch for pgvector semantic memory. Defaults to enabled —
 * set PGVECTOR_MEMORY_ENABLED=false to disable every embedding write and
 * retrieval instantly (checked in services/vector-memory.ts, before any
 * Jina call is made — not a caught error, a clean early-return) if Jina
 * misbehaves in production. Note this still requires a redeploy/restart on
 * most platforms to pick up the new env var — it removes the need to
 * revert a code change, not the need to redeploy at all.
 */
export const PGVECTOR_MEMORY_ENABLED = process.env['PGVECTOR_MEMORY_ENABLED'] !== 'false';
