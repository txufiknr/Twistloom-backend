# Genre Detection — Accuracy Test Report

**Scope:** `genre-detection.ts` (heuristic keyword→genre classifier for Twistloom)
**Method:** two independent fixture sets, ground-truthed by hand (not by running the detector and copying its output), run through three loop iterations of measure → fix → re-measure.

---

## 1. Summary

| | Before this pass (v0) | After this pass (final) |
|---|---|---|
| **Keyword/tag fixtures** (the documented, intended input) | 106/118 (89.8%) | **118/118 (100.0%)** |
| **Theme-prompt fixtures**, whole sentence as one keyword | 11/49 (22.4%) | 11/49 (22.4%) *(unchanged — architectural limit, not a vocabulary gap; see §4.1)* |
| **Theme-prompt fixtures**, naive word-split | 31/49 (63.3%) | **40/49 (81.6%)** |
| **Theme-prompt fixtures**, 1–3 word n-gram extraction | 38/49 (77.6%) | **42/49 (85.7%)** |

v0 here is last turn's already-bug-fixed `genre-detection.ts` (the exact-vs-bounded match-ordering fix). This pass found no further *code* bugs — every gap closed this time was a **keyword-coverage gap** (common vocabulary a human would recognize as genre-signaling that simply wasn't in `GENRE_KEYWORD_MAP` yet), found by throwing realistic content at it rather than only the words already in the map.

33 new keyword patterns were added (mostly missing plurals, plus a small set of clearly-justified new vocabulary). Full list in the Appendix. Zero existing behavior changed — every v0-passing case still passes.

---

## 2. Methodology

### 2.1 Two fixture sets, testing two different things

- **`KEYWORD_FIXTURES` (118 cases)** — curated tag/keyword arrays, the actual documented input (`detectGenre`'s own docs say it's "best suited to controlled tags/keywords"). This is the real accuracy target. Categories: `pure` (single-genre tag sets, 60), `hybrid` (realistic multi-genre tag sets with an acceptable-answer *set*, 10), `general` (legitimately non-genre content, 8), `false-positive-trap` (words that share letters with a pattern but are unrelated in meaning — "workspace," "dragonfly," "orchestra," "Crimea," etc. — 14), `normalization` (case/whitespace/separator/Unicode variants, 10), `i18n` (Indonesian aliases, 10), `regression` (the exact-match-ordering fix from last turn, re-verified through the public API, 6).

- **`PROMPT_FIXTURES` (49 cases)** — full-sentence story premises, the kind of free text a "describe your story" field would actually collect. `detectGenre` is explicit that this isn't its intended input; this set measures exactly how much that costs, across three ways a caller might feed prose in (§2.2), so the numbers double as integration guidance rather than a target that was tuned against.

**Ground truth** for both sets was assigned by independent judgment of what a reasonable cataloger would label the item — never by running the detector first and copying its answer. That independence is what makes the accuracy numbers meaningful.

For `hybrid` cases, ground truth is a *set* of acceptable genres (e.g. a haunted-spaceship premise accepts `scifi` or `horror`) rather than one fixed answer, since real hybrid stories don't have a single objectively correct primary genre.

### 2.2 Three ways to feed prose into a keyword-based detector

`detectGenre(keywords)` only accepts an array of strings. There are three plausible ways to turn a theme-prompt sentence into that array, each tested separately (`text-to-keywords.ts`):

| Strategy | What it does |
|---|---|
| `whole-blob` | Passes the entire sentence as one array element. |
| `word-split` | Splits on whitespace/punctuation into individual word-keywords. |
| `ngram-1-3` | Sliding window of 1-, 2-, and 3-word phrases, hyphenated, all passed as separate candidates. |

### 2.3 The loop

1. **v0** — last turn's already-fixed baseline. Run both fixture sets → measure.
2. **v1** — added the vocabulary gaps `v0`'s failures made obvious (mostly missing plurals) → re-measure.
3. **v2 (final)** — one more small, targeted round from the remaining prompt-fixture failures (`hack`/`hacker`/`hacking`/Indonesian `peretas`) → re-measure. Stopped here; see §5 for why the remaining gaps were left alone on purpose.

---

## 3. Keyword fixtures — results

**106/118 → 118/118.** All 12 failures were coverage gaps, not bugs — words a human would obviously associate with a genre that the map simply didn't have yet. Examples, isolated as clean two-word fixtures (a corroborating medium-tier word plus the missing term, so the fixture tests the term itself rather than accidentally piggybacking on something already covered):

| Fixture | Keywords | Expected | v0 result | Root cause |
|---|---|---|---|---|
| `probe-01` | `["orcs", "mythology"]` | fantasy | general | only singular `orc` was listed |
| `probe-03` | `["cyborgs", "dystopian"]` | scifi | general | only singular `cyborg` was listed |
| `probe-07` | `["demonic"]` | horror | general | only the noun `demon`/`demons` was listed, not the adjective |
| `probe-09` | `["murder"]` | thriller | general | `murder` — an extremely common thriller word — was absent entirely |
| `probe-10` | `["hitman", "heist"]` | thriller | general | `hitman`/`hitmen` was absent entirely |

