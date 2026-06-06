/**
 * Enterprise-grade, fault-tolerant parser for AI-generated JSON.
 *
 * 6-Stage Parse Pipeline:
 *
 * Each library attacks a different failure mode. No single library covers all
 * of them, so we layer them in order from cheapest to most specialised:
 *
 * | Library               | Strength                                          | Cost   |
 * |-----------------------|---------------------------------------------------|--------|
 * | Native `JSON.parse`   | Zero-overhead fast path for clean output          | ~0 µs  |
 * | `jsonrepair`          | Structural repair; **the truncation specialist**  | ~1 µs  |
 * | `@isdk/json-repair`   | **Schema-semantic coercion** (LLM-specialised)    | ~5 ms  |
 * | `jaison`              | Tokenisation-level corruption                     | ~1 µs  |
 * | Heuristic fix         | AI-specific single-quote / unquoted-key patterns  | ~0 µs  |
 * | `extractPartialJSON`  | Regex KV sweep over total wreckage                | ~1 µs  |
 *
 * `@isdk/json-repair` is the only library that uses your JSON Schema as a
 * semantic map — it can coerce `status: Success!` → `'success'` because it
 * knows from the schema that `status` is an `enum['success','error']`. It is
 * placed after the fast synchronous libraries because it is async and more
 * expensive; we only invoke it when cheaper options have already failed.
 *
 * Truncation Strategy:
 *
 * When an AI hits its token limit mid-object there is no closing `}`.
 * `extractJsonCandidate` detects this and forwards the open fragment to
 * `jsonrepair`, which closes every unclosed brace and string. Fields that were
 * serialised before the cut-off are recovered intact; tail fields receive
 * schema defaults via `applySchemaDefaults`.
 *
 * Placing required fields at the top of your schema / prompt means they
 * survive truncation — the defaults system handles the rest.
 *
 * Async Behavior:
 *
 * `parseAISafely` is now **async** (`Promise<T>`). This is unavoidable because
 * `@isdk/json-repair` is an async API. All callers must be updated to `await`
 * the result (or use `.then`).
 */

import { jsonrepair } from 'jsonrepair';
// import jaison from 'jaison';
import { jsonRepair as isdkRepair, SchemaWalker } from '@isdk/json-repair';
import type { AIResponse, AIJsonProperty } from '../types/ai-chat.js';
import { convertSingleToDoubleQuotes } from './quote.js';

// ─── Public option types ──────────────────────────────────────────────────────

/**
 * Options accepted by {@link parseAISafely}.
 *
 * These map directly to fields your prompt layer already exposes in
 * `AIPromptOptions`:
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
   * Passed to `@isdk/json-repair` as a semantic map so it can coerce
   * ambiguous LLM output (e.g. natural-language values, wrong types, partial
   * enum matches) into the correct structure.
   *
   * Also used by {@link applySchemaDefaults} to fill any field that is absent
   * or `null` after parsing with a type-appropriate default:
   *   - `string`  → `''`
   *   - `integer` / `number` → `0`
   *   - `boolean` → `false`
   *   - `array`   → `[]`
   *   - `object`  → `{}` (recursed into nested `properties`)
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
   * Design tip: put these fields at the top of your prompt schema so they
   * are serialised first and survive token-limit truncation.
   */
  requiredFields?: (keyof T)[];
}

// ─── SchemaWalker cache ───────────────────────────────────────────────────────

/**
 * Module-level cache of `SchemaWalker` promises, keyed by the
 * JSON-stringified root schema.
 *
 * **Why cache?**
 * `SchemaWalker.create` is async and validates/compiles the schema. Re-running
 * it on every AI response would add unnecessary latency and CPU overhead,
 * especially under concurrent load (e.g. multiple story pages generating
 * simultaneously on Twistloom). By caching the Promise itself — not just the
 * resolved walker — concurrent callers with the same schema share a single
 * in-flight creation and never duplicate work.
 *
 * In practice each distinct schema (story-page, book-init, etc.) is compiled
 * exactly once per process lifetime.
 */
