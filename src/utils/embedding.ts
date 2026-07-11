/**
 * @overview Jina AI Embedding Service
 *
 * Generates text embeddings via Jina AI's hosted API (jina-embeddings-v5-text-small,
 * free tier) for pgvector semantic memory retrieval.
 *
 * Features:
 * - Retry with exponential backoff (p-retry), abort on non-retryable errors
 * - LRU-ish cache with TTL to avoid redundant calls within one generation cycle
 * - Shared rate limiter (getJinaLimiter()) — same singleton used by every
 *   fire-and-forget embed call AND the backfill cron, so RPM/TPM/concurrency
 *   all stay within Jina's free-tier ceiling (100 RPM / 100K TPM / 2
 *   concurrent) without any extra bookkeeping here
 * - Server-side L2 normalization ("normalized": true) — Jina defaults this
 *   to false, so it's requested explicitly; no client-side renormalization
 *
 * IMPORTANT: every call into this file should originate from a page-generation
 * caller (generateNextPage / generateNextPages), reading off that page's own
 * freshly-computed StateDelta/PersistedStoryPage — never from inside
 * applyStateDelta or the processXxx state-transition helpers it calls.
 * Those run identically during live generation AND during delta-chain replay
 * (confirmed against story_utils.ts / branch-traversal.ts), so hooking
 * embedding calls in there would silently re-embed the same history every
 * time a pruned story_states row gets reconstructed. See
 * PGVECTOR_SEMANTIC_MEMORY_ROADMAP.md §12 / Appendix D.3 for the full trace.
 */

import pRetry, { AbortError } from 'p-retry';
import { getErrorMessage } from './error.js';
import { getJinaLimiter } from './ai-limiters.js';
import {
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_CACHE_TTL,
  EMBEDDING_CACHE_MAX_SIZE,
} from '../config/embedding.js';

/**
 * Jina task strings, dot-notation, confirmed identical for v3/v4/v5-text on
 * the hosted API (self-hosted/HuggingFace usage differs — not relevant here,
 * Twistloom only calls api.jina.ai).
 */
export type EmbeddingTask = 'retrieval.passage' | 'retrieval.query' | 'text-matching' | 'classification' | 'clustering';

interface JinaEmbeddingResponse {
  data: { embedding: number[]; index: number }[];
  usage?: { total_tokens: number };
}

/**
 * In-memory cache with TTL and a simple insertion-order eviction. Avoids
 * redundant Jina calls when the same text gets embedded more than once
 * within a single generation cycle (e.g. the current-scene query embedding
 * reused across page/character/place/future-note retrieval calls).
 *
 * Cache key includes model + task + text so a future model or task change
 * can never silently return a stale or wrong-shaped vector.
 */
class EmbeddingCache {
  private cache = new Map<string, { value: number[]; expiresAt: number }>();

  get(key: string): number[] | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: number[]): void {
    if (this.cache.size >= EMBEDDING_CACHE_MAX_SIZE) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
    this.cache.set(key, { value, expiresAt: Date.now() + EMBEDDING_CACHE_TTL });
  }
}

const embeddingCache = new EmbeddingCache();

/**
 * Low-level call to Jina's hosted embeddings API. Not exported — embedText()
 * and embedBatch() are the public surface, both routing through the shared
 * rate limiter and retry policy.
 */
