/**
 * Parses the `[character_id]` / `[mc]` / `[???]` dialogue-attribution
 * markers the AI writes at the start of spoken-dialogue lines in page text
 * (see `RULES_DIALOGUE_ATTRIBUTION` in utils/prompt.ts for the generation
 * side of this contract) into structured segments a frontend can render as
 * distinct "speech" UI instead of plain prose — the "gamified dialogue"
 * concept from TODO-gamified-dialogue-chatgpt.md, scoped down to markers
 * only rather than a full structured-JSON dialogue block, so it layers on
 * top of the existing plain-`text`-field pipeline with zero schema change.
 *
 * Every consumer of this module (frontend renderer, translation pipeline,
 * TTS, EPUB export) should go through `parseDialogueMarkers` or
 * `stripDialogueMarkers` rather than hand-rolling a marker regex — see
 * `DIALOGUE_MARKER_SOURCE` below for why.
 */

/**
 * Parsed dialogue segment from a story page's `text` field.
 */
export type DialogueSegment = {
  type: 'prose';
  text: string;
} | {
  type: 'dialogue';
  /**
   * Raw ID as written by the AI — a real character ID (e.g. `tom_m`), the
   * reserved literal `mc` (the MC speaking aloud), or the literal `???`
   * (deliberately unidentified speaker). Resolving this to a reader-facing
   * display name (including recognition-level gating) is the caller's job —
   * this module only parses structure, it never looks up names.
   */
  speakerId: string;
  text: string;
};

/**
 * Source pattern for a dialogue marker anchored to the start of a line:
 * `[character_id]` or `[???]`, optional whitespace, then the rest of the
 * line. Capture group 1 is the speaker ID; capture group 2 is the line's
 * remaining text.
 *
 * Kept as a single string and compiled into two `RegExp`s below (one
 * flagless for per-line matching, one `gm` for whole-text scanning) rather
 * than writing the pattern out twice — a prior draft of this module (see
 * PHASE_AWARE_SANITY_STYLISTIC_CONSTRAINTS_DIALOGUE_MARKERS.md's original
 * proposal) hand-wrote two independent regex literals for these two jobs,
 * and one of them was missing its opening capture-group parenthesis
 * (effectively `^\[[\w_]+|\?\?\?)\]` — an unmatched closing paren with no
 * matching open, a SyntaxError at import time). One source string makes
 * that class of drift impossible.
 */
const DIALOGUE_MARKER_SOURCE = String.raw`^\[([\w_]+|\?\?\?)\]\s*(.*)$`;

/** Per-line match (single line, no `g` flag) — used by parseDialogueMarkers/stripDialogueMarkers. */
const DIALOGUE_MARKER_LINE_PATTERN = new RegExp(DIALOGUE_MARKER_SOURCE);

/** Whole-text existence scan (`gm`) — used by hasDialogueMarkers. */
const DIALOGUE_MARKER_SCAN_PATTERN = new RegExp(DIALOGUE_MARKER_SOURCE, 'gm');

/**
 * Parses a page's `text` field into prose and dialogue segments.
 *
 * Splits on lines that start with a dialogue marker. Consecutive
 * non-marker lines are accumulated and flushed as a single `prose` segment
 * (trimmed) whenever a marker is hit and at the end of input — so
 * multi-line narration between two spoken lines stays one segment rather
 * than fragmenting per line.
 *
 * @param text - Raw page text from AI generation
 * @returns Ordered array of prose and dialogue segments
 *
 * @example
 * parseDialogueMarkers('The hall was quiet.\n[mara] "Hello."\n[elias] "Hi."');
 * // [
 * //   { type: 'prose', text: 'The hall was quiet.' },
 * //   { type: 'dialogue', speakerId: 'mara', text: '"Hello."' },
 * //   { type: 'dialogue', speakerId: 'elias', text: '"Hi."' },
 * // ]
 */
export function parseDialogueMarkers(text: string): DialogueSegment[] {
  const segments: DialogueSegment[] = [];
  const lines = text.split('\n');
  let currentProse: string[] = [];

  const flushProse = () => {
    const proseText = currentProse.join('\n').trim();
    if (proseText) segments.push({ type: 'prose', text: proseText });
    currentProse = [];
  };

  for (const line of lines) {
    const match = line.match(DIALOGUE_MARKER_LINE_PATTERN);
    if (match) {
      flushProse();
      segments.push({ type: 'dialogue', speakerId: match[1], text: match[2].trim() });
    } else {
      currentProse.push(line);
    }
  }
  flushProse();

  return segments;
}

/**
 * Strips dialogue markers from text, returning plain prose with the spoken
 * lines still present (just unmarked) — for the translation pipeline, TTS,
 * EPUB export, or any consumer that wants readable text without the
 * structural markers.
 *
 * Unlike `parseDialogueMarkers`, this does not classify or reorder
 * anything: every line's relative position and content (minus the marker
 * prefix) is preserved.
 *
 * @param text - Raw page text with markers
 * @returns Text with every leading `[id]`/`[mc]`/`[???]` marker removed
 *
 * @example
 * stripDialogueMarkers('[mara] "Hello."\n[elias] "Hi."'); // '"Hello."\n"Hi."'
 */
export function stripDialogueMarkers(text: string): string {
  return text
    .split('\n')
    .map(line => line.replace(DIALOGUE_MARKER_LINE_PATTERN, '$2'))
    .join('\n');
}

/**
 * Cheap existence check — does this text contain at least one dialogue
 * marker? Used for the soft (non-blocking) coverage warning in
 * page-validation.ts's `checkDialogueMarkerCoverage`; NOT a correctness
 * check on its own (a page can legitimately have zero markers if it has no
 * spoken dialogue at all — see that function's JSDoc for why this is
 * heuristic, not authoritative).
 *
 * @param text - Raw page text
 */
export function hasDialogueMarkers(text: string): boolean {
  // Global regexes are stateful (lastIndex) across calls — reset before
  // every test, matching the same precaution page-validation.ts's
  // JSON_LEAK_RE already takes for the same reason.
  DIALOGUE_MARKER_SCAN_PATTERN.lastIndex = 0;
  return DIALOGUE_MARKER_SCAN_PATTERN.test(text);
}