**Fix:** 33 new patterns added (full list in the Appendix), split into two kinds:

- **Missing plural forms of already-listed singulars** (e.g. `orc`→`orcs`, `cyborg`→`cyborgs`, `zombie`→`zombies`, `detective`→`detectives`) — the bulk of the additions, mechanical and essentially risk-free since the singular form's tier and behavior already existed and was already accepted.
- **A small set of new, clearly-justified vocabulary** (`demonic`, `murder`/`murders`, `hitman`/`hitmen`, `hack`/`hacker`/`hacking`, `killer`/`killers`, `asylum`, `wasteland`, and a few more) surfaced directly by real fixture failures, not guessed speculatively.

**Every new addition was checked for false-positive risk before being added**, and four of them were deliberately kept at a *lower* tier than their obvious sibling term specifically because they're lexically ambiguous:

| Word(s) added | Tier used | Why not higher |
|---|---|---|
| `asylum` | horror, **medium** | Also means political/refugee asylum — a serious, unrelated drama subject. At medium (score 2), it can help *confirm* a haunted-asylum premise alongside other evidence, but can never by itself mislabel an asylum-seeker story as horror. |
| `hack` / `hacker` / `hacking` | scifi, **medium** | Also "life hacking," a "hacking cough." Same reasoning. |
| `wasteland` | scifi, **medium** | Also the literary/metaphorical sense ("a cultural wasteland," T.S. Eliot). Same reasoning. |
| `killer` / `killers` | thriller, **medium** | Also "killer app," "killer deal." Same reasoning. |

`MIN_GENRE_SCORE` is 3, and medium alone scores 2 — so none of these four can single-handedly classify anything; they only tip the balance when real corroborating evidence is also present. This was verified directly: `["asylum"]`, `["hacking"]`, `["killer"]`, and `["wasteland"]` alone all still correctly resolve to `general` (see `probe-13`–`probe-16` in `fixtures.ts` and the corresponding tests).

**Deliberately not touched:** existing tier assignments. `wizard` sits at `low` while the equally-strong `dragon`/`magic` sit at `high` — an inconsistency in the original map, not something introduced here. Rebalancing existing tiers is riskier than adding new patterns (it changes already-relied-upon scoring for every existing tag, not just new ones) and wasn't something the fixture failures actually required, so it was left alone. Worth a look if you want to revisit it separately.

---

## 4. Theme-prompt fixtures — results (stress test, not the intended use case)

| Strategy | v0 | v1 | Final |
|---|---|---|---|
| `whole-blob` | 22.4% | 22.4% | 22.4% |
| `word-split` | 63.3% | 79.6% | **81.6%** |
| `ngram-1-3` | 77.6% | 83.7% | **85.7%** |

### 4.1 Why `whole-blob` is stuck at 22.4% — and it's not a vocabulary problem

This was the most useful thing this pass found. Feeding a whole sentence as **one** keyword still works mechanically — `normalizeGenreKeyword` turns every space into a hyphen, so a sentence becomes one long compound token, and the bounded-match check still correctly finds real genre words inside it. The problem is upstream of matching: `detectGenre` sums `scoreKeywordForGenre(keyword, genre)` **once per array element**, and `scoreKeywordForGenre` returns only the *single strongest tier match* found for that one element. If a sentence contains five different fantasy-relevant words, but they're all part of the same one array element, that element still only ever contributes the score of its *single best* match — never the sum of all five.

Concretely: `"A young blacksmith discovers she can speak to dragons... a forgotten kingdom."` contains both `dragons` (high tier, bounded, worth 2) and `kingdom` (low tier, bounded, worth 1) — but because both are inside the *same* keyword string, `detectGenre` only ever sees the best one (2), never `2 + 1 = 3`. Two points falls short of `MIN_GENRE_SCORE` (3), so it resolves to `general` even though a human reading the same sentence would immediately say "fantasy."

**Takeaway:** the "quantity of evidence" scoring model this file is built around only works *across separate array elements*. Cramming a whole description into one string forfeits it entirely — this isn't a bug, it's a direct consequence of the documented per-keyword scoring model, but it's a genuinely non-obvious cost if you don't already know to look for it.

### 4.2 `ngram-1-3`'s accuracy comes with an asterisk

`ngram-1-3` scores higher than `word-split`, but part of *why* is a real risk, not a pure win: sliding windows overlap, so the same word can be counted multiple times — once as its own 1-gram, again as part of two different 2-grams, again as part of up to three 3-grams. `Set`-based dedup doesn't catch this, because `"family"`, `"a-family"`, `"the-family"`, and `"family-slowly"` are four different normalized strings.