async function callJinaEmbeddingsAPI(inputs: string[], task: EmbeddingTask): Promise<number[][]> {
  await getJinaLimiter().throttle();

  return pRetry(
    async () => {
      const apiKey = process.env['JINA_API_KEY'];
      if (!apiKey) {
        throw new AbortError('JINA_API_KEY is not set');
      }

      const response = await fetch('https://api.jina.ai/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          task,
          dimensions: EMBEDDING_DIMENSIONS,
          normalized: true, // Jina defaults this to false — must be explicit, see file header
          input: inputs,
        }),
      });

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        if (response.status === 429) {
          // Retryable — pRetry will back off and try again.
          throw new Error(`[jina] Rate limited (429): ${bodyText}`);
        }
        // Non-retryable: bad request, auth failure, model error, etc.
        throw new AbortError(`[jina] API error ${response.status}: ${bodyText}`);
      }

      const data = (await response.json()) as JinaEmbeddingResponse;
      if (!data.data?.length) {
        throw new AbortError('[jina] API returned no embeddings');
      }

      // Response schema matches OpenAI's — each item carries its own `index`,
      // so sort defensively rather than assuming response order == request order.
      const sorted = [...data.data].sort((a, b) => a.index - b.index);

      for (const item of sorted) {
        if (item.embedding.length !== EMBEDDING_DIMENSIONS) {
          throw new AbortError(
            `[jina] Unexpected embedding length ${item.embedding.length}, expected ${EMBEDDING_DIMENSIONS}`
          );
        }
      }

      return sorted.map(item => item.embedding);
    },
    { retries: 3, minTimeout: 1000 }
  );
}

/**
 * Embeds a single text string via Jina AI's hosted API.
 *
 * @param text - Text to embed. Keep well under ~32,768 tokens (jina-embeddings-v5-text-small's cap) — Twistloom's page/interaction/event text is always far smaller than this in practice.
 * @param task - 'retrieval.passage' for content being stored, 'retrieval.query' for search queries. Using the wrong one doesn't break the call, but degrades retrieval quality — passage and query embeddings are optimized differently.
 * @returns 1024-dimension embedding vector, already L2-normalized server-side (no manual normalization needed)
 *
 * @example
 * ```typescript
 * const pageVector = await embedText(buildPageEmbeddingText(page), 'retrieval.passage');
 * const queryVector = await embedText(currentSceneQuery, 'retrieval.query');
 * ```
 */
export async function embedText(text: string, task: EmbeddingTask = 'retrieval.passage'): Promise<number[]> {
  const cacheKey = `${EMBEDDING_MODEL}:${task}:${text}`;
  const cached = embeddingCache.get(cacheKey);
  if (cached) return cached;

  try {
    const [embedding] = await callJinaEmbeddingsAPI([text], task);
    embeddingCache.set(cacheKey, embedding);
    return embedding;
  } catch (error) {
    console.error(`[embedText] ⚠️ Failed to embed text (task: ${task}):`, getErrorMessage(error));
    throw error; // caller decides whether to swallow — see embedding-hook call sites, which do
  }
}

/**
 * Embeds multiple texts in a single Jina API call, serving already-cached
 * entries without hitting the network. Preserves input order in the result.
 *
 * Note: a batch still counts as ONE request against the RPM/concurrency
 * limit, but its combined token count counts against the 100K TPM ceiling —
 * keep batches to a handful of short texts (e.g. backfilling a page's worth
 * of character interactions together), not hundreds of items at once.
 *
 * @param texts - Texts to embed together
 * @param task - Same task applies to every text in the batch
 * @returns Array of embeddings in the same order as the input texts
 */
export async function embedBatch(texts: string[], task: EmbeddingTask = 'retrieval.passage'): Promise<number[][]> {
  if (!texts.length) return [];

  const results: (number[] | undefined)[] = texts.map(text =>
    embeddingCache.get(`${EMBEDDING_MODEL}:${task}:${text}`)
  );
  const uncachedIndices = results
    .map((cached, i) => (cached === undefined ? i : -1))
    .filter(i => i !== -1);

  if (!uncachedIndices.length) {
    return results as number[][];
  }

  try {
    const uncachedTexts = uncachedIndices.map(i => texts[i]!);
    const fetched = await callJinaEmbeddingsAPI(uncachedTexts, task);

    uncachedIndices.forEach((originalIndex, i) => {
      const embedding = fetched[i]!;
      results[originalIndex] = embedding;
      embeddingCache.set(`${EMBEDDING_MODEL}:${task}:${texts[originalIndex]}`, embedding);
    });

    return results as number[][];
  } catch (error) {
    console.error(`[embedBatch] ⚠️ Failed to embed batch of ${texts.length} (task: ${task}):`, getErrorMessage(error));
    throw error;
  }
}
