import { getGeminiClient } from './ai-clients.js';
import { Type } from "@google/genai";
// import { createHash } from 'crypto';
import type { Schema } from "@google/genai";
import { hashContentDJB2 } from './cache.js';

interface GeminiCacheEntry {
  cacheId: string;         // Gemini cache resource name
  prefixHash: string;      // SHA-256 of the cached content
  createdAt: number;       // Unix ms
  expiresAt: number;       // Unix ms
}

// Helper function to convert JSON schema to Gemini schema recursively
const GEMINI_TYPE_MAP: Record<string, Type> = {
  string: Type.STRING,
  number: Type.NUMBER,
  integer: Type.INTEGER,
  boolean: Type.BOOLEAN,
  object: Type.OBJECT,
  array: Type.ARRAY,
  null: Type.NULL,
};


// In-memory cache store (replace with Redis for multi-process setups)
const contentCacheMap = new Map<string, GeminiCacheEntry>();

const CACHE_TTL_SECONDS = 3600; // 1 hour

/**
 * Gets or creates a Gemini explicit cache for the given cachedContentId.
 * The cache contains system instructions + semi-static story context.
 * 
 * Returns the cache name to pass as `cachedContent` in generateContent calls.
 */
export async function getOrCreateGeminiCache(
  cachedContentId: string,
  model: string,
  systemInstruction: string,
  semiStaticContext: string, // book summary, MC base info, world summary
): Promise<string | null> {
  const prefixContent = systemInstruction + semiStaticContext;
  const prefixHash = hashContentDJB2(prefixContent);
  const now = Date.now();

  const existing = contentCacheMap.get(cachedContentId);
  // Cache is valid — reuse it
  if (existing && existing.prefixHash === prefixHash && existing.expiresAt > now + 60_000) return existing.cacheId;

  // Gemini requires minimum ~1 024 tokens to cache (32k chars is a safe lower bound)
  // If our prefix is too short, explicit caching won't engage — skip it gracefully.
  if (prefixContent.length < 8_000) return null;

  try {
    const ai = getGeminiClient();
    const cache = await ai.caches.create({
      model,
      config: {
        ttl: `${CACHE_TTL_SECONDS}s`,
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{
          role: 'user',
          parts: [{ text: semiStaticContext }],
        }],
      },
    });

    if (!cache.name) return null;

    contentCacheMap.set(cachedContentId, {
      cacheId: cache.name,
      prefixHash,
      createdAt: now,
      expiresAt: now + CACHE_TTL_SECONDS * 1000,
    });

    console.log(`[gemini-cache] 💾 Created cache for story ${cachedContentId}: ${cache.name}`);
    return cache.name;

  } catch (err) {
    // Non-fatal — fall back to regular request
    console.warn(`[gemini-cache] ⚠️ Failed to create cache:`, err);
    return null;
  }
}

export async function invalidateGeminiCache(cachedContentId: string): Promise<void> {
  const ai = getGeminiClient();
  const existing = contentCacheMap.get(cachedContentId);
  if (existing?.cacheId) await ai.caches.delete({ name: existing.cacheId });
  contentCacheMap.delete(cachedContentId);
}

export function convertToGeminiSchema(jsonSchema: any): Schema {
  if (typeof jsonSchema === 'boolean') return { type: Type.TYPE_UNSPECIFIED };
  if (!jsonSchema || typeof jsonSchema !== 'object') return { type: Type.TYPE_UNSPECIFIED };
  if (jsonSchema.anyOf) return { anyOf: jsonSchema.anyOf.map(convertToGeminiSchema) } as Schema;
  if (jsonSchema.oneOf) return { anyOf: jsonSchema.oneOf.map(convertToGeminiSchema) } as Schema;

  let type = jsonSchema.type;

  if (Array.isArray(type)) {
    const nonNull = type.filter((t) => t !== 'null');

    if (nonNull.length === 1) {
      type = nonNull[0];
    } else {
      return {
        anyOf: nonNull.map((t) => convertToGeminiSchema({ ...jsonSchema, type: t })),
      } as Schema;
    }
  }

  if (type === 'array') {
    const schema: Schema = { type: Type.ARRAY };

    if (jsonSchema.items) schema.items = convertToGeminiSchema(jsonSchema.items);
    if (typeof jsonSchema.minItems === 'number') schema.minItems = jsonSchema.minItems;
    if (typeof jsonSchema.maxItems === 'number') schema.maxItems = jsonSchema.maxItems;
    if (jsonSchema.description) schema.description = jsonSchema.description;

    return schema;
  }

  if (type === 'object') {
    const schema: Schema = {
      type: Type.OBJECT,
      properties: {},
      required: jsonSchema.required ?? [],
    };

    if (jsonSchema.properties) {
      schema.properties = Object.fromEntries(
        Object.entries(jsonSchema.properties).map(([key, value]) => [
          key,
          convertToGeminiSchema(value),
        ]),
      );
    }

    if (jsonSchema.description) schema.description = jsonSchema.description;
    if (jsonSchema.propertyOrdering) schema.propertyOrdering = jsonSchema.propertyOrdering;
    // if (jsonSchema.additionalProperties) (schema as any).additionalProperties = convertToGeminiSchema(jsonSchema.additionalProperties);

    return schema;
  }

  const schema: Schema = { type: GEMINI_TYPE_MAP[type] ?? Type.TYPE_UNSPECIFIED };

  if (jsonSchema.description) schema.description = jsonSchema.description;
  if (jsonSchema.enum) schema.enum = jsonSchema.enum;
  if (jsonSchema.format) schema.format = jsonSchema.format;
  if (typeof jsonSchema.minimum === 'number') schema.minimum = jsonSchema.minimum;
  if (typeof jsonSchema.maximum === 'number') schema.maximum = jsonSchema.maximum;

  return schema;
}