This produced one confirmed false positive in the fixture set: `p-trap-03`, a sentence about a touring orchestra ("...before the annexation of Crimea...") that happens to also contain the word **"historical."** `historical` alone is a genuine drama-medium keyword (score 2) — correctly not enough on its own. But under `ngram-1-3`, the overlapping windows (`"a-historical"`, `"historical-account"`, etc.) each contribute their own bounded-match points for the same single word, pushing the total to 3+ and misclassifying the whole thing as `drama`. This is captured as an explicit, documented "known limitation" test in `genre-detection.test.ts` rather than left to fail silently — see the test named `[ngram-1-3] KNOWN LIMITATION`.

It's also part of why `ngram-1-3`'s i18n number improved (5/6 vs. word-split's 4/6): the same overlap mechanism that caused the false positive above also happened to help the Indonesian `peretas` ("hacker") case cross the threshold — correct outcome, same double-edged mechanism.

**Recommendation if you ever do want to mine keywords from free text:** don't reach for full 1–3-gram extraction as a general-purpose solution — the overlap risk is real. `word-split` (single words only) has no overlap risk at all and is the safer default; if you specifically want to catch the map's few 2-word explicit compounds ("space opera," "high fantasy"), extract 2-grams *in addition to* 1-grams, but stop there — don't go to 3-grams for general-purpose extraction (the one 3-word-only pattern in the whole map, `sword-and-sorcery`, isn't worth the added overlap risk of full 3-gram windows).

### 4.3 What wasn't fixed, and why

A number of `word-split`/`ngram-1-3` failures remain, and they were deliberately left alone rather than chased with more keyword additions:

- **Atmosphere-only premises** — e.g. *"...a woman starts hearing whispers from the walls at night, and soon realizes the house was never truly empty"* conveys horror entirely through implication, using zero words this (or any reasonably-scoped) keyword map would contain. Adding words like "whispers," "empty," or "walls" as horror signals would create far more false positives elsewhere than premises correctly caught.
- **Single weak-signal premises** — e.g. a coming-of-age summer romance whose only matching word is `love` (low tier, score 1). Requiring more than one weak signal before classifying is the system's own conservative design, working as intended, not a gap.

Chasing 100% on free text isn't the right target for a heuristic explicitly documented as built for controlled tags — doing so would mean adding progressively more generic, ambiguous words to the map, which raises false-positive risk on the *real*, intended use case for a benefit that only ever helps a usage pattern the code was never meant to support.

---

## 5. Files delivered

- **`genre-detection.ts`** — updated drop-in. All JSDoc intact and refined; 33 new keyword patterns; no structural or scoring-logic changes (that fix was last turn).
- **`genre-detection.test.ts`** — `node:test` suite, zero dependencies. Keyword fixtures are hard pass/fail (100% required); prompt fixtures are accuracy-floor checks per strategy, set with real margin below the measured baseline so they catch a genuine regression without being flaky over routine fixture edits; explicit regression tests for last turn's exact-match-ordering fix; defensive/malformed-input tests (`null`, non-string entries, 5,000-element arrays); `buildGenreContextBlock` smoke tests.
- **`fixtures.ts`** — the 118 keyword fixtures and 49 prompt fixtures described above, with rationale in each `description` field.
- **`text-to-keywords.ts`** — the three prose-extraction strategies from §2.2.
- **`measure.ts`** — standalone script (not part of the pass/fail suite) that runs everything and prints/exports the full accuracy breakdown — rerun this after any future `GENRE_KEYWORD_MAP` change to see the effect directly, the same way this report was produced.

### How to run

```bash
# Test suite (Node 22.6+; drop the flag entirely on Node 23.6+/24+)
node --experimental-strip-types --test genre-detection.test.ts

# Or, if tsx is already in the project:
npx tsx --test genre-detection.test.ts

# Accuracy report (regenerates the numbers in this document)
node --experimental-strip-types measure.ts ./genre-detection.ts
```

All imports use explicit `.ts` extensions (`from './genre-detection.ts'`), which is what Node's native TypeScript support requires — this is also valid under TypeScript 5.5+'s `allowImportingTsExtensions` and under `tsx`, so it should drop in cleanly regardless of which of the three run paths above you use.

---

## Appendix: every new keyword pattern added this pass

```
fantasy  medium: quests
fantasy  low:    kingdoms, wizards, orcs

scifi    medium: androids, hack, hacker, hacking, peretas (ID), wasteland
scifi    low:    implants, spaceships, lasers, cyborgs

horror   high:   demonic
horror   medium: zombies, vampires, asylum
horror   low:    nightmares

thriller high:   detectives, murder, murders, hitman, hitmen
thriller medium: spies, heists, killer, killers
thriller low:    secrets, clues, alibis

drama    medium: relationships
drama    low:    betrayals
```

33 patterns total. Every one added at the same tier as its already-accepted sibling term (plural next to singular, adjective next to noun), except the four ambiguous words noted in §3, which were deliberately placed one tier below where their meaning alone might suggest, specifically to keep them from being able to single-handedly misclassify content.
