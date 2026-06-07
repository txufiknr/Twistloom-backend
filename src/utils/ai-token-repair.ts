/**
 * @file ai-token-repair.ts
 *
 * Self-contained tokenisation-level JSON corruption repair.
 *
 * ## Responsibility boundary
 *
 * This module sits at **Stage 5** of the `parseAISafely` pipeline, filling the
 * gap between structural repair libraries and the regex-based heuristic fixer:
 *
 * ```
 * Stage 3  jsonrepair          structural repair  (truncation, braces, commas)
 * Stage 4  @isdk/json-repair   semantic coercion  (schema-guided, async)
 * Stage 5  repairTokenCorruption ← THIS FILE      character/token level
 * Stage 6  heuristicFix        single quotes, unquoted keys
 * ```
 *
 * It handles corruption that lives *below* the structural level — things that
 * simple regex heuristics cannot safely target (because they lack
 * string-context awareness) and that `jsonrepair` either misses or rejects:
 *
 * | Phase | Category                          | Examples                              |
 * |-------|-----------------------------------|---------------------------------------|
 * | 1     | Typographic / smart quotes        | `"hello"` `«key»` `'val'` → ASCII    |
 * | 2     | Invalid escape sequences          | `\p` `\q` → `\\p` `\\q`              |
 * | 2     | Truncated unicode escapes         | `\u00` → `\\u00`                      |
 * | 2     | Unescaped control chars in strings| U+0009 (TAB) → `\u0009`              |
 * | 2     | Null bytes inside strings         | U+0000 → (removed)                   |
 * | 2     | Dangling backslash at end-of-input| `\` → `\\`                           |
 * | 3     | Semicolons as separators          | `; ` → `, `                          |
 * | 3     | Consecutive duplicate commas      | `,,` → `,`                            |
 *
 * ## What this deliberately does NOT cover
 *
 * - Structural repair (unclosed braces, missing commas between values)
 *   → handled by `jsonrepair` at Stage 3
 * - Semantic coercion (wrong types, enum mismatch)
 *   → handled by `@isdk/json-repair` at Stage 4
 * - Single-quoted strings
 *   → handled by `convertSingleToDoubleQuotes` in Stage 6 `heuristicFix`
 * - Unquoted object keys
 *   → handled by `heuristicFix` at Stage 6
 *
 * ## Design principles
 *
 * - **No third-party dependencies.** Pure TypeScript, zero imports.
 * - **String-context-aware.** Every fix that could corrupt a string value uses
 *   a stateful scanner rather than a blind regex.
 * - **Never throws.** All error cases are handled defensively. The caller
 *   decides what to do with the output.
 * - **Idempotent.** Applying this function twice yields the same result.
 * - **Output contract.** Returns a *string*, not a parsed object. The caller
 *   attempts `JSON.parse` on the result — same contract as `jsonrepair`.
 */

// ─── Phase 1: Typographic / smart quote normalisation ────────────────────────

/**
 * Maps every typographic ("smart") quote variant to its plain ASCII equivalent.
 *
 * LLMs and copy-paste from rich-text editors regularly emit these characters.
 * They are visually indistinguishable from ASCII quotes but cause every JSON
 * parser to reject the input immediately.
 *
 * Double-quote variants map to `"` (ASCII 0x22), the only valid JSON string
 * delimiter. Single-quote variants map to `'` (ASCII 0x27), which will be
 * handled downstream by `convertSingleToDoubleQuotes` in Stage 6 if needed.
 *
 * Unicode sources: Unicode General Category Po (Other Punctuation),
 * General Category Ps/Pe (Open/Close Punctuation) for angle brackets.
 */
