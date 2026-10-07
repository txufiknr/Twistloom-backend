/**
 * Golden-fixture harness for the canonical paragraph split (Step 1 of
 * `docs/roadmap/READER_COMMENT_ANCHOR_DURABILITY_ROADMAP.md`).
 *
 * Runs every case in `tests/fixtures/paragraph_segmentation.json` (byte-copy
 * of Flutter's `test/fixtures/paragraph_segmentation.json`, mirrored from web)
 * against `splitCanonicalParagraphs`. A failure here means the backend's
 * anchor authority has diverged from the installed web/Flutter comment base —
 * fix the split, never the fixture.
 *
 * Also covers `isAnchorInRange` (Step 4), which derives the comment-POST anchor
 * range from this same split.
 */
import { describe, expect, it } from "bun:test";
import { isAnchorInRange, splitCanonicalParagraphs } from "../src/utils/paragraph_split.js";
import fixture from "./fixtures/paragraph_segmentation.json";

type FixtureCase = { name: string; input: string; paragraphs: string[] };

const cases = fixture.cases as FixtureCase[];

describe("splitCanonicalParagraphs golden fixture", () => {
  it("loads the mirrored fixture cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(19);
  });

  for (const testCase of cases) {
    it(`matches ${testCase.name}`, () => {
      expect(splitCanonicalParagraphs(testCase.input)).toEqual(testCase.paragraphs);
    });
  }

  it("numbers segments 1-based over the returned order", () => {
    // The anchor contract: `paragraphNumber` is index + 1 into this array.
    const paragraphs = splitCanonicalParagraphs("A\n\nB\n\nC");
    expect(paragraphs).toEqual(["A", "B", "C"]);
    expect(paragraphs.map((_, i) => i + 1)).toEqual([1, 2, 3]);
  });
});

describe("isAnchorInRange (comment-POST anchor range, Step 4)", () => {
  it("accepts exactly 1..count for the current prose", () => {
    const text = "A\n\nB\n\nC";
    expect(isAnchorInRange(text, 1)).toBe(true);
    expect(isAnchorInRange(text, 3)).toBe(true);
    expect(isAnchorInRange(text, 4)).toBe(false);
  });

  it("rejects anchors at or below zero and non-integer anchors", () => {
    const text = "A\n\nB\n\nC";
    expect(isAnchorInRange(text, 0)).toBe(false);
    expect(isAnchorInRange(text, -1)).toBe(false);
    expect(isAnchorInRange(text, 2.5)).toBe(false);
    expect(isAnchorInRange(text, Number.NaN)).toBe(false);
    expect(isAnchorInRange(text, Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("rejects every anchor when the page has no paragraphs", () => {
    expect(isAnchorInRange("", 1)).toBe(false);
    expect(isAnchorInRange("", 0)).toBe(false);
    // Whitespace-only prose splits to zero segments, so no anchor exists.
    expect(isAnchorInRange("\n\n  \n\n", 1)).toBe(false);
  });

  it("ignores trailing separators when counting", () => {
    expect(isAnchorInRange("A\n\nB\n\n", 2)).toBe(true);
    expect(isAnchorInRange("A\n\nB\n\n", 3)).toBe(false);
  });

  it("agrees with the golden fixture split for every case", () => {
    for (const testCase of cases) {
      const count = testCase.paragraphs.length;
      for (let anchor = 1; anchor <= count; anchor++) {
        expect(isAnchorInRange(testCase.input, anchor)).toBe(true);
      }
      expect(isAnchorInRange(testCase.input, count + 1)).toBe(false);
    }
  });
});
