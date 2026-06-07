/**
 * Enterprise-grade, fault-tolerant parser for AI-generated JSON.
 *
 * 9-Stage Parse Pipeline:
 *
 * Each stage runs only when all previous stages have failed. Ordered from
 * cheapest / most reliable to most expensive / most speculative:
 *
 * | Stage | Strategy                              | Sync  | Handles                                  |
 * |-------|---------------------------------------|-------|------------------------------------------|
 * | 2     | Native `JSON.parse`                   | ✓     | Clean output — zero overhead             |
 * | 3     | `jsonrepair` → parse                  | ✓     | Structural repair; **truncation**        |
 * | 4     | `@isdk/json-repair` + schema          | async | **Semantic coercion** (schema-guided)    |
 * | 5     | `repairTokenCorruption` → parse       | ✓     | Typographic quotes, bad escape sequences |
 * | 6     | Heuristic fix → parse                 | ✓     | Single quotes, unquoted keys             |
 * | 7     | Heuristic fix → `jsonrepair`          | ✓     | Combined belt-and-suspenders             |
 * | 8     | `extractPartialJSON` regex sweep      | ✓     | Scalar KV pairs from total wreckage      |
 * | 9     | Plain-text fallback                   | ✓     | Absolute last resort                     |
 *
 * Library Responsibilities:
 *
 * **`jsonrepair`** (Stage 3) — structural repair specialist. Best at closing
 * unclosed braces and strings from max-token truncation, trailing commas,
 * Python constants, JSONP wrappers, and JavaScript comments.
 *
 * **`@isdk/json-repair`** (Stage 4) — the only library that uses your JSON
 * Schema as a semantic map. Can coerce `status: Success!` → `'success'` because
 * it knows from the schema that `status` is `enum['success','error']`. Async
 * and more expensive; invoked only after cheap synchronous stages fail.
 *
 * **`repairTokenCorruption`** (Stage 5) — self-contained TypeScript tokeniser,
 * zero external dependencies. Handles what structural libraries miss: curly /
 * typographic quotes, invalid escape sequences inside strings, semicolon
 * separators, and duplicate commas. See `ai-token-repair.ts`.
 *
 * Truncation Strategy:
 *
 * When an AI hits its token limit mid-object there is no closing `}`.
 * `extractJsonCandidate` detects this and forwards the open fragment to Stage 3
 * (`jsonrepair`), which closes every unclosed brace and string. Fields
 * serialised before the cutoff are recovered intact; tail fields receive
 * type-appropriate defaults via `applySchemaDefaults`.
 *
 * Placing required fields at the top of your prompt schema (as you already do)
 * ensures they survive truncation — the defaults system handles the rest.
 *
 * Async Behavior:
 *
 * `parseAISafely` is **async** (`Promise<T>`). This is required by
 * `@isdk/json-repair` which has an async API. For clean AI output the function
 * resolves immediately after native `JSON.parse` with no observable latency.
 */

import { jsonrepair } from 'jsonrepair';
import { jsonRepair as isdkRepair, SchemaWalker } from '@isdk/json-repair';
import { repairTokenCorruption } from './ai-token-repair.js';
import type { AIResponse, AIJsonProperty } from '../types/ai-chat.js';
import { convertSingleToDoubleQuotes } from './quote.js';

// ─── Public option types ──────────────────────────────────────────────────────

/**
 * Options accepted by {@link parseAISafely}.
 *
 * Maps directly to the fields your prompt layer exposes in `AIPromptOptions`:
 *
 * ```
 * outputJsonStructure     → schema
 * outputJsonRequired      → requiredFields
 * outputJsonFallbackField → fallbackField
 * ```
 */
export interface ParseAIOptions<T extends Record<string, unknown>> {
  /**
   * Label prepended to every log line produced by this parser.
   * Defaults to the AI provider name from `AIResponse.provider`.
   */
  logContext?: string;

  /**
   * Hard cap on input character length before the string is silently
   * truncated. Protects against pathological AI outputs.
   * @default 20_000
   */
  maxLength?: number;