const TYPOGRAPHIC_QUOTE_MAP: Readonly<Record<string, string>> = {
  // ── Curly / smart double quotes ──────────────────────────────────────────
  '\u201C': '"', // LEFT DOUBLE QUOTATION MARK         "  (English open)
  '\u201D': '"', // RIGHT DOUBLE QUOTATION MARK        "  (English close)
  '\u201E': '"', // DOUBLE LOW-9 QUOTATION MARK        „  (German open)
  '\u201F': '"', // DOUBLE HIGH-REVERSED-9 QUOT. MARK  ‟
  '\u00AB': '"', // LEFT-POINTING DOUBLE ANGLE QUOT.   «  (French/Spanish open)
  '\u00BB': '"', // RIGHT-POINTING DOUBLE ANGLE QUOT.  »  (French/Spanish close)
  '\u301D': '"', // REVERSED DOUBLE PRIME QUOT. MARK   〝  (CJK open)
  '\u301E': '"', // DOUBLE PRIME QUOTATION MARK        〞  (CJK close)
  '\u301F': '"', // LOW DOUBLE PRIME QUOTATION MARK    〟  (CJK alternative)
  // ── Curly / smart single quotes ──────────────────────────────────────────
  '\u2018': "'", // LEFT SINGLE QUOTATION MARK         '  (English open)
  '\u2019': "'", // RIGHT SINGLE QUOTATION MARK        '  (English close / apostrophe)
  '\u201A': "'", // SINGLE LOW-9 QUOTATION MARK        ‚  (German open)
  '\u201B': "'", // SINGLE HIGH-REVERSED-9 QUOT. MARK  ‛
  '\u2039': "'", // SINGLE LEFT-POINTING ANGLE QUOT.   ‹
  '\u203A': "'", // SINGLE RIGHT-POINTING ANGLE QUOT.  ›
  '\u0060': "'", // GRAVE ACCENT used as open quote    `  (common in code blocks)
};

/**
 * Pre-compiled `RegExp` matching any typographic quote in one pass.
 * Built once at module load; character class is derived from the map keys.
 */
const TYPOGRAPHIC_QUOTE_RE = new RegExp(
  `[${Object.keys(TYPOGRAPHIC_QUOTE_MAP).join('')}]`,
  'g',
);

/**
 * Replaces all typographic / smart quote characters with plain ASCII
 * equivalents in a single O(n) pass using a pre-compiled regex.
 *
 * Must run **before** the stateful scanner (Phase 2) so that string-boundary
 * detection always sees standard `"` characters — never curly variants — as
 * delimiters. Running it after would mean Phase 2 might mis-classify a curly
 * `"` as regular text and corrupt the string boundaries it is trying to track.
 *
 * @param input - Raw string from AI output (may contain any Unicode).
 * @returns String with all typographic quotes replaced by ASCII equivalents.
 */
function normalizeTypographicQuotes(input: string): string {
  return input.replace(
    TYPOGRAPHIC_QUOTE_RE,
    (ch) => TYPOGRAPHIC_QUOTE_MAP[ch] ?? ch,
  );
}

// ─── Phase 2: Stateful escape-sequence repair ─────────────────────────────────

/**
 * Valid single-character escape sequences defined by ECMA-404 §9 (JSON spec).
 *
 * After a backslash inside a string, the *only* valid next characters are
 * these. Anything else is an invalid escape that must be repaired. Note that
 * `'u'` is included here; the 4 hex-digit sub-validation is handled separately
 * in the scanner when `'u'` is encountered.
 */
const VALID_SINGLE_CHAR_ESCAPES = new Set([
  '"',  // escaped double quote     \"
  '\\', // escaped backslash        \\
  '/',  // escaped solidus          \/  (valid but optional)
  'b',  // backspace                \b
  'f',  // form feed                \f
  'n',  // newline                  \n
  'r',  // carriage return          \r
  't',  // horizontal tab           \t
  'u',  // unicode escape prefix    \uXXXX  (digits validated separately)
]);

/**
 * Walks the input character by character, tracking JSON string boundaries, and
 * repairs escape-sequence corruption found **inside** string literals.
 *
 * ## Why a stateful scanner instead of regex?
 *
 * Regex cannot distinguish `\p` inside a JSON string from `\p` appearing in
 * surrounding prose or a comment. Applying a regex globally would corrupt
 * valid non-JSON text that wraps the object. A stateful scanner is the only
 * correct approach.
 *
 * ## Scanner state machine
 *
 * Two implicit states tracked via the `inString` boolean:
 *
 * ```
 * OUTSIDE_STRING ──── sees `"` ────► IN_STRING
 *    (pass through)                   │
 *                                     ├── sees `\`  → repair or pass escape
 *                                     ├── sees `"`  → OUTSIDE_STRING
 *                                     ├── sees U+0000 → drop (null byte)
 *                                     └── sees U+0001–U+001F → \uXXXX escape
 * ```
 *
 * ## Repairs performed
 *
 * | Corruption                    | Input          | Output           |
 * |-------------------------------|----------------|------------------|
 * | Invalid single-char escape    | `\p`           | `\\p`            |
 * | Truncated unicode escape      | `\u00`         | `\\u00`          |
 * | Malformed unicode hex digits  | `\u2G4F`       | `\\u2G4F`        |
 * | Dangling backslash at EOS     | `"foo\`        | `"foo\\"`        |
 * | Null byte inside string       | `"fo\0o"`      | `"foo"`          |
 * | Unescaped control char        | `"fo\to"`      | `"fo\u0009o"`    |
 * | Truncated string at EOS       | `{"k": "v`     | `{"k": "v"`      |
 *
 * @param input - String after Phase 1 (typographic quotes already normalised).
 * @returns String with all escape sequences inside strings repaired.
 */
