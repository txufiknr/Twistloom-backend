import { jsonrepair } from 'jsonrepair';
import type { AIResponse, AIJsonProperty } from '../types/ai-chat.js';
import { convertSingleToDoubleQuotes } from './quote.js';

// ─── Option types ─────────────────────────────────────────────────────────────

/**
 * Options for `parseAISafely`.
 *
 * Maps cleanly to `AIPromptOptions` fields from your prompt layer:
 *   outputJsonStructure  → schema
 *   outputJsonRequired   → requiredFields
 *   outputJsonFallbackField → fallbackField
 */
export interface ParseAIOptions<T extends Record<string, unknown>> {
  /** Label used in log messages. Defaults to the AI provider name. */
  logContext?: string;
  /** Hard cap on input characters before truncation (default: 20 000). */
  maxLength?: number;
  /**
   * Fall back to partial regex key-value extraction when every structural
   * parse attempt fails (default: true).
   */
  allowPartialObjects?: boolean;
  /**
   * Key used when no JSON can be extracted at all and we fall through to
   * plain-text mode. Defaults to `'output'`.
   */
  fallbackField?: keyof T;
  /**
   * JSON-schema descriptor for each output field — the same shape you pass
   * to `outputJsonStructure` in your prompt options.
   *
   * After a successful (possibly partial) parse, any field that is absent or
   * null is filled with a type-appropriate default:
   *   string → ''  |  number/integer → 0  |  boolean → false
   *   array → []   |  object → {}  (recursed)
   *
   * This is the main safety net when a truncated response drops tail fields.
   * Required fields that are STILL missing after defaults are applied are
   * logged as warnings so the caller can decide how to handle them.
   */
  schema?: { [K in keyof T]?: AIJsonProperty };
  /**
   * Fields that MUST be present in the final result.
   * A warning is logged (not thrown) for each missing required field —
   * the caller controls error propagation.
   */
  requiredFields?: (keyof T)[];
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Enterprise-grade, fault-tolerant AI JSON parser.
 *
 * ## Parse pipeline
 * Each stage runs only when all previous stages fail.
 *
 * | Stage | Strategy                                         | Handles                               |
 * |-------|--------------------------------------------------|---------------------------------------|
 * | 1     | Native `JSON.parse`                              | Clean output — zero overhead          |
 * | 2     | `jsonrepair` → `JSON.parse`                      | **Truncation**, trailing commas,      |
 * |       |                                                  | unquoted keys, single quotes, etc.    |
 * | 4     | Heuristic pre-fix → `JSON.parse`                 | Single quotes, trailing commas (fast) |
 * | 5     | Heuristic pre-fix → `jsonrepair`                 | Belt-and-suspenders combination       |
 * | 6     | `extractPartialJSON` regex sweep                 | Scalar KV pairs from wreckage         |
 * | 7     | Plain-text fallback `{ [fallbackField]: text }`  | Absolute last resort                  |
 *
 * ## After any successful parse
 * 1. All string leaves are trimmed.
 * 2. Missing / null fields are filled from `schema` defaults.
 * 3. Required-field presence is asserted (warn-only).
 *
 * ## Truncation strategy
 * When the AI hits max tokens mid-object there is no closing `}`.
 * `extractJsonCandidate` detects this and forwards the open fragment directly
 * to stage 2 (`jsonrepair`), which closes every unclosed brace and string.
 * Because your important fields are at the top of the schema, they survive
 * the truncation; tail fields that are cut off receive schema defaults.
 */
export function parseAISafely<T extends Record<string, unknown>>(
  response: AIResponse<T>,
  options: ParseAIOptions<T> = {},
): T {
  const { output, provider } = response;
  const {
    logContext = provider,
    maxLength = 20_000,
    allowPartialObjects = true,
    schema,
    requiredFields = [],
  } = options;

  // ── 1. Input validation ────────────────────────────────────────────────────
  if (!output || typeof output !== 'string') {
    console.warn(`[${logContext}] ⚠️ Invalid input — expected string, got ${typeof output}`);
    return {} as T;
  }

  let input = output;
  if (input.length > maxLength) {
    console.warn(`[${logContext}] ⚠️ Input too long (${input.length} chars), truncating to ${maxLength}`);
    input = input.slice(0, maxLength);
  }

  // ── 2. Sanitise ───────────────────────────────────────────────────────────
  const cleanInput = sanitise(input);

  // ── 3. Locate / extract the JSON candidate ────────────────────────────────
  const candidate = extractJsonCandidate(cleanInput, logContext);

  if (candidate === null) {
    console.warn(`[${logContext}] ⚠️ No JSON object found — plain-text fallback`);
    return { [options.fallbackField ?? 'output']: cleanInput } as T;
  }

  // ── 4. Repair + parse pipeline ────────────────────────────────────────────
  const rawParsed = runParsePipeline(candidate, logContext);
  if (rawParsed !== null) {
    return postProcess<T>(rawParsed, schema, requiredFields, logContext);
  }

  // ── 5. Partial regex key-value extraction ─────────────────────────────────
  if (allowPartialObjects) {
    const partial = extractPartialJSON<T>(candidate, logContext);
    if (Object.keys(partial).length > 0) {
      console.log(`[${logContext}] 🔄 Using partial JSON extraction`);
      return postProcess<T>(
        partial as Record<string, unknown>,
        schema,
        requiredFields,
        logContext,
      );
    }
  }

  // ── 6. Plain-text fallback ────────────────────────────────────────────────
  console.warn(`[${logContext}] 🔄 All parse attempts failed — plain-text fallback`);
  return { [options.fallbackField ?? 'output']: cleanInput } as T;
}

// ─── Parse pipeline ───────────────────────────────────────────────────────────

/**
 * Runs each repair strategy in turn and returns the first result that is a
 * plain object, or `null` if every stage fails.
 *
 * `jsonrepair` is the workhorse for structural issues (including truncation).
 * The heuristic pre-fix targets AI-specific quirks (single quotes, unquoted
 * keys) that occasionally trip up both libraries.
 */
function runParsePipeline(
  candidate: string,
  logContext: string,
): Record<string, unknown> | null {
  // Stage 1 — native (zero overhead, handles clean output)
  const native = tryParse(candidate);
  if (native) {
    console.log(`[${logContext}] ✅ Stage 1: native JSON.parse`);
    return native;
  }

  // Stage 2 — jsonrepair: the gold standard for structural repair.
  // Explicitly handles: truncated JSON (unclosed braces/strings/arrays),
  // trailing commas, single quotes, unquoted keys, markdown fences, etc.
  try {
    const repaired = jsonrepair(candidate);
    const parsed = tryParse(repaired);
    if (parsed) {
      console.log(`[${logContext}] 🔧 Stage 2: jsonrepair`);
      return parsed;
    }
  } catch {
    /* fall through */
  }

  // // Stage 3 — jaison: tokenisation-level repair for corruption patterns
  // // jsonrepair may not cover (e.g. deeply mangled escape sequences).
  // try {
  //   const parsed = jaison(candidate);
  //   if (isPlainObject(parsed)) {
  //     console.log(`[${logContext}] 🔧 Stage 3: jaison`);
  //     return parsed;
  //   }
  // } catch {
  //   /* fall through */
  // }

  // Stage 4 — heuristic pre-fix → native parse.
  // Handles the most common AI-specific quirks quickly before calling external
  // libraries, giving another chance at native parse after fixup.
  const fixed = heuristicFix(candidate);
  const fixedNative = tryParse(fixed);
  if (fixedNative) {
    console.log(`[${logContext}] 🔧 Stage 4: heuristic fix + native`);
    return fixedNative;
  }

  // Stage 5 — heuristic pre-fix → jsonrepair (belt-and-suspenders).
  // Pre-fixing first can unlock repairs that jsonrepair alone couldn't resolve.
  try {
    const repaired = jsonrepair(fixed);
    const parsed = tryParse(repaired);
    if (parsed) {
      console.log(`[${logContext}] 🔧 Stage 5: heuristic fix + jsonrepair`);
      return parsed;
    }
  } catch {
    /* fall through */
  }

  return null;
}

// ─── JSON candidate extraction ────────────────────────────────────────────────

/**
 * Extracts the most likely JSON object string from raw AI output.
 *
 * Priority:
 *   1. ` ```json ... ``` ` — explicit fenced block (closed or unclosed)
 *   2. ` ``` ... ``` `     — generic code block whose content starts with `{`
 *   3. `{ … }`            — balanced object embedded in free text
 *   4. `{ …`             — **TRUNCATED** (no closing `}`): passes the open
 *                           fragment to `jsonrepair` for completion
 *
 * Returns `null` only when no `{` exists anywhere in the input.
 */
function extractJsonCandidate(clean: string, logContext: string): string | null {
  // ── Fenced blocks ───────────────────────────────────────────────────────
  if (/```json/i.test(clean)) {
    // Closed ```json block
    const closed = clean.match(/```json\s*\n?([\s\S]*?)\n?```/i);
    if (closed?.[1]) {
      console.log(`[${logContext}] 📋 Extracted from \`\`\`json block`);
      return closed[1].trim();
    }
    // Unclosed ```json block — AI was cut off before the closing fence.
    // Strip everything before the opening fence and forward the fragment.
    const afterFence = clean.replace(/^[\s\S]*?```json\s*\n?/i, '').trim();
    const braceIdx = afterFence.indexOf('{');
    if (braceIdx !== -1) {
      console.log(`[${logContext}] 📋 Unclosed \`\`\`json block — forwarding truncated fragment`);
      return afterFence.substring(braceIdx);
    }
  }