  /**
   * When `true` (default), fall back to a regex key-value sweep when every
   * structural parse attempt fails. Recovers scalar fields from otherwise
   * unrecoverable output.
   * @default true
   */
  allowPartialObjects?: boolean;

  /**
   * Key used when no JSON can be extracted at all and the parser falls
   * through to plain-text mode.
   * @default 'output'
   */
  fallbackField?: keyof T;

  /**
   * JSON-Schema-style descriptor for each field in `T`.
   *
   * Serves two purposes:
   *
   * 1. **Semantic coercion** — passed to `@isdk/json-repair` (Stage 4) as a
   *    semantic map so it can repair ambiguous LLM output (wrong types, partial
   *    enum matches, natural-language values).
   *
   * 2. **Default-filling** — after any successful parse, fields that are absent
   *    or `null` receive a type-appropriate default via `applySchemaDefaults`:
   *    `string` → `''`, `integer`/`number` → `0`, `boolean` → `false`,
   *    `array` → `[]`, `object` → `{}` (recursed into nested `properties`).
   *
   * @example
   * schema: {
   *   narrative: { type: 'string' },
   *   tension:   { type: 'integer' },
   *   actions:   { type: 'array', items: { type: 'string' } },
   * }
   */
  schema?: { [K in keyof T]?: AIJsonProperty };

  /**
   * Fields that **must** be present in the final result.
   * A `console.warn` is emitted for each missing field — no exception is
   * thrown so the caller controls error propagation.
   *
   * Design tip: list required fields at the top of your prompt schema so they
   * are serialised first and survive token-limit truncation.
   */
  requiredFields?: (keyof T)[];
}

// ─── SchemaWalker cache ───────────────────────────────────────────────────────

/**
 * Module-level cache of `SchemaWalker` promises, keyed by the
 * JSON-stringified root schema.
 *
 * **Why cache the Promise (not the resolved value)?**
 *
 * `SchemaWalker.create` is async and validates/compiles the schema on each
 * call. Under concurrent load — e.g. multiple story pages generating
 * simultaneously — naive caching of only the resolved value would allow a
 * race where two concurrent callers both find an empty cache and both start
 * `SchemaWalker.create` for the same schema. Caching the Promise itself means
 * all concurrent callers share the same in-flight creation and the compilation
 * runs exactly once per distinct schema per process lifetime.
 */
const walkerCache = new Map<string, Promise<SchemaWalker>>();

/**
 * Returns a cached `SchemaWalker` for the given root JSON Schema, creating one
 * lazily on the first call. Race-safe via Promise sharing.
 *
 * @param rootSchema - A complete JSON Schema object (with `type`, `properties`).
 * @internal
 */
async function getOrCreateWalker(rootSchema: Record<string, unknown>): Promise<SchemaWalker> {
  // JSON.stringify gives a stable, deterministic cache key for the plain
  // objects produced from AIJsonProperty schemas.
  const cacheKey = JSON.stringify(rootSchema);

  let walkerPromise = walkerCache.get(cacheKey);
  if (!walkerPromise) {
    walkerPromise = SchemaWalker.create(
      rootSchema as Parameters<typeof SchemaWalker.create>[0],
    );
    // Store BEFORE awaiting so any concurrent caller that arrives after this
    // line but before the walker resolves reuses this same Promise.
    walkerCache.set(cacheKey, walkerPromise);
  }

  return walkerPromise;
}

/**
 * Wraps a `ParseAIOptions.schema` (partial record of `AIJsonProperty`) into
 * the root JSON Schema object that `@isdk/json-repair` / `SchemaWalker` expect.
 *
 * `AIJsonProperty` is already a valid JSON Schema subset, so no field mapping
 * is needed — just wrap it in the standard `{ type, properties }` envelope.
 *
 * @internal
 */
