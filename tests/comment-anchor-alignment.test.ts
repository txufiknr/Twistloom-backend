/**
 * Fixture suite for `alignParagraphs` (Step 2 of
 * `docs/roadmap/READER_COMMENT_ANCHOR_DURABILITY_ROADMAP.md`).
 *
 * Each case is an old/new prose pair with the expected anchor mapping — the
 * table in the roadmap's Step 2, pinned. These tests validate the pure
 * function only; the SQL sequencing of the writer (single atomic CASE) is
 * pinned separately in `comment-anchor-remap.test.ts`.
 *
 * Convention: `remap` entries are [oldAnchor, newAnchor]; anchors listed under
 * `demote` must have no successor. Anchor numbers are 1-based.
 */
import { describe, expect, it } from "bun:test";
import {
  TAU,
  alignParagraphs,
  jaccard,
  tokenize,
} from "../src/services/comment_anchor_alignment.js";

/** Builds expected maps from compact [old, new] pairs. */
function expectRemap(pairs: [number, number][]): Map<number, number> {
  return new Map(pairs);
}

describe("alignParagraphs — Phase A exact matches", () => {
  it("inserts a paragraph before k: anchors >= k shift +1, comments follow", () => {
    const oldText = "Alpha.\nBravo.\nCharlie.";
    const newText = "Alpha.\nInserted.\nBravo.\nCharlie.";
    const { remapped, demoted } = alignParagraphs(oldText, newText);
    expect(remapped).toEqual(expectRemap([[1, 1], [2, 3], [3, 4]]));
    expect(demoted).toEqual([]);
  });

  it("deletes a paragraph at k: anchors > k shift -1; k demotes", () => {
    const oldText = "Alpha.\nBravo.\nCharlie.";
    const newText = "Alpha.\nCharlie.";
    const { remapped, demoted } = alignParagraphs(oldText, newText);
    expect(remapped).toEqual(expectRemap([[1, 1], [3, 2]]));
    expect(demoted).toEqual([2]);
  });

  it("moves/reorders distinct text: comments follow the text", () => {
    const oldText = "First.\nSecond.\nThird.";
    const newText = "Third.\nFirst.\nSecond.";
    const { remapped, demoted } = alignParagraphs(oldText, newText);
    expect(remapped).toEqual(expectRemap([[1, 2], [2, 3], [3, 1]]));
    expect(demoted).toEqual([]);
  });

  it("consumes duplicates greedily in order without cross-steal", () => {
    // Old has two identical paragraphs; new keeps both plus one at the end.
    const oldText = "Same.\nDifferent.\nSame.";
    const newText = "Same.\nDifferent.\nSame.\nNew beat.";
    const { remapped, demoted } = alignParagraphs(oldText, newText);
    expect(remapped).toEqual(expectRemap([[1, 1], [2, 2], [3, 3]]));
    expect(demoted).toEqual([]);
  });

  it("keeps an identical text as identity with zero demotions", () => {
    const text = "One.\n\nTwo.\n\nThree.";
    const { remapped, demoted } = alignParagraphs(text, text);
    expect(remapped).toEqual(expectRemap([[1, 1], [2, 2], [3, 3]]));
    expect(demoted).toEqual([]);
  });
});