function repairEscapeSequences(input: string): string {
  // Array + join is O(n) for string building; concatenation in a hot loop is
  // O(n²) due to repeated allocation in V8's string rope implementation.
  const out: string[] = [];
  let i = 0;
  let inString = false;

  while (i < input.length) {
    const ch = input[i]!;

    // ── OUTSIDE a string literal ────────────────────────────────────────────
    if (!inString) {
      if (ch === '"') {
        // Enter string mode. The opening `"` is emitted as-is.
        inString = true;
      }
      out.push(ch);
      i++;
      continue;
    }

    // ── INSIDE a string literal ─────────────────────────────────────────────

    if (ch === '\\') {
      // ── Escape sequence start ─────────────────────────────────────────────
      const next = input[i + 1]; // `undefined` if backslash is the very last char

      if (next === undefined) {
        // Dangling backslash at end-of-input (AI truncated mid-escape).
        // Emit an escaped backslash so the string value is syntactically
        // correct; the outer structure may still be incomplete for jsonrepair
        // to handle at Stage 7.
        out.push('\\\\');
        i++;

      } else if (next === 'u') {
        // Potential \uXXXX unicode escape — requires exactly 4 hex digits
        // immediately following the `u` with no gaps.
        const hexSlice = input.slice(i + 2, i + 6);
        const isValidHex =
          hexSlice.length === 4 && /^[0-9A-Fa-f]{4}$/.test(hexSlice);

        if (isValidHex) {
          // Fully valid \uXXXX — emit all 6 characters unchanged.
          out.push('\\u', hexSlice);
          i += 6;
        } else {
          // Truncated (`\u00`) or malformed (`\u2G4F`) unicode escape.
          // Escape the backslash so the parser sees a literal backslash
          // followed by `u` — syntactically valid even if not the AI's intent.
          // The remaining characters will be processed normally next iteration.
          out.push('\\\\u');
          i += 2; // consume only `\` and `u`; leave the bad hex chars intact
        }

      } else if (VALID_SINGLE_CHAR_ESCAPES.has(next)) {
        // Fully valid single-character escape: \", \\, \/, \b, \f, \n, \r, \t
        // Emit both characters unchanged and advance past both.
        out.push('\\', next);
        i += 2;

      } else {
        // Invalid escape sequence (\p, \q, \a, \e, \j, \x, etc.).
        // The JSON spec prohibits all escapes not listed above.
        // We escape the backslash so the result becomes `\\X` — a literal
        // backslash followed by the character X, which is valid JSON and
        // preserves the AI's intended text content.
        out.push('\\\\', next);
        i += 2;
      }

    } else if (ch === '"') {
      // ── End of string literal ─────────────────────────────────────────────
      // Unescaped `"` closes the current string. Return to outside mode.
      inString = false;
      out.push(ch);
      i++;

    } else if (ch === '\u0000') {
      // ── Null byte inside a string ─────────────────────────────────────────
      // U+0000 causes most JSON parsers to reject the input entirely.
      // Our outer `sanitise()` strips null bytes from the raw input, but they
      // can theoretically reappear inside already-quoted JSON string values
      // that were embedded in the text. Silently drop them — the surrounding
      // text is almost certainly the AI's intent.
      i++;

    } else if (ch >= '\u0001' && ch <= '\u001F') {
      // ── Unescaped ASCII control character inside a string ─────────────────
      // ECMA-404 §9 prohibits U+0000–U+001F inside strings without escaping.
      // `sanitise()` removes these from the outer raw string, but they can
      // survive inside already-delimited JSON strings (e.g. a TAB character
      // literally embedded in a JSON string value).
      //
      // Escape as \uXXXX using `codePointAt` + manual hex padding.
      // We avoid JSON.stringify(ch) here because it would add surrounding
      // quotes, requiring us to strip them — an unnecessary allocation.
      const code = ch.codePointAt(0)!.toString(16).padStart(4, '0');
      out.push('\\u', code);
      i++;

    } else {
      // ── Normal printable character ─────────────────────────────────────────
      // Pass through completely unchanged.
      out.push(ch);
      i++;
    }
  }

  // ── Truncated string: end-of-input while still inside a string ─────────────
  // This happens when the AI hits its token limit mid-string-value. Adding the
  // closing `"` makes the string syntactically complete so downstream stages
  // (Stage 7: heuristicFix + jsonrepair) can close the remaining open braces.
  if (inString) {
    out.push('"');
  }

  return out.join('');
}