  if (clean.includes('```')) {
    const m = clean.match(/```\s*\n?([\s\S]*?)\n?```/);
    if (m?.[1]) {
      const inner = m[1].trim();
      if (inner.startsWith('{')) {
        console.log(`[${logContext}] 📋 Extracted from generic code block`);
        return inner; // May itself be truncated — repair handles it
      }
    }
  }

  // ── Raw / embedded JSON ─────────────────────────────────────────────────
  const start = clean.indexOf('{');
  if (start === -1) return null; // No JSON whatsoever — caller handles

  const end = clean.lastIndexOf('}');

  if (end > start) {
    // Looks structurally complete — still may be internally broken, but
    // that's what the parse pipeline is for.
    return clean.substring(start, end + 1);
  }

  // end === -1 or end ≤ start → truncated JSON; no closing `}` present.
  // Forward the open fragment — jsonrepair will close all unclosed
  // braces and strings, recovering whatever fields were serialised before
  // the model hit its token limit.
  console.log(`[${logContext}] ⚠️ Truncated JSON (no closing '}') — forwarding open fragment to repair`);
  return clean.substring(start);
}

// ─── Post-processing ──────────────────────────────────────────────────────────

function postProcess<T extends Record<string, unknown>>(
  raw: Record<string, unknown>,
  schema: { [K in keyof T]?: AIJsonProperty } | undefined,
  requiredFields: (keyof T)[],
  logContext: string,
): T {
  // 1. Trim all string leaves
  let result = trimStringValues<T>(raw);

  // 2. Fill missing / null fields from schema defaults
  if (schema) {
    result = applySchemaDefaults<T>(result, schema as Record<string, AIJsonProperty>);
  }

  // 3. Warn on still-missing required fields (caller decides what to do)
  if (requiredFields.length > 0) {
    const missing = requiredFields.filter((f) => {
      const v = result[f as string];
      return v === undefined || v === null;
    });
    if (missing.length > 0) {
      console.warn(`[${logContext}] ⚠️ Missing required fields after parse: ${missing.map(String).join(', ')}`);
    }
  }

  return result;
}