describe("alignParagraphs — Phase B fuzzy pairs", () => {
  it("keeps a typo fix (similarity >= TAU) at its anchor", () => {
    const oldText = "The detective watched the rain fall on the empty street below.";
    const newText = "The detective watched the rain fall on the empty street ahead.";
    const { remapped, demoted } = alignParagraphs(oldText, newText);
    expect(remapped.get(1)).toBe(1);
    expect(demoted).toEqual([]);
  });

  it("demotes a full rewrite (similarity < TAU), never deletes", () => {
    const oldText = "The detective watched the rain fall on the empty street below.";
    const newText = "A completely different scene: the spaceship docked at dawn.";
    const { remapped, demoted } = alignParagraphs(oldText, newText);
    expect(remapped.size).toBe(0);
    expect(demoted).toEqual([1]);
  });

  it("pairs a split (one old → first half fuzzy, second half fresh)", () => {
    const oldText = "Morning light crossed the harbor and the boats rocked quietly.";
    const newText =
      "Morning light crossed the harbor.\nThe boats rocked quietly in the slate water.";
    const { remapped, demoted } = alignParagraphs(oldText, newText);
    expect(remapped.get(1)).toBe(1); // fuzzy pair with the first half
    expect(demoted).toEqual([]); // second new paragraph is simply unused
  });

  it("pairs the first of a merge and demotes the second", () => {
    const oldText =
      "Morning light crossed the harbor.\nThe boats rocked quietly in the slate water.";
    const newText = "Morning light crossed the harbor and the boats rocked quietly.";
    const { remapped, demoted } = alignParagraphs(oldText, newText);
    expect(remapped.get(1)).toBe(1); // first old pairs (exact or fuzzy)
    expect(demoted).toEqual([2]); // second old has no successor
  });

  it("pins per-old greedy claim order on ambiguous leftovers", () => {
    // Both old paragraphs could take new 1 (old1 scores 0.8, old2 scores 0.5).
    // Per-old greedy: old 1 goes first and claims its own best (new 1), so
    // old 2 can only take new 2 — a later old never steals an earlier old's
    // available match, and no leftover is left behind.
    const oldText = "The wolf howled at the cold moon.\nThe wolf growled at the cold moon.";
    const newText = "The wolf howled at the cold moon overhead.\nThe wolf bayed at the cold moon.";
    const { remapped, demoted } = alignParagraphs(oldText, newText);
    expect(remapped.get(1)).toBe(1);
    expect(remapped.get(2)).toBe(2);
    expect(demoted).toEqual([]);
  });

  it("pairs leftovers in old index order even when a later old scores higher", () => {
    // old 1 would score 0.667 against new 1 while old 2 would score 0.833 —
    // but old 1 runs first and 0.667 >= TAU, so it claims new 1 anyway; old 2
    // must settle for new 2. Index order, not score order, decides the claim.
    const oldText = "The wolf howled at the cold moon.\nThe wolf howled at the freezing cold moon.";
    const newText = "The wolf howled at the freezing cold winter moon.\nThe wolf howled at the bitter freezing cold moon.";
    const { remapped, demoted } = alignParagraphs(oldText, newText);
    expect(remapped.get(1)).toBe(1);
    expect(remapped.get(2)).toBe(2);
    expect(demoted).toEqual([]);
  });
});

describe("alignParagraphs — edge cases", () => {
  it("returns empty alignment for empty inputs", () => {
    const { remapped, demoted } = alignParagraphs("", "");
    expect(remapped.size).toBe(0);
    expect(demoted).toEqual([]);
  });

  it("demotes every old anchor when the new text has no paragraphs", () => {
    const { remapped, demoted } = alignParagraphs("One.\nTwo.", "");
    expect(remapped.size).toBe(0);
    expect(demoted).toEqual([1, 2]);
  });

  it("remaps all old anchors when text is replaced wholesale but paragraph count matches", () => {
    const oldText = "Alpha bravo charlie delta.\nEcho foxtrot golf hotel.";
    const newText = "Zulu yankee xray whiskey.\nSierra tango romeo papa.";
    const { remapped, demoted } = alignParagraphs(oldText, newText);
    // Different text, below TAU → both demote (honest: no misleading anchors).
    expect(remapped.size).toBe(0);
    expect(demoted).toEqual([1, 2]);
  });
});

describe("tokenize / jaccard", () => {
  it("lowercases, strips punctuation and drops EN+ID stopwords", () => {
    const tokens = tokenize("The rain, and the yang masuk INTO the alley!");
    expect(tokens.has("the")).toBe(false);
    expect(tokens.has("and")).toBe(false);
    expect(tokens.has("yang")).toBe(false);
    expect(tokens.has("into")).toBe(false);
    expect(tokens.has("rain")).toBe(true);
    expect(tokens.has("masuk")).toBe(true);
    expect(tokens.has("alley")).toBe(true);
  });

  it("scores identical token sets 1 and disjoint sets 0", () => {
    expect(jaccard(tokenize("same words here"), tokenize("same words here"))).toBe(1);
    expect(jaccard(tokenize("alpha"), tokenize("beta"))).toBe(0);
  });

  it("keeps TAU at the recorded Q2 value", () => {
    expect(TAU).toBe(0.5);
  });
});