const walkerCache = new Map<string, Promise<SchemaWalker>>();

/**
 * Returns a cached `SchemaWalker` for the given root JSON Schema, creating one
 * on first call. Thread-safe via Promise sharing.
 *
 * @param rootSchema - A complete JSON Schema object (with `type`, `properties`, etc.)
 * @internal
 */
async function getOrCreateWalker(rootSchema: Record<string, unknown>): Promise<SchemaWalker> {
  // Use a deterministic string key. JSON.stringify is stable for the plain
  // objects we produce from AIJsonProperty schemas.
  const cacheKey = JSON.stringify(rootSchema);

  let walkerPromise = walkerCache.get(cacheKey);
  if (!walkerPromise) {
    // Store the Promise immediately so that any concurrent call landing here
    // before the walker resolves will await the same Promise rather than
    // launching a second SchemaWalker.create.
    walkerPromise = SchemaWalker.create(rootSchema as Parameters<typeof SchemaWalker.create>[0]);
    walkerCache.set(cacheKey, walkerPromise);
  }

  return walkerPromise;
}

/**
 * Wraps a `ParseAIOptions.schema` (partial record of `AIJsonProperty`) into
 * the root JSON Schema object that `@isdk/json-repair` / `SchemaWalker` expect.
 *
 * Our internal `AIJsonProperty` is already a valid JSON Schema subset, so no
 * field mapping is needed — just wrap it in the standard `{ type, properties }`
 * envelope.
 *
 * @internal
 */