// ─── Schema-default filling ───────────────────────────────────────────────────

/**
 * Fills every field in `schema` that is absent or null in `obj` with a
 * type-appropriate default value.  Existing non-null values are NEVER
 * overwritten.  Recurses into nested `object` schema nodes.
 *
 * This is the safety net for truncated responses: required fields survive
 * because they are serialised first; tail fields get harmless empty defaults.
 */
function applySchemaDefaults<T extends Record<string, unknown>>(
  obj: T,
  schema: Record<string, AIJsonProperty>,
): T {
  const result: Record<string, unknown> = { ...obj };

  for (const [key, prop] of Object.entries(schema)) {
    const existing = result[key];

    if (existing === undefined || existing === null) {
      result[key] = defaultForProp(prop);
    } else if (prop.type === 'object' && prop.properties && isPlainObject(existing)) {
      // Recurse — fill missing nested fields without touching present ones
      result[key] = applySchemaDefaults(
        existing as Record<string, unknown>,
        prop.properties,
      );
    }
  }

  return result as T;
}

function defaultForProp(prop: AIJsonProperty): unknown {
  switch (prop.type) {
    case 'string': return '';
    case 'integer': case 'number': return 0;
    case 'boolean': return false;
    case 'array': return [];
    case 'object': return prop.properties ? applySchemaDefaults({}, prop.properties) : {};
    default: return null;
  }
}

