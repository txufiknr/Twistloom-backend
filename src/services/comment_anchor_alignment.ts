/**
 * Two-phase paragraph alignment engine for comment-anchor remapping
 * (Steps 2–3 of `docs/roadmap/READER_COMMENT_ANCHOR_DURABILITY_ROADMAP.md`).
 *
 * Pure function over two paragraph lists — no I/O, no schema. Given the
 * canonical split of a page's old and new prose, it reports where each
 * 1-based anchor should move so comments follow the paragraph the reader
 * actually discussed, and which anchors have no acceptable successor and must
 * demote to page-level (`paragraph_number = NULL` — never delete).
 *
 * Phase order is a correctness requirement, not a style choice:
 * 1. **Phase A — exact match, old index order.** Every old paragraph claims
 *    the first unused new paragraph with byte-equal text. All Phase A matches
 *    complete before Phase B starts, so a fuzzy pair can never steal a
 *    paragraph that had an exact match waiting.
 * 2. **Phase B — fuzzy pair, old index order.** Leftover old paragraphs each
 *    claim their best unused new paragraph at Jaccard ≥ {@link TAU}. Ties
 *    resolve to the lowest new index so the result is deterministic.
 * 3. **Everything else demotes.** Unmatched old anchors become demotions —
 *    the caller sets them to `NULL`, preserving content and threads.
 *
 * The heuristic's blast radius is therefore bounded: the worst case moves a
 * comment to a page-level note (weakened anchor, preserved content), never a
 * lost or deleted row.
 *
 * Bilingual note: tokenization lowercases, strips punctuation, and drops a
 * small EN+ID stopword list, because function words otherwise push full
 * rewrites past any sane threshold — Twistloom content is EN+ID by product
 * design (roadmap Q2 = option A).
 */

import { sql, type SQL } from "drizzle-orm";
import { userComments } from "../db/schema.js";
import { splitCanonicalParagraphs } from "../utils/paragraph_split.js";

/** Jaccard floor for a fuzzy pair to count as "same paragraph, edited". */
export const TAU = 0.5;

/**
 * Result of aligning an old paragraph split against a new one.
 *
 * `remapped` maps old 1-based anchor → new 1-based anchor for every old
 * paragraph that found a successor (identity entries included, so callers can
 * count unchanged anchors). `demoted` lists old anchors with no successor —
 * the caller sets those rows' `paragraph_number` to `NULL`.
 */
export type ParagraphAlignment = {
  remapped: Map<number, number>;
  demoted: number[];
};

/**
 * Function words removed before Jaccard so a full rewrite cannot score high
 * merely by reusing "the"/"and"/"yang"/"dan". Deliberately small: only words
 * that carry no topical signal in either language.
 */
const STOPWORDS = new Set<string>([
  // English
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from",
  "he", "her", "his", "i", "if", "in", "into", "is", "it", "its", "of",
  "on", "or", "our", "she", "so", "that", "the", "their", "them", "then",
  "there", "these", "they", "this", "to", "was", "we", "were", "with", "you",
  "your",
  // Indonesian
  "ada", "adalah", "atau", "dalam", "dari", "dan", "di", "dia", "ini",
  "itu", "juga", "kami", "karena", "ke", "keluar", "ketika", "kita", "lagi",
  "mereka", "pada", "satu", "saya", "seperti", "sudah", "tanpa", "telah",
  "untuk", "yang",
]);

/**
 * Tokenizes a paragraph for fuzzy comparison: lowercase word runs with
 * punctuation stripped and {@link STOPWORDS} removed.
 *
 * @param paragraph - Verbatim paragraph text (from `splitCanonicalParagraphs`).
 * @returns Unique tokens; an empty/stopword-only paragraph yields an empty set.
 */
export function tokenize(paragraph: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of paragraph.toLowerCase().matchAll(/[a-z0-9]+/g)) {
    const token = match[0];
    if (!STOPWORDS.has(token)) tokens.add(token);
  }
  return tokens;
}