function toRootSchema(
  schema: Record<string, AIJsonProperty>,
): Record<string, unknown> {
  return {
    type: 'object',
    properties: schema,
    // Do not add `additionalProperties: false` here — partial / extra fields
    // from the AI are fine at the repair stage; we validate later.
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Parses AI-generated JSON with layered fault tolerance.
 *
 * Runs a **seven-stage pipeline** (see module header for the full table).
 * Returns a fully-typed `T` on every code path — it never throws.
 *
 * **This function is async.** The async cost is incurred only when stages 1–2
 * fail and the `@isdk/json-repair` stage is reached. For clean AI output,
 * the function resolves after native `JSON.parse` with no real async overhead.
 *
 * @param response        - Raw `AIResponse<T>` from any provider.
 * @param options         - Parser options (schema, requiredFields, etc.).
 * @returns               A `Promise<T>` that always resolves (never rejects).
 *
 * @example
 * const result = await parseAISafely<StoryPage>(aiResponse, {
 *   schema:         STORY_PAGE_SCHEMA,
 *   requiredFields: ['narrative', 'tension', 'actions'],
 *   fallbackField:  'narrative',
 *   logContext:     'story-page-gen',
 * });
 */
export async function parseAISafely<T extends Record<string, unknown>>(
  response: AIResponse<T>,
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

  // ── Stage 0: Input validation ──────────────────────────────────────────────
  // Validate before doing anything else. A non-string output means the provider
  // call itself failed upstream and returned an unexpected shape.
  if (!output || typeof output !== 'string') {
    console.warn(`[${logContext}] ⚠️ Invalid input — expected non-empty string, got ${ output === '' ? 'empty string' : typeof output }`);
    return {} as T;
  }

  // ── Stage 0b: Length guard ─────────────────────────────────────────────────
  // Prevents regex / repair libraries from running on pathologically long
  // strings. 20 k chars is generous for any realistic structured output.
  let input = output;
  if (input.length > maxLength) {
    console.warn(`[${logContext}] ⚠️ Input too long (${input.length} chars), truncating to ${maxLength}`);
    input = input.slice(0, maxLength);
  }

  // ── Stage 1a: Sanitise ─────────────────────────────────────────────────────
  // Strip non-printable control characters and invisible Unicode before any
  // further processing. Many providers occasionally emit these, especially
  // in JSON string values, and they cause every downstream parser to fail.
  const cleanInput = sanitise(input);

  // ── Stage 1b: Extract the JSON candidate ───────────────────────────────────
  // Finds the JSON object within the (potentially mixed) AI output and returns
  // a string that starts with `{`. This also handles the truncation case where
  // there is no closing `}` — see `extractJsonCandidate` for details.
  //
  // NOTE: @isdk/json-repair explicitly requires markdown fences to be stripped
  // before it is called. Our extractor does this as its first priority, so
  // every downstream library (including @isdk) receives a clean fragment.
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
  // individual scalar key-value pairs using targeted regex patterns. This
  // recovers primitive fields from severely corrupted output.
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

  // ── Stage 9: Plain-text fallback ───────────────────────────────────────────
  // Absolute last resort. Returns the sanitised raw text under `fallbackField`
  // so the caller at least has something to work with / log.
  console.warn(`[${logContext}] 🔄 Stage 9: all parse attempts failed — plain-text fallback`);
  return { [options.fallbackField ?? 'output']: cleanInput } as T;
}

// ─── Parse pipeline ───────────────────────────────────────────────────────────

/**
 * Runs each repair strategy in turn and returns the first result that is a
 * plain object, or `null` if every stage fails.
 *
 * The ordering is deliberately cost-ordered: fast sync operations first,
 * async schema-guided repair only after cheap options are exhausted.
 *
 * @internal
 */
async function runParsePipeline(
  candidate: string,
  schema: Record<string, AIJsonProperty> | undefined,
  logContext: string,
): Promise<Record<string, unknown> | null> {

  // ── Stage 2: Native JSON.parse ─────────────────────────────────────────────
  // The zero-cost fast path. Handles clean AI output with no overhead.
  // Runs synchronously — if this succeeds (the common case), the entire
  // function resolves without touching any repair library.
  const native = tryParse(candidate);
  if (native) {
    console.log(`[${logContext}] ✅ Stage 2: native JSON.parse`);
    return native;
  }

  // ── Stage 3: jsonrepair → JSON.parse ──────────────────────────────────────
  // The structural repair specialist. jsonrepair was built specifically for
  // this problem and handles the widest variety of structural defects:
  //   • Truncated JSON (unclosed braces, arrays, strings) ← your main concern
  //   • Trailing commas before } or ]
  //   • Single-quoted strings → double-quoted
  //   • Unquoted object keys
  //   • Markdown code fences (```json ... ```) — belt-and-suspenders since
  //     extractJsonCandidate already strips them
  //   • Python constants (None → null, True → true, False → false)
  //   • JSONP wrappers (callback({...}))
  //   • JavaScript comments (// and /* ... */)
  //
  // Returns a *repaired JSON string* (not a parsed object), so we still need
  // JSON.parse. This is synchronous and very fast (~1 µs).
  try {
    const repaired = jsonrepair(candidate);
    const parsed = tryParse(repaired);
    if (parsed) {
      console.log(`[${logContext}] 🔧 Stage 3: jsonrepair`);
      return parsed;
    }
  } catch {
    // jsonrepair throws when it cannot repair at all — fall through.
  }

  // ── Stage 4: @isdk/json-repair with schema (semantic coercion) ────────────
  // This is the key differentiator of the new pipeline. Unlike jsonrepair and
  // jaison which only understand JSON *syntax*, @isdk/json-repair uses your
  // schema as a semantic map to navigate and repair the output.
  //
  // What this can fix that the others cannot:
  //   • Natural language values:  "age": "about 30 years old" → 30 (integer)
  //   • Broken enum values:       status: Success!  → 'success' (fuzzy match)
  //   • Greedy string capture:    unquoted multi-word values coerced to string
  //   • Internal quote ambiguity: "A" OR "B" → preserved as full expression
  //   • Implicit arrays without brackets
  //
  // Returns a *parsed object* directly — no JSON.parse needed after it.
  //
  // Only runs when a schema is provided. Without a schema it degrades to basic
  // repair (similar to jsonrepair) which we have already tried.
  //
  // We pass a pre-compiled SchemaWalker for performance: SchemaWalker.create
  // compiles and validates the schema once per process; subsequent calls reuse
  // the cached walker without re-parsing the schema.
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
      // isdkRepair throws when it cannot coerce the input — fall through.
    }
  }

  // // ── Stage 5: jaison ────────────────────────────────────────────────────────
  // // Tokenisation-based repair. Covers corruption patterns that jsonrepair's
  // // character-by-character approach may miss, e.g. deeply nested escape
  // // sequence corruption or unusual Unicode substitutions.
  // //
  // // Returns a *parsed value* directly (like @isdk/json-repair), so no
  // // JSON.parse needed. Synchronous.
  // try {
  //   // jaison ships no TypeScript declarations — cast to `any` at the boundary.
  //   // eslint-disable-next-line @typescript-eslint/no-explicit-any
  //   const parsed = (jaison as any)(candidate);
  //   if (isPlainObject(parsed)) {
  //     console.log(`[${logContext}] 🔧 Stage 5: jaison`);
  //     return parsed as Record<string, unknown>;
  //   }
  // } catch {
  //   // jaison throws on failure — fall through.
  // }

  // ── Stage 6: Heuristic pre-fix → native JSON.parse ────────────────────────
  // Apply cheap, deterministic string fixups that address the most common AI
  // JSON quirks before trying native parse again. This often succeeds when the
  // AI output is *almost* valid JSON (e.g. single-quoted strings, trailing
  // comma on last property) without needing the overhead of a repair library.
  const fixed = heuristicFix(candidate);
  const fixedNative = tryParse(fixed);
  if (fixedNative) {
    console.log(`[${logContext}] 🔧 Stage 6: heuristic fix + native JSON.parse`);
    return fixedNative;
  }

  // ── Stage 7: Heuristic pre-fix → jsonrepair ───────────────────────────────
  // Belt-and-suspenders: pre-fixing the string before feeding it to jsonrepair
  // can unlock repairs that jsonrepair alone couldn't resolve. For example,
  // heuristic single-quote conversion sometimes untangles nested escape
  // sequences that were confusing jsonrepair's character scanner.
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
 *    extracts from after the opening fence to end-of-string.
 * 3. **Generic ` ``` ``` ` fence** — only accepted when the content starts
 *    with `{`, to avoid treating code blocks as JSON.
 * 4. **Balanced `{ … }`** — JSON object embedded in free text.
 * 5. **Truncated `{ …`** — no closing `}` present (max-token hit). Forwards
 *    the open fragment to `jsonrepair`/`@isdk/json-repair` which will close
 *    all unclosed braces and strings.
 *
 * Returns `null` only when no `{` exists anywhere in the input — meaning the
 * AI returned pure text with no JSON structure at all.
 *
 * @param clean      - Sanitised AI output string.
 * @param logContext - Log label.
 * @internal
 */
function extractJsonCandidate(clean: string, logContext: string): string | null {

  // ── Priority 1 & 2: ```json fences ──────────────────────────────────────
  if (/```json/i.test(clean)) {

    // Closed fence: ```json\n{...}\n```
    const closedMatch = clean.match(/```json\s*\n?([\s\S]*?)\n?```/i);
    if (closedMatch?.[1]) {
      console.log(`[${logContext}] 📋 Extracted from closed \`\`\`json block`);
      return closedMatch[1].trim();
    }

    // Unclosed fence: AI was truncated before it could emit the closing ```.
    // Strip everything up to and including the opening ```json marker, then
    // find the first `{` in the remainder. The resulting fragment (with no
    // closing `}`) will be forwarded to jsonrepair.
    const afterFence = clean.replace(/^[\s\S]*?```json\s*\n?/i, '').trim();
    const braceIdx = afterFence.indexOf('{');
    if (braceIdx !== -1) {
      console.log(
        `[${logContext}] 📋 Unclosed \`\`\`json fence — forwarding truncated fragment`,
      );
      return afterFence.substring(braceIdx);
    }
  }

  // ── Priority 3: Generic ``` fence ───────────────────────────────────────
  if (clean.includes('```')) {
    const genericMatch = clean.match(/```\s*\n?([\s\S]*?)\n?```/);
    if (genericMatch?.[1]) {
      const inner = genericMatch[1].trim();
      // Only treat as JSON if the block content looks like an object.
      if (inner.startsWith('{')) {
        console.log(`[${logContext}] 📋 Extracted from generic code block`);
        // May itself be truncated — the repair pipeline handles it.
        return inner;
      }
    }
  }

  // ── Priority 4 & 5: Raw / embedded JSON ─────────────────────────────────
  const start = clean.indexOf('{');
  if (start === -1) {
    // No `{` at all — this is definitely not JSON output.
    return null;
  }

  const end = clean.lastIndexOf('}');

  if (end > start) {
    // A balanced-looking object was found embedded in (possibly surrounding)
    // text. The outer text (preamble, postamble) is sliced away.
    return clean.substring(start, end + 1);
  }

  // end === -1 or end ≤ start:
  // The AI hit its token limit before closing the JSON object. There is no `}`
  // anywhere in the output. We forward the open fragment (from `{` to EOS)
  // to jsonrepair, which is specifically designed to close unclosed structures.
  //
  // Because important fields are placed first in the prompt, they will have
  // been serialised before the cut-off and will be recoverable. Tail fields
  // get schema defaults from `applySchemaDefaults`.
  console.log(`[${logContext}] ⚠️ Truncated JSON detected (no closing '}') — forwarding open fragment to repair pipeline`);
  return clean.substring(start);
}