// ─── Heuristic pre-fixer ──────────────────────────────────────────────────────

/**
 * Applies lightweight, deterministic fixups for the most common AI JSON
 * formatting mistakes before handing off to a structural repair library.
 *
 * These are deliberately cheap string operations — the caller tries native
 * `JSON.parse` on the result before touching `jsonrepair` again.
 */
function heuristicFix(input: string): string {
  let s = input;
  s = convertSingleToDoubleQuotes(s);                         // 'key' → "key"
  s = s.replace(/,\s*([}\]])/g, '$1');                       // trailing commas
  s = s.replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":'); // unquoted keys
  return s;
}

// ─── Partial key-value extraction ─────────────────────────────────────────────

/**
 * Last-resort regex-based extraction of scalar key-value pairs from a string
 * that no structural parser could handle.
 *
 * Recovers only primitive values (string, number, boolean, null).
 * Array / object values are intentionally skipped — schema defaults cover them.
 *
 * Exported so callers can use it independently (e.g. for diagnostics).
 */
export function extractPartialJSON<T extends Record<string, unknown>>(
  input: string,
  logContext = 'extractPartialJSON',
): Partial<T> {
  const result: Record<string, unknown> = {};

  const patterns: RegExp[] = [
    // "key": "string value"  (handles internal escaped quotes)
    /"([^"]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g,
    // "key": number | true | false | null
    /"([^"]+)"\s*:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)\b/g,
    // 'key': 'value'  (AI single-quote style)
    /'([^']+)'\s*:\s*'([^']*)'/g,
    // unquoted_key: "value"
    /([A-Za-z_]\w*)\s*:\s*"((?:[^"\\]|\\.)*)"/g,
  ];

  for (const pattern of patterns) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(input)) !== null) {
      const [, key, raw] = match;
      if (!key || key in result) continue;

      if (raw === 'true') result[key] = true;
      else if (raw === 'false') result[key] = false;
      else if (raw === 'null') result[key] = null;
      else if (raw !== '' && !isNaN(Number(raw))) result[key] = Number(raw);
      else result[key] = raw;
    }
  }

  if (Object.keys(result).length > 0) {
    console.log(`[${logContext}] 🔧 Partial extraction recovered: ${Object.keys(result).join(', ')}`);
  }

  return result as Partial<T>;
}

// ─── Shared primitives ────────────────────────────────────────────────────────

/** Strips control chars, Unicode junk, and normalises whitespace. */
function sanitise(input: string): string {
  return input
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '') // control chars (null bytes, escape seqs)
    .replace(/\uFFFD/g, '')                         // Unicode replacement char
    .replace(/[\u200B-\u200F\uFEFF]/g, '')          // zero-width / BOM chars
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Attempts `JSON.parse` and returns the result only when it is a plain object.
 * Returns `null` on any failure — never throws.
 */
function tryParse(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    return isPlainObject(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Recursively trims string leaves in a plain-object tree. */
function trimStringValues<T extends Record<string, unknown>>(obj: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') out[k] = v.trim();
    else if (isPlainObject(v)) out[k] = trimStringValues(v);
    else out[k] = v;
  }
  return out as T;
}