/**
 * Jaccard similarity of two token sets: |A ∩ B| / |A ∪ B|.
 *
 * Two empty sets score 1 (both are, e.g., whitespace-only — indistinguishable
 * and equally worthless as a match signal, but never a rewrite). One empty set
 * scores 0.
 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

/**
 * Aligns the canonical paragraph split of [oldText] against [newText].
 *
 * @param oldText - Page prose before the edit (already-read `oldText` at the
 *   prose write site — no extra read needed).
 * @param newText - Page prose after the edit (trimmed, as committed).
 * @returns Remap + demotion sets for the writer; identical text short-circuits
 *   to an identity mapping with zero demotions at the caller.
 *
 * Deterministic: same inputs always produce the same output (Phase A in old
 * order; Phase B in old order with lowest-index tie-break), so replays and
 * tests cannot drift.
 */
export function alignParagraphs(oldText: string, newText: string): ParagraphAlignment {
  const oldParas = splitCanonicalParagraphs(oldText);
  const newParas = splitCanonicalParagraphs(newText);

  const remapped = new Map<number, number>();
  const usedNew = new Set<number>();

  // Phase A — exact matches, old order. MUST complete before Phase B.
  for (let i = 0; i < oldParas.length; i++) {
    const j = newParas.findIndex((newP, index) => !usedNew.has(index) && newP === oldParas[i]);
    if (j !== -1) {
      remapped.set(i + 1, j + 1);
      usedNew.add(j);
    }
  }

  // Phase B — fuzzy pair the leftovers, old order, best similarity first
  // (per-old greedy; ties → lowest new index). See module docs.
  const oldTokenSets = oldParas.map(tokenize);
  for (let i = 0; i < oldParas.length; i++) {
    if (remapped.has(i + 1)) continue;
    const oldTokens = oldTokenSets[i];
    let bestIndex = -1;
    let bestScore = -1;
    for (let j = 0; j < newParas.length; j++) {
      if (usedNew.has(j)) continue;
      const score = jaccard(oldTokens, tokenize(newParas[j]));
      // `> bestScore` (not `>=`) keeps the lowest index on ties; starting at
      // -1 lets a score exactly equal to TAU qualify.
      if (score >= TAU && score > bestScore) {
        bestScore = score;
        bestIndex = j;
      }
    }
    if (bestIndex !== -1) {
      remapped.set(i + 1, bestIndex + 1);
      usedNew.add(bestIndex);
    }
  }

  // Every old anchor without a successor demotes (never deletes).
  const demoted: number[] = [];
  for (let i = 1; i <= oldParas.length; i++) {
    if (!remapped.has(i)) demoted.push(i);
  }

  return { remapped, demoted };
}

/**
 * Minimal transaction surface {@link remapPageComments} needs: a single
 * `execute` of one raw statement.
 *
 * Deliberately structural rather than `DBTransaction`, so this module never
 * pulls `db/client.js` (which opens Neon pools at import time) into the pure
 * alignment unit — and so tests can hand it an in-memory SQLite adapter.
 */
export type CommentRemapExecutor = {
  execute(query: SQL): PromiseLike<{ rows: unknown[] }>;
};

/** Comment rows actually moved by a remap (counted from `RETURNING`). */
export type CommentRemapStats = {
  /** Rows kept on a paragraph anchor (their anchor changed). */
  remapped: number;
  /** Rows demoted to page-level (`paragraph_number = NULL`). */
  demoted: number;
  /** Canonical paragraph count of the prose before the edit. */
  oldParagraphCount: number;
  /** Canonical paragraph count of the prose after the edit. */
  newParagraphCount: number;
};

/**
 * Builds the single atomic `UPDATE` that re-anchors a page's comments.
 *
 * One statement is a correctness requirement, not a style preference: a
 * sequence of per-anchor `UPDATE ... SET paragraph_number = m WHERE
 * paragraph_number = n` statements cascades, because a later statement's
 * `WHERE` matches rows an earlier statement just moved. The reorder case
 * `{1→2, 2→1}` collapses every comment onto one anchor under the loop form;
 * a single `CASE` over the current row value cannot cascade because every row
 * is evaluated against its pre-statement value. Demotions carry the same
 * hazard and are folded into the same `CASE`.
 *
 * Identity mappings (`n → n`) are omitted from both the `CASE` and the `WHERE`
 * so unchanged rows are never rewritten, which also keeps `RETURNING` limited
 * to rows that actually moved.
 *
 * @param pageId - Page whose comments are re-anchored.
 * @param alignment - Phase A/B outcome for this edit.
 * @returns The statement, or `null` when nothing needs to move (pure identity
 *   edit with no demotions) — callers then skip the write entirely.
 *
 * Result contract: `RETURNING paragraph_number` yields one row per moved
 * comment; a `null` value means that comment was demoted to page-level.
 */