function toRootSchema(schema: Record<string, AIJsonProperty>): Record<string, unknown> {
  return {
    type: 'object',
    properties: schema,
    // Intentionally omit `additionalProperties: false` — extra or partial
    // fields from the AI are acceptable at the repair stage; validation
    // happens after parsing via the requiredFields check.
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Parses AI-generated JSON with layered fault tolerance.
 *
 * Runs a nine-stage pipeline (see module header). Returns a fully-typed `T`
 * on **every** code path — it never throws and never rejects.
 *
 * **This function is async.** For clean AI output the async overhead is
 * negligible — the function resolves immediately after native `JSON.parse`
 * at Stage 2. The async cost is incurred only when Stage 4
 * (`@isdk/json-repair`) is reached.
 *
 * @param response - Raw `AIResponse<T>` from any provider.
 * @param options  - Parser options: schema, requiredFields, fallbackField, etc.
 * @returns        A `Promise<T>` that always resolves (never rejects).
 *
 * @example
 * const page = await parseAISafely<StoryPage>(aiResponse, {
 *   schema:         STORY_PAGE_SCHEMA,
 *   requiredFields: ['narrative', 'tension', 'actions'],
 *   fallbackField:  'narrative',
 *   logContext:     'story-page-gen',
 * });
 */
export async function parseAISafely<T extends Record<string, unknown>>(
  response: Pick<AIResponse<T>, 'output' | 'provider'>,
  options: ParseAIOptions<T> = {},
): Promise<T> {
  const { output, provider } = response;
  const {
    logContext = provider,
    maxLength = 20_000,
    allowPartialObjects = true,
    schema,
    requiredFields = [],
  } = options;

  // ── Stage 0a: Input validation ─────────────────────────────────────────────
  // Guard before touching any downstream logic. A non-string `output` means
  // the provider call returned an unexpected shape and nothing useful can be
  // extracted.
  if (!output || typeof output !== 'string') {
    console.warn(`[${logContext}] ⚠️ Invalid input — expected non-empty string, got ${output === '' ? 'empty string' : typeof output}`);
    return {} as T;
  }

  // ── Stage 0b: Length guard ─────────────────────────────────────────────────
  // Protects repair libraries and regexes from pathologically large inputs.
  let input = output;
  if (input.length > maxLength) {
    console.warn(`[${logContext}] ⚠️ Input too long (${input.length} chars), truncating to ${maxLength}`);
    input = input.slice(0, maxLength);
  }

  // ── Stage 1a: Sanitise ─────────────────────────────────────────────────────
  // Strip non-printable / invisible Unicode before anything else. Many AI
  // providers occasionally emit control chars, zero-width chars, or BOM
  // markers that cause every downstream parser to fail.
  const cleanInput = sanitise(input);

  // ── Stage 1b: Extract JSON candidate ──────────────────────────────────────
  // Locates the JSON object within the (possibly mixed) AI output and returns
  // a string starting with `{`. Handles markdown fences, embedded JSON, and
  // the truncation case where there is no closing `}`.
  //
  // NOTE: @isdk/json-repair requires markdown fences to be stripped before it
  // is called. extractJsonCandidate does this as its top priority, so every
  // downstream stage (including Stage 4) receives a clean fragment.
  const candidate = extractJsonCandidate(cleanInput, logContext);

  if (candidate === null) {
    // No `{` found anywhere — this is not JSON output at all.
    console.warn(`[${logContext}] ⚠️ No JSON object found — plain-text fallback`);
    return { [options.fallbackField ?? 'output']: cleanInput } as T;
  }

  // ── Stages 2–7: Repair + parse pipeline ───────────────────────────────────
  // Normalise schema to Record<string, AIJsonProperty> once so every stage
  // that needs it gets the same object reference.
  const normalSchema = schema as Record<string, AIJsonProperty> | undefined;

  const rawParsed = await runParsePipeline(candidate, normalSchema, logContext);

  if (rawParsed !== null) {
    return postProcess<T>(rawParsed, normalSchema, requiredFields, logContext);
  }

  // ── Stage 8: Partial regex key-value extraction ────────────────────────────
  // Every structural and semantic approach failed. Sweep the wreckage for
  // individual scalar key-value pairs. Only recovers primitives; missing
  // array/object fields are filled by schema defaults in postProcess.
  if (allowPartialObjects) {
    const partial = extractPartialJSON<T>(candidate, logContext);
    if (Object.keys(partial).length > 0) {
      console.log(`[${logContext}] 🔄 Stage 8: partial regex extraction`);
      return postProcess<T>(
        partial as Record<string, unknown>,
        normalSchema,
        requiredFields,
        logContext,
      );
    }
  }

  // ── Stage 9: Plain-text fallback ──────────────────────────────────────────
  // Absolute last resort. Returns the sanitised raw text under `fallbackField`
  // so the caller always receives a defined value to log, surface, or retry.
  console.warn(`[${logContext}] 🔄 Stage 9: all parse attempts failed — plain-text fallback`);
  return { [options.fallbackField ?? 'output']: cleanInput } as T;
}

// ─── Parse pipeline ───────────────────────────────────────────────────────────

/**
 * Runs each repair strategy in sequence and returns the first result that is a
 * plain object, or `null` if every stage fails.
 *
 * Ordered from cheapest / most reliable (synchronous, no allocation) to
 * most expensive / most speculative (async, third-party libraries).
 * Async cost is only incurred when synchronous stages have already failed.
 *
 * @internal
 */
async function runParsePipeline(
  candidate: string,
  schema: Record<string, AIJsonProperty> | undefined,
  logContext: string,
): Promise<Record<string, unknown> | null> {

  // ── Stage 2: Native JSON.parse ─────────────────────────────────────────────
  // Zero-cost fast path. Handles perfectly clean AI output with no overhead.
  // Resolves synchronously — if this succeeds (the common case on well-behaved
  // providers), the entire async function returns immediately.
  const native = tryParse(candidate);
  if (native) {
    console.log(`[${logContext}] ✅ Stage 2: native JSON.parse`);
    return native;
  }

  // ── Stage 3: jsonrepair → JSON.parse ──────────────────────────────────────
  // The structural repair specialist. Handles the widest variety of structural
  // defects in a single synchronous pass:
  //   • Truncated JSON (unclosed braces, arrays, strings) ← primary use case
  //   • Trailing commas before `}` or `]`
  //   • Single-quoted strings and unquoted object keys
  //   • Python constants (None → null, True/False → true/false)
  //   • JSONP wrappers, JavaScript // and /* */ comments
  //   • Markdown code fences (belt-and-suspenders — extractJsonCandidate
  //     already strips them, but jsonrepair handles any that slip through)
  //
  // Returns a repaired *string* (not a parsed object) — tryParse does the
  // final JSON.parse. Synchronous, ~1 µs typical.
  try {
    const repaired = jsonrepair(candidate);
    const parsed = tryParse(repaired);
    if (parsed) {
      console.log(`[${logContext}] 🔧 Stage 3: jsonrepair`);
      return parsed;
    }
  } catch {
    // jsonrepair throws when it cannot produce a repairable result.
  }

  // ── Stage 4: @isdk/json-repair with schema (semantic coercion) ─────────────
  // The key differentiator over pure structural repair. Uses your JSON Schema
  // as a semantic map to coerce values that structural parsers cannot handle:
  //   • Natural-language values: `"age": "about thirty"` → `30` (integer)
  //   • Fuzzy enum matching:     `status: Success!` → `'success'`
  //   • Greedy string capture:   unquoted multi-word values → string
  //   • Implicit arrays without brackets
  //
  // Returns a *parsed object* directly (no JSON.parse needed after it).
  // Async, ~5 ms typical. Only invoked when Stages 2–3 have already failed.
  //
  // SchemaWalker is compiled once and cached — concurrent requests with the
  // same schema share the same pre-compiled walker (see getOrCreateWalker).
  if (schema && Object.keys(schema).length > 0) {
    try {
      const rootSchema = toRootSchema(schema);
      const walker = await getOrCreateWalker(rootSchema);
      const parsed = await isdkRepair(candidate, walker);
      if (isPlainObject(parsed)) {
        console.log(`[${logContext}] 🔧 Stage 4: @isdk/json-repair (schema-guided)`);
        return parsed as Record<string, unknown>;
      }
    } catch {
      // isdkRepair throws when it cannot coerce the input to the schema.
    }
  }

  // ── Stage 5: Token-level corruption repair ─────────────────────────────────
  // Self-contained TypeScript tokeniser from `ai-token-repair.ts`.
  // Zero external dependencies. Handles character/token-level corruption that
  // structural libraries miss because they lack string-context awareness:
  //
  //   • Typographic / curly quotes ("..." '...') — produced by rich-text
  //     editors and some AI providers; look valid but aren't ASCII.
  //   • Invalid escape sequences inside strings: \p \q → \\p \\q
  //   • Truncated unicode escapes: \u00 → \\u00
  //   • Unescaped control chars inside string values → \uXXXX
  //   • Semicolons as separators (JS-trained model habit): ; → ,
  //   • Duplicate commas: ,, → ,
  //
  // Returns a repaired *string* — same contract as jsonrepair. Synchronous.
  try {
    const tokenRepaired = repairTokenCorruption(candidate);
    const parsed = tryParse(tokenRepaired);
    if (parsed) {
      console.log(`[${logContext}] 🔧 Stage 5: token-level repair`);
      return parsed;
    }
  } catch {
    // repairTokenCorruption is designed to never throw, but a defensive catch
    // ensures pipeline integrity regardless.
  }

  // ── Stage 6: Heuristic pre-fix → native JSON.parse ────────────────────────
  // Applies cheap, deterministic string fixups targeting the most common AI
  // JSON quirks: single-quoted strings, trailing commas, unquoted keys.
  // Tries native JSON.parse on the result before escalating to jsonrepair —
  // no repair-library overhead if the fixups alone are sufficient.
  const fixed = heuristicFix(candidate);
  const fixedNative = tryParse(fixed);
  if (fixedNative) {
    console.log(`[${logContext}] 🔧 Stage 6: heuristic fix + native JSON.parse`);
    return fixedNative;
  }

  // ── Stage 7: Heuristic pre-fix → jsonrepair ───────────────────────────────
  // Belt-and-suspenders: the heuristic pre-fix sometimes untangles nested
  // escape sequences or quote styles that were confusing jsonrepair's character
  // scanner, unlocking repairs that jsonrepair alone (Stage 3) could not make.
  try {
    const repairedFixed = jsonrepair(fixed);
    const parsed = tryParse(repairedFixed);
    if (parsed) {
      console.log(`[${logContext}] 🔧 Stage 7: heuristic fix + jsonrepair`);
      return parsed;
    }
  } catch {
    // Fall through to partial extraction.
  }

  return null;
}

// ─── JSON candidate extraction ────────────────────────────────────────────────

/**
 * Extracts the most likely JSON object string from raw AI output.
 *
 * Handles (in priority order):
 *
 * 1. **Closed ` ```json ``` ` fence** — explicit, unambiguous.
 * 2. **Unclosed ` ```json ` fence** — AI was cut off before the closing fence;
 *    extracts from after the opening fence marker to end-of-string.
 * 3. **Generic ` ``` ``` ` fence** — accepted only when content starts with `{`.
 * 4. **Balanced `{ … }`** — JSON object embedded anywhere in free text.
 * 5. **Truncated `{ …`** — no closing `}` present (max-token hit). Forwards
 *    the open fragment to the repair pipeline which closes all unclosed
 *    braces and strings.
 *
 * Returns `null` only when no `{` exists anywhere — meaning the AI returned
 * pure text with no JSON structure at all.
 *
 * @param clean      - Sanitised AI output string (after `sanitise()`).
 * @param logContext - Log label.
 * @internal
 */
function extractJsonCandidate(clean: string, logContext: string): string | null {

  // ── Priority 1 & 2: ```json fence ─────────────────────────────────────────
  if (/```json/i.test(clean)) {

    // 1a. Closed fence: ```json\n{...}\n```
    const closedMatch = clean.match(/```json\s*\n?([\s\S]*?)\n?```/i);
    if (closedMatch?.[1]) {
      console.log(`[${logContext}] 📋 Extracted from closed \`\`\`json block`);
      return closedMatch[1].trim();
    }

    // 1b. Unclosed fence: AI was truncated before emitting the closing ```.
    // Strip everything up to (and including) the opening ```json marker, then
    // find the first `{` in the remainder and forward from there.
    const afterFence = clean.replace(/^[\s\S]*?```json\s*\n?/i, '').trim();
    const braceIdx = afterFence.indexOf('{');
    if (braceIdx !== -1) {
      console.log(`[${logContext}] 📋 Unclosed \`\`\`json fence — forwarding truncated fragment`);
      return afterFence.substring(braceIdx);
    }
  }

  // ── Priority 3: Generic ``` fence ─────────────────────────────────────────
  if (clean.includes('```')) {
    const genericMatch = clean.match(/```\s*\n?([\s\S]*?)\n?```/);
    if (genericMatch?.[1]) {
      const inner = genericMatch[1].trim();
      // Only treat as JSON candidate if the content looks like an object.
      if (inner.startsWith('{')) {
        console.log(`[${logContext}] 📋 Extracted from generic code block`);
        return inner; // May itself be truncated — the repair pipeline handles it.
      }
    }
  }

  // ── Priority 4 & 5: Raw / embedded JSON ───────────────────────────────────
  const start = clean.indexOf('{');
  if (start === -1) return null; // No `{` at all — definitely not JSON output.

  const end = clean.lastIndexOf('}');

  if (end > start) {
    // Balanced-looking object found (may still be internally corrupt, but
    // that is what the repair pipeline is for).
    return clean.substring(start, end + 1);
  }

  // end === -1 or end ≤ start:
  // The AI hit its token limit before closing the object. No `}` anywhere.
  // Forward the open fragment to jsonrepair (Stage 3) which specialises in
  // closing unclosed structures. Fields serialised before the cutoff are
  // recovered intact; tail fields receive schema defaults.
  console.log(`[${logContext}] ⚠️ Truncated JSON (no closing '}') — forwarding open fragment to repair pipeline`);
  return clean.substring(start);
}