// ─── Post-processing ──────────────────────────────────────────────────────────

/**
 * Applies the three post-parse finishing passes to a successfully parsed object:
 *
 * 1. **Trim** — recursively trims all string leaf values.
 * 2. **Default-fill** — fills absent/null fields using schema type defaults
 *    (protects against truncated tail fields).
 * 3. **Required-field assertion** — warns on any still-missing required field
 *    so the caller can decide how to handle it (throw, retry, degrade, etc.).
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

  // Pass 2: fill missing / null fields with type-appropriate defaults.
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
 * Recurses into nested `object` schema nodes so that deeply nested partial
 * objects (e.g. a `metadata` sub-object where only some fields arrived) are
 * also filled correctly.
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
      // Field completely missing or explicitly null — substitute a default.
      result[key] = defaultForProp(prop);
    } else if (prop.type === 'object' && prop.properties && isPlainObject(existing)) {
      // Field present but is a nested object — recurse to fill its sub-fields.
      result[key] = applySchemaDefaults(
        existing as Record<string, unknown>,
        prop.properties,
      );
    }
    // All other cases (field present and correct type): leave untouched.
  }

  return result as T;
}

/**
 * Returns the canonical "empty" default value for a JSON Schema property node.
 *
 * Defaults are intentionally minimal and falsy so application code can
 * distinguish "AI provided this" from "this was defaulted". Array and object
 * types default to empty collections rather than `null` so iteration code
 * never throws.
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
      // Recurse into nested schemas so deeply nested objects are properly
      // initialised rather than returning a bare {}.
      return prop.properties
        ? applySchemaDefaults({}, prop.properties)
        : {};
    default:
      return null;
  }
}

// ─── Heuristic pre-fixer ──────────────────────────────────────────────────────

/**
 * Applies lightweight, deterministic string fixups for the most common AI JSON
 * formatting mistakes.
 *
 * Intentionally cheap: pure string operations with simple regexes. The output
 * is tried with native `JSON.parse` first (Stage 6) before feeding to
 * `jsonrepair` (Stage 7), so no repair library overhead is incurred if the
 * fixups are sufficient.
 *
 * Fixes applied (in order):
 *   1. `convertSingleToDoubleQuotes` — `'key': 'val'` → `"key": "val"`
 *      Uses your existing utility which handles the tricky case of apostrophes
 *      inside single-quoted strings.
 *   2. Trailing commas — `, }` / `, ]` → `}` / `]`
 *   3. Unquoted keys — `{ key: "val" }` → `{ "key": "val" }`
 *
 * @internal
 */
