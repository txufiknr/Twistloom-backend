/**
 * Canonical paragraph split — the backend's authority for comment-anchor
 * numbering (Step 1 of `docs/roadmap/READER_COMMENT_ANCHOR_DURABILITY_ROADMAP.md`).
 *
 * Cross-platform contract: this split MUST stay byte-identical to web's
 * `splitParagraphs` (`Twistloom-web/src/lib/utils/story.ts`) and Flutter's
 * `AnchorParagraphs.split` (`lib/features/reader/utils/anchor_paragraphs.dart`),
 * because live web/Flutter comments are the installed base of
 * `user_comments.paragraph_number` data. The golden set in
 * `tests/fixtures/paragraph_segmentation.json` is copied byte-for-byte from
 * Flutter's `test/fixtures/paragraph_segmentation.json` (itself mirrored from
 * web); the harness below asserts identical output for every case. Any change
 * must land in ALL THREE repos in the same review.
 *
 * Scope: anchor validation at comment POST (Step 4) and the old/new paragraph
 * lists fed to the alignment engine (`alignParagraphs`, Step 2). Read paths
 * and the client-side render split are unaffected — clients keep computing
 * anchors from the text they hold, exactly as today.
 *
 * Segments are returned **verbatim** (no trimming — callers trim at display
 * time, mirroring web/Flutter); whitespace-only segments are dropped. The
 * returned index + 1 is the 1-based anchor number sent on the wire.
 */

/** Separator: one-or-two escaped newlines (`\n` as two literal characters) or one-or-two literal newlines. */
const PARAGRAPH_SEPARATOR = /(?:\\n){1,2}|\n{1,2}/;

/**
 * Splits page prose into the canonical, numbered paragraphs.
 *
 * @param text - Raw page prose (may be empty).
 * @returns Verbatim segments, whitespace-only segments dropped. Empty input
 *   yields an empty array. `result[i]` is anchor `i + 1`.
 */
export function splitCanonicalParagraphs(text: string): string[] {
  if (text.length === 0) return [];
  return text.split(PARAGRAPH_SEPARATOR).filter((segment) => segment.trim().length > 0);
}

/**
 * Whether a 1-based comment anchor still exists in a page's prose.
 *
 * This is the single statement of the anchor range rule — `[1, count]` where
 * `count` is the canonical split length of the page's *current* text — so
 * comment-POST validation (Step 4) and any future reader of an anchor agree by
 * construction. Anchors past the current count are exactly what a prose edit
 * invalidates; accepting one would strand a comment on a paragraph that no
 * longer exists.
 *
 * @param text - The page's stored prose.
 * @param anchor - Requested `paragraphNumber` (1-based).
 * @returns `true` only for an integer anchor in range; non-integers and
 *   out-of-range anchors return `false`.
 */
export function isAnchorInRange(text: string, anchor: number): boolean {
  if (!Number.isInteger(anchor) || anchor < 1) return false;
  return anchor <= splitCanonicalParagraphs(text).length;
}