// ─── Post-processing ──────────────────────────────────────────────────────────

/**
 * Applies the three finishing passes to a successfully parsed object:
 *
 * 1. **Trim** — recursively trims all string leaf values.
 * 2. **Default-fill** — fills absent/null fields using schema type defaults.
 *    This is the safety net for truncated responses: tail fields that were
 *    cut off receive harmless empty defaults that the application can treat
 *    as "not provided".
 * 3. **Required-field assertion** — warns on any field still missing after
 *    default-filling. Warn-only: the caller decides whether to throw, retry,
 *    or degrade gracefully.
 *
 * @internal
 */
function postProcess<T extends Record<string, unknown>>(
  raw: Record<string, unknown>,
  schema: Record<string, AIJsonProperty> | undefined,
  requiredFields: (keyof T)[],
  logContext: string,
): T {
  // Pass 1: trim all string leaves.
  let result = trimStringValues<T>(raw);

  // Pass 2: fill missing/null fields from schema type defaults.
  // This is the safety net for truncated responses — fields serialised before
  // the cut-off are preserved; tail fields receive harmless empty defaults
  // that the application can treat as "not provided" or fill from context.
  if (schema) {
    result = applySchemaDefaults<T>(result, schema);
  }

  // Pass 3: warn on still-missing required fields.
  // We warn rather than throw so that a partial response (e.g. story page
  // with narrative but no actions) can be surfaced to the caller to decide
  // whether to retry or render what we have.
  if (requiredFields.length > 0) {
    const missing = requiredFields.filter((field) => {
      const v = result[field as string];
      return v === undefined || v === null;
    });
    if (missing.length > 0) {
      console.warn(`[${logContext}] ⚠️ Missing required fields after all parse attempts:`, missing.map(String).join(', '));
    }
  }

  return result;
}