function heuristicFix(input: string): string {
  let s = input;
  // Fix 1: single → double quotes (uses your existing utility).
  s = convertSingleToDoubleQuotes(s);
  // Fix 2: trailing commas that are invalid in strict JSON.
  s = s.replace(/,\s*([}\]])/g, '$1');
  // Fix 3: unquoted identifier keys (common in AI-generated JS-style objects).
  s = s.replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":');
  return s;
}

// ─── Partial key-value extraction ─────────────────────────────────────────────

/**
 * Last-resort regex sweep over a string that no structural parser could handle.
 *
 * Extracts scalar key-value pairs (string, number, boolean, null) via four
 * targeted patterns. Only recovers primitive values; array and object values
 * are skipped and left to schema defaults.
 *
 * Exported for use in diagnostics / logging pipelines that want to surface
 * what *was* recoverable from a completely broken AI response.
 *
 * @param input      - The JSON candidate string that failed all parse attempts.
 * @param logContext - Log label.
 * @returns A partial record of whatever scalar fields could be extracted.
 */
export function extractPartialJSON<T extends Record<string, unknown>>(
  input: string,
  logContext = 'extractPartialJSON',
): Partial<T> {
  const result: Record<string, unknown> = {};

  const patterns: RegExp[] = [
    // Pattern A: "key": "string value"  — handles internal escaped quotes.
    /"([^"]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g,
    // Pattern B: "key": number | true | false | null  — quoted key, primitive value.
    /"([^"]+)"\s*:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)\b/g,
    // Pattern C: 'key': 'value'  — AI single-quote style (captured before full fix).
    /'([^']+)'\s*:\s*'([^']*)'/g,
    // Pattern D: unquoted_key: "value"  — JS-object style without heuristic fix.
    /([A-Za-z_]\w*)\s*:\s*"((?:[^"\\]|\\.)*)"/g,
  ];

  for (const pattern of patterns) {
    // Re-create with flags to reset lastIndex between outer loop iterations.
    const re = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;

    while ((match = re.exec(input)) !== null) {
      const [, key, raw] = match;
      // Skip if key is empty or already extracted by an earlier pattern.
      if (!key || key in result) continue;

      // Coerce raw string to the appropriate JS primitive type.
      if (raw === 'true')        result[key] = true;
      else if (raw === 'false')  result[key] = false;
      else if (raw === 'null')   result[key] = null;
      else if (raw !== '' && !isNaN(Number(raw))) result[key] = Number(raw);
      else                       result[key] = raw;
    }
  }

  if (Object.keys(result).length > 0) {
    console.log(`[${logContext}] 🔧 Stage 8 partial extraction recovered: ${Object.keys(result).join(', ')}`);
  }

  return result as Partial<T>;
}