export function buildCommentRemapStatement(
  pageId: string,
  alignment: ParagraphAlignment,
): SQL | null {
  const remapBranches: SQL[] = [];
  const demoteBranches: SQL[] = [];
  const affectedOldAnchors = new Set<number>();

  for (const [oldAnchor, newAnchor] of [...alignment.remapped].sort(([a], [b]) => a - b)) {
    if (oldAnchor === newAnchor) continue;
    remapBranches.push(sql`WHEN ${oldAnchor} THEN ${newAnchor}`);
    affectedOldAnchors.add(oldAnchor);
  }
  for (const oldAnchor of [...alignment.demoted].sort((a, b) => a - b)) {
    demoteBranches.push(sql`WHEN ${oldAnchor} THEN NULL`);
    affectedOldAnchors.add(oldAnchor);
  }

  if (affectedOldAnchors.size === 0) return null;

  const caseBranches = [...remapBranches, ...demoteBranches];
  const anchors = [...affectedOldAnchors].sort((a, b) => a - b);

  return sql`
    UPDATE ${userComments}
       SET ${sql.identifier(userComments.paragraphNumber.name)} = CASE ${userComments.paragraphNumber}
             ${sql.join(caseBranches, sql.raw(" "))}
             ELSE ${userComments.paragraphNumber}
           END
     WHERE ${userComments.pageId} = ${pageId}
       AND ${userComments.paragraphNumber} IN ${anchors}
  RETURNING ${sql.identifier(userComments.paragraphNumber.name)}
  `;
}

/**
 * Re-anchors a page's comments to match an already-committed prose edit.
 *
 * Call inside the same transaction as the `pages.text` write, immediately
 * after it, so prose and anchors commit or roll back together. Any future
 * writer of published `pages.text` must call this too — `updatePenPageProse`
 * is today the only such writer (roadmap Step 3, single-owner invariant).
 *
 * Cache invalidation is *not* done here: it must happen after commit, so the
 * caller runs `invalidatePageOneCache(bookId)` once the transaction resolves.
 *
 * @param tx - Write transaction (structural — see {@link CommentRemapExecutor}).
 * @param pageId - The page whose prose just changed.
 * @param oldText - Prose before the edit (read before overwriting).
 * @param newText - Prose after the edit (trimmed, as committed).
 * @returns How many comment rows moved, how many demoted, and both paragraph
 *   counts for the audit log. Identical text short-circuits to zeros with no
 *   statement issued.
 * @throws Whatever the driver throws — the caller's transaction rolls back,
 *   leaving prose and anchors consistent (both old).
 */
export async function remapPageComments(
  tx: CommentRemapExecutor,
  pageId: string,
  oldText: string,
  newText: string,
): Promise<CommentRemapStats> {
  const oldParagraphCount = splitCanonicalParagraphs(oldText).length;
  const newParagraphCount = splitCanonicalParagraphs(newText).length;
  const unchanged = { remapped: 0, demoted: 0, oldParagraphCount, newParagraphCount };

  if (oldText === newText) return unchanged;

  const statement = buildCommentRemapStatement(pageId, alignParagraphs(oldText, newText));
  if (!statement) return unchanged;

  const { rows } = await tx.execute(statement);

  let remapped = 0;
  let demoted = 0;
  for (const row of rows) {
    if (typeof row !== "object" || row === null || !("paragraph_number" in row)) {
      throw new Error("remapPageComments: unexpected RETURNING row shape");
    }
    const anchor: unknown = (row as { paragraph_number: unknown }).paragraph_number;
    if (anchor === null) demoted++;
    else if (typeof anchor === "number") remapped++;
    else throw new Error("remapPageComments: unexpected RETURNING paragraph_number type");
  }

  return { remapped, demoted, oldParagraphCount, newParagraphCount };
}