// ─── Schema-default filling ───────────────────────────────────────────────────

/**
 * Fills every field declared in `schema` that is absent or `null` in `obj`
 * with a type-appropriate default value.
 *
 * **Existing non-null values are never overwritten.** This is purely additive.
 *
 * Recurses into nested `object` schema nodes so that partially-received nested
 * objects (e.g. a `metadata` sub-object where only some fields arrived before
 * truncation) are also filled correctly.
 *
 * @param obj    - The parsed (possibly partial) object.
 * @param schema - Field-level schema descriptors from `ParseAIOptions.schema`.
 * @returns A new object with all declared fields present.
 */
function applySchemaDefaults<T extends Record<string, unknown>>(
  obj: T,
  schema: Record<string, AIJsonProperty>,
): T {
  const result: Record<string, unknown> = { ...obj };

  for (const [key, prop] of Object.entries(schema)) {
    const existing = result[key];

    if (existing === undefined || existing === null) {
      // Field absent or explicitly null — substitute the type default.
      result[key] = defaultForProp(prop);
    } else if (prop.type === 'object' && prop.properties && isPlainObject(existing)) {
      // Field present as a nested object — recurse to fill its sub-fields
      // without touching values that did arrive.
      result[key] = applySchemaDefaults(
        existing as Record<string, unknown>,
        prop.properties,
      );
    }
    // All other cases (field present, correct type): leave untouched.
  }

  return result as T;
}