// ─── Shared primitives ────────────────────────────────────────────────────────

/**
 * Strips non-printable and invisible Unicode characters from a string, then
 * collapses all whitespace runs to a single space.
 *
 * Handles the four most common categories of "invisible noise" in AI output:
 *   - Control characters (U+0000–U+001F, U+007F–U+009F): null bytes, ESC, etc.
 *   - Unicode replacement character (U+FFFD): from charset mis-decoding.
 *   - Zero-width characters (U+200B–U+200F, U+FEFF BOM): from copy-paste.
 *   - Redundant whitespace: normalised so downstream regexes are simpler.
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
 * Returns `null` for arrays, primitives, `null`, and on any parse error.
 * Never throws — failure modes are part of the normal pipeline flow.
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
 * Type guard: returns `true` when `v` is a non-null, non-array plain object.
 *
 * Used throughout the pipeline to guard against `JSON.parse` returning arrays
 * or primitives when the AI wrapped the object in an extra array, etc.
 *
 * @internal
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Recursively trims whitespace from every string leaf in a plain-object tree.
 *
 * AI providers occasionally emit strings with leading/trailing newlines or
 * spaces inside JSON values. This ensures callers always receive clean strings
 * without needing to trim individually.
 *
 * Arrays are passed through untouched (their string elements are not trimmed)
 * to avoid surprising callers who store arrays of pre-formatted text.
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