// ─── Phase 3: Outside-string separator fixes ──────────────────────────────────

/**
 * Applies a transformation to every **outside-string** segment of `input`,
 * leaving the content of string literals completely untouched.
 *
 * ## Algorithm
 *
 * Walk character by character, tracking `inString`:
 *   - Accumulate characters into the current segment.
 *   - On `"` (outside string): flush current outside segment through
 *     `transform`, then push the string segment verbatim until the closing `"`.
 *   - `\\X` inside strings: skip both characters to avoid mistaking an escaped
 *     `\"` for a string-closing delimiter.
 *
 * ## Why not a regex?
 *
 * Applying, e.g., `s.replace(/;/g, ',')` to the whole input would corrupt
 * a string value like `"Use ; as delimiter"` → `"Use , as delimiter"`.
 * String-boundary-awareness is mandatory for safe separator repair.
 *
 * @param input     - String after Phases 1 and 2 (string boundaries are
 *                    well-formed; escape sequences are valid).
 * @param transform - Pure function applied to each outside-string segment.
 * @returns Reassembled string with `transform` applied outside strings only.
 */
function transformOutsideStrings(
  input: string,
  transform: (segment: string) => string,
): string {
  const parts: string[] = [];
  let segStart = 0; // start of the current accumulation segment
  let i = 0;
  let inString = false;

  while (i < input.length) {
    const ch = input[i]!;

    if (!inString) {
      if (ch === '"') {
        // Outside segment ends here — transform and store it.
        parts.push(transform(input.slice(segStart, i)));
        // The string segment begins at this `"`.
        segStart = i;
        inString = true;
        i++;
      } else {
        i++;
      }
    } else {
      if (ch === '\\' && i + 1 < input.length) {
        // Skip escaped character — it cannot be a string delimiter.
        // This correctly handles `\"` (escaped quote inside a string).
        i += 2;
      } else if (ch === '"') {
        // Closing `"` — string segment ends.
        inString = false;
        i++;
        // Push the complete string literal (both delimiters + content) verbatim.
        parts.push(input.slice(segStart, i));
        // Next outside segment starts immediately after the closing `"`.
        segStart = i;
      } else {
        i++;
      }
    }
  }

  // Flush the final segment (could be outside or a truncated unclosed string).
  if (segStart < input.length) {
    const tail = input.slice(segStart);
    // If still inString, Phase 2 already closed it — treat as outside.
    // Either way, the tail is pushed after applying transform if outside,
    // or verbatim if it's a residual string fragment.
    parts.push(inString ? tail : transform(tail));
  }

  return parts.join('');
}

/**
 * Repairs separator-level issues in structural (outside-string) positions.
 *
 * Only targets patterns that are **unambiguously wrong** outside a string and
 * safe to fix without brace-depth tracking. Missing-comma injection between
 * adjacent values is deliberately excluded — it requires depth tracking and
 * is already handled by `jsonrepair` at Stage 3; re-attempting it here with
 * a naive regex would produce false positives (e.g. `} "note"` at the
 * top-level, where `}` closes the document, not an array element).
 *
 * ## Fixes applied
 *
 * **Semicolons as property / element separators:**
 * Some models emit `;` where `,` is required, likely because training data
 * included JavaScript/TypeScript source where statements end with `;`.
 * ```
 * { "a": 1; "b": 2 }  →  { "a": 1, "b": 2 }
 * ```
 *
 * **Consecutive duplicate commas:**
 * Occasionally produced by template rendering bugs or AI retries where a
 * comma-terminated element is duplicated.
 * ```
 * [1,,2,,,3]  →  [1,2,3]
 * ```
 *
 * @param input - String after Phases 1 and 2 (well-formed string boundaries).
 * @returns String with outside-string separator issues repaired.
 */