/**
 * Returns the canonical "empty" default for a JSON Schema property node.
 *
 * Defaults are intentionally minimal so application code can distinguish
 * "AI provided this value" from "this was defaulted". Array and object types
 * default to empty collections (not `null`) so iteration and access code
 * never throws a TypeError.
 *
 * @internal
 */
function defaultForProp(prop: AIJsonProperty): unknown {
  switch (prop.type) {
    case 'string':  return '';
    case 'integer':
    case 'number':  return 0;
    case 'boolean': return false;
    case 'array':   return [];
    case 'object':
      // Recurse into nested properties so deeply nested objects receive
      // properly initialised sub-fields rather than a bare `{}`.
      return prop.properties
        ? applySchemaDefaults({}, prop.properties)
        : {};
    default:
      return null;
  }
}

// ─── Heuristic pre-fixer ──────────────────────────────────────────────────────

/**
 * Applies cheap, deterministic string fixups for the most common AI JSON
 * formatting mistakes. Used at Stages 6 and 7.
 *
 * **Intentionally lightweight** — pure string operations with simple regexes.
 * Stage 6 tries native `JSON.parse` on the result before escalating to
 * `jsonrepair` at Stage 7, so no library overhead is incurred when the
 * fixups alone are sufficient.
 *
 * Fixes applied in order:
 *   1. `convertSingleToDoubleQuotes` — `'key': 'val'` → `"key": "val"`.
 *      Uses the existing utility which correctly handles apostrophes embedded
 *      within single-quoted string values.
 *   2. Trailing commas — `, }` / `, ]` → `}` / `]`.
 *   3. Unquoted keys — `{ key: "val" }` → `{ "key": "val" }`.
 *
 * @internal
 */
function heuristicFix(input: string): string {
  let s = input;
  // Fix 1: single → double quotes.
  s = convertSingleToDoubleQuotes(s);
  // Fix 2: trailing commas (invalid in strict JSON).
  s = s.replace(/,\s*([}\]])/g, '$1');
  // Fix 3: unquoted identifier-style keys (common in JS-style AI output).
  s = s.replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":');
  return s;
}

// ─── Partial key-value extraction ─────────────────────────────────────────────

/**
 * Last-resort regex sweep over a string that no structural parser could handle.
 *
 * Extracts scalar key-value pairs (string, number, boolean, null) using four
 * targeted patterns. Array and object values are intentionally skipped — they
 * are structurally impossible to extract safely via regex and are better
 * covered by `applySchemaDefaults`.
 *
 * Exported so diagnostics / logging pipelines can surface what *was*
 * recoverable from a completely unrecoverable AI response.
 *
 * @param input      - JSON candidate string that failed all parse attempts.
 * @param logContext - Log label.
 * @returns A partial record of whatever scalar fields could be extracted.
 */
export function extractPartialJSON<T extends Record<string, unknown>>(
  input: string,
  logContext = 'extractPartialJSON',
): Partial<T> {
  const result: Record<string, unknown> = {};

  const patterns: RegExp[] = [
    // A: "key": "string value"  (handles internal escaped quotes)
    /"([^"]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g,
    // B: "key": number | true | false | null
    /"([^"]+)"\s*:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)\b/g,
    // C: 'key': 'value'  (AI single-quote style)
    /'([^']+)'\s*:\s*'([^']*)'/g,
    // D: unquoted_key: "value"  (JS-object style)
    /([A-Za-z_]\w*)\s*:\s*"((?:[^"\\]|\\.)*)"/g,
  ];

  for (const pattern of patterns) {
    // Recreate with flags to reset `lastIndex` between outer loop iterations.
    const re = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;

    while ((match = re.exec(input)) !== null) {
      const [, key, raw] = match;
      if (!key || key in result) continue; // skip empty keys and duplicates

      // Coerce the raw string capture to the appropriate JS primitive type.
      if (raw === 'true')        result[key] = true;
      else if (raw === 'false')  result[key] = false;
      else if (raw === 'null')   result[key] = null;
      else if (raw !== '' && !isNaN(Number(raw))) result[key] = Number(raw);
      else                       result[key] = raw;
    }
  }

  if (Object.keys(result).length > 0) {
    console.log(`[${logContext}] 🔧 Stage 8 partial extraction recovered:`, Object.keys(result).join(', '));
  }

  return result as Partial<T>;
}