function repairOutsideSeparators(input: string): string {
  return transformOutsideStrings(input, (segment) => {
    let s = segment;

    // Fix 1: semicolons → commas.
    // `transformOutsideStrings` guarantees we are outside all string literals,
    // so any `;` here is structural — safe to replace unconditionally.
    s = s.replace(/;/g, ',');

    // Fix 2: consecutive commas → single comma.
    // Matches any run of commas with optional whitespace between them,
    // e.g. `,,`, `, ,`, `,  ,,` — all collapsed to a single `,`.
    s = s.replace(/,(\s*,)+/g, ',');

    return s;
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Repairs tokenisation-level JSON corruption through a deterministic
 * three-phase pipeline.
 *
 * This is the drop-in replacement for the `jaison` npm package, implemented
 * in self-contained TypeScript with zero external dependencies.
 *
 * ## Phase summary
 *
 * ```
 * Phase 1  normalizeTypographicQuotes   O(n) regex substitution, no state
 * Phase 2  repairEscapeSequences        O(n) stateful character scanner
 * Phase 3  repairOutsideSeparators      O(n) string-boundary-aware segment map
 * ```
 *
 * Total complexity: O(n) time, O(n) space (output array).
 *
 * ## Output contract
 *
 * - Returns a **string** (not a parsed object) — same contract as `jsonrepair`.
 *   The caller attempts `JSON.parse` on the result.
 * - **Never throws.** Every corruption case is handled defensively. If the
 *   output is still not parseable, the caller continues to the next pipeline
 *   stage.
 * - **Idempotent.** Running this function on its own output produces no
 *   further changes.
 * - Does **not** guarantee valid JSON — it makes the input *more likely* to
 *   be parseable. Structural issues (unclosed braces, etc.) remain for
 *   `jsonrepair` at Stage 7.
 *
 * ## Pipeline position in `parseAISafely`
 *
 * ```
 * Stage 2  native JSON.parse             sync   zero cost
 * Stage 3  jsonrepair → JSON.parse       sync   structural + truncation
 * Stage 4  @isdk/json-repair + schema    async  semantic coercion
 * Stage 5  repairTokenCorruption → parse sync   ← THIS FUNCTION
 * Stage 6  heuristicFix → JSON.parse     sync   single quotes, unquoted keys
 * Stage 7  heuristicFix → jsonrepair     sync   combined belt-and-suspenders
 * ```
 *
 * @param input - Raw JSON candidate string. Should already have been through
 *   the outer `sanitise()` call (strips control chars and invisible Unicode),
 *   but may still contain typographic quotes and corrupt escape sequences.
 * @returns Repaired string, ready for `JSON.parse` or further pipeline stages.
 *
 * @example
 * // Curly quotes from a word processor or certain AI providers:
 * repairTokenCorruption('\u201C{\u201Cname\u201D: \u201CAlice\u201D}\u201D')
 * // → '{"name": "Alice"}'
 *
 * @example
 * // Invalid escape sequence in a Windows-style path:
 * repairTokenCorruption('{"path": "C:\\Users\\alice\\docs"}')
 * // The double-backslashes are already valid — passed through unchanged.
 *
 * @example
 * // LLM emits \p as an escape (not valid JSON):
 * repairTokenCorruption('{"note": "See \\page 42"}')
 * // → '{"note": "See \\\\page 42"}'  (backslash escaped → literal \page)
 *
 * @example
 * // Semicolon separator (JS-trained model habit):
 * repairTokenCorruption('{"a": 1; "b": 2}')
 * // → '{"a": 1, "b": 2}'
 */
export function repairTokenCorruption(input: string): string {
  // Phase 1: Normalise typographic / smart quotes to plain ASCII.
  //
  // MUST run first: Phase 2's string-boundary detection relies on seeing
  // standard `"` (U+0022) as delimiters. If a curly `"` (U+201C) were still
  // present, Phase 2 would treat it as regular text, mis-track string
  // boundaries, and apply escape repairs in the wrong positions.
  let s = normalizeTypographicQuotes(input);

  // Phase 2: Stateful character scan — repair escape sequences and control
  // characters within string literals.
  //
  // After this phase: all `\X` sequences inside strings are valid per
  // ECMA-404; all control chars inside strings are \uXXXX-escaped; any
  // truncated string is closed with a `"`. String boundaries are now
  // well-formed and can be trusted by Phase 3.
  s = repairEscapeSequences(s);

  // Phase 3: String-boundary-aware separator fixes — applied ONLY to
  // characters outside string literals.
  //
  // After Phase 2 ensures boundaries are reliable, Phase 3 can safely
  // distinguish structural `;` separators from `;` inside a string value.
  s = repairOutsideSeparators(s);

  return s;
}