// ─── Shared primitives ────────────────────────────────────────────────────────

/**
 * Strips non-printable and invisible Unicode characters from a string, then
 * collapses all whitespace runs to a single space.
 *
 * Four categories removed:
 *   - Control characters (U+0000–U+001F, U+007F–U+009F): null bytes, ESC, etc.
 *   - Unicode replacement character (U+FFFD): from charset mis-decoding.
 *   - Zero-width characters (U+200B–U+200F, U+FEFF BOM): from copy-paste.
 *   - Redundant whitespace: collapsed so downstream regexes are simpler.
 *
 * @internal
 */
function sanitise(input: string): string {
  return input
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '') // control chars
    .replace(/\uFFFD/g, '')                         // Unicode replacement char
    .replace(/[\u200B-\u200F\uFEFF]/g, '')          // zero-width / BOM chars
    .replace(/\s+/g, ' ')                           // collapse whitespace
    .trim();
}

/**
 * Attempts `JSON.parse` and returns the result only when it is a plain object.
 *
 * Returns `null` for arrays, primitives, `null` literals, and any parse error.
 * Never throws — failure is a normal pipeline event, not an exception.
 *
 * @internal
 */
function tryParse(s: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(s);
    return isPlainObject(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Type guard: `true` when `v` is a non-null, non-array plain object.
 *
 * Guards against `JSON.parse` returning arrays or primitives when the AI
 * wrapped the object in an extra array layer or returned a bare string.
 *
 * @internal
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Recursively trims whitespace from every string leaf in a plain-object tree.
 *
 * AI providers occasionally emit string values with leading/trailing newlines
 * or spaces. This ensures callers always receive clean strings.
 *
 * Array elements are not trimmed to avoid surprising callers who store arrays
 * of pre-formatted text (e.g. lines of a narrative).
 *
 * @internal
 */
function trimStringValues<T extends Record<string, unknown>>(
  obj: Record<string, unknown>,
): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string')  out[k] = v.trim();
    else if (isPlainObject(v))  out[k] = trimStringValues(v);
    else                        out[k] = v;
  }
  return out as T;
}
