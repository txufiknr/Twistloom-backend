# Embodied Scene Continuity — Twistloom Implementation Roadmap

**Status:** ✅ Phase 1 complete (tasks 1.0–1.5 landed in `cc0a174` working tree); Phases 2–4 remain backlog
**Scope:** Fix spatial-continuity defects in AI-generated `page.text` — POV posture/position breaks, teleported camera, impossible physical sequences, ambiguous pronominal references — across the **generation + evaluation** pipeline.
**Pattern source / grounded against (files actually reviewed):**
`src/utils/prompt.ts`, `src/utils/ai-chat.ts`, `src/utils/story.ts`, `src/types/story.ts`, `src/schema/story.ts`, `src/config/book-creation.ts`, `docs/roadmap/` conventions.

---

## Status Legend

| Emoji | Meaning |
|---|---|
| ✅ | Completed |
| 🟢 | In progress |
| 🔵 | Planned (approved, next up) |
| ⚪ | Backlog (queued, not approved yet) |
| ❓ | Awaiting your decision (see §7) |
| 🔴 | Blocked |

---

## 1. At-a-Glance Summary

| # | Workstream | Status | Phase | Est. Effort | Depends on | Core change |
|---|---|---|---|---|---|---|
| 1.0 | **Static system rule** `RULES_EMBODIED_SCENE_CONTINUITY` injected via `buildFirstPageRuleSet` | ✅ | 1 | 0.5–1 h | — | Prompt-only, one insertion covers first-page, next-page, **and** evaluator (reuses `systemPrompt`) |
| 1.1 | **`text` field instructions** — next pages (`buildNextPageFieldInstructions`) | ✅ | 1 | 0.5–1 h | 1.0 (wording parity) | Prompt-only |
| 1.2 | **`text` field instructions** — first page (`firstBookFieldInstructions`) | ✅ | 1 | 0.5 h | 1.1 | Prompt-only |
| 1.3 | **Review checklist section** "Embodied Scene Continuity" (generation self-review hard gate) | ✅ | 1 | 1–2 h | 1.1 | Prompt-only, the guaranteed enforcement point |
| 1.4 | **Evaluator Option A** — strengthen COHERENCE + STEP 1.5 scene reconstruction + hard-fail triggers | ✅ | 1 | 1–2 h | 1.0 | Prompt-only |
| 1.5 | **First-book evaluator** FIRST PAGE QUALITY spatial bullets | ✅ | 1 | 0.5 h | 1.2 | Prompt-only |
| 2.0 | **Evaluator Option B** — dedicated 7th dimension `Scene & POV Continuity (0-10)` + weight rebalance | ⚪ | 2 | 1–2 h | 1.4 ✅ | Prompt-only (breakdown is free-form string array — no schema change) |
| 3.0 | **Persisted `sceneAnchor`** — AI-authored structured physical snapshot stored on page `stateDelta` | ⚪ | 3 | 6–10 h | 2.0 ✅ | Types + schema + `extractStateDelta`/`applyStateDelta` + prompt context injection (no DB migration) |
| 3.1 | **CURRENT SCENE ANCHOR context injection** — feed previous page's anchor forward | ⚪ | 3 | 2–3 h | 3.0 | Prompt context rendering |
| 3.2 | **Evaluator verifies prose against anchors** (prev + new) | ⚪ | 3 | 2–3 h | 3.0 | Evaluator prompt |
| 4.0 | **Validation & measurement** — golden-sample corpus, per-dimension eval logging, regression pass | ⚪ | 4 | 2–4 h | 1.x ✅ + chosen later | Test harness + logging |

**Phase map:**
- **Phase 1 (✅)** — Prompt-only fix, zero schema/type/DB changes. Safe, reversible, shippable immediately. **Completed.** Rules are **language-agnostic** — expressed as universal grammatical classifications (pronoun/possessive/person-marked inflection) rather than language-specific lexemes, since the pipeline supports any target language.
- **Phase 2 (⚪)** — Dedicated evaluator dimension (stronger gate, needs §7 decision on Option A→B). **Deferred** — no residual leak observed in the completed Phase-1 implementation to motivate Option B yet.
- **Phase 3 (⚪)** — Structured, persistent physical scene state (`sceneAnchor`).
- **Phase 4 (⚪)** — Proving it works: sample corpus + failure-rate telemetry.

---

## 2. Context — Why This Roadmap Exists

### 2.1 The problem (reader-visible defect)

AI-generated prose is narratively coherent at the **event level** but not the **staging level**. The model tracks *what happens next* but not *where the POV body physically is, what posture it's in, and how any movement got from A to B*.

Classic failure (`src/utils/prompt.ts` page-1 sample, Indonesian):

> "Menaburkan bubuk abu-abu ke dalam mangkuk supku." → implies MC sits at a table
> "Bagaimana dia tahu aku sudah bangun?" → implies MC was asleep
> "Aku mundur selangkah" → implies MC is standing
> "Lantai kayu tidak berderit, tapi lehernya berputar kaku ke arahku." → "lehernya" has no unambiguous owner

Each sentence is individually plausible. Together they are physically impossible. The reader's mental camera breaks.

### 2.2 The framing decision (locked)

> This is a **scene-state problem, not a prose-quality problem.**

The fix is **not** "write better prose." It is making the **physical staging continuously derivable**, and enforcing that as a distinct quality dimension:

> **Embodied Scene Continuity** — at every moment in `text`, the reader can determine: where the POV character physically is, their posture, who is in the room, where relevant objects sit relative to them, and how any movement got from A to B.

### 2.3 Where the pipeline actually routes the text

Per page, `generateNextPage`/`generateNextPages` (prompt.ts:4618/4756) → `prepareNextPageGenerationSetup` (prompt.ts:4396) produces **four** fragments that reach the AI:

| Fragment | Builder | Line | Reaches |
|---|---|---|---|
| `systemPrompt` | `buildPresetSystemPrompt('next')` | prompt.ts:4515 → 321 | Generation **+ evaluation** (evaluator reuses same `systemPrompt`, ai-chat.ts:1055) |
| `fieldInstructions` | `buildNextPageFieldInstructions` | prompt.ts:885 | Generation user prompt + echoed inside evaluator prompt (prompt.ts:1284) |
| `reviewChecklist` | `buildNextPageReviewChecklist` | prompt.ts:1160 | Generation self-review — the "REVIEW & FIX" gate (prompt.ts:4954) |
| `evaluatorPrompt` | `buildNextPageEvaluatorPrompt` | prompt.ts:1259 | Evaluation stage |

Two architectural facts drive the design:

1. **Evaluation is best-effort and non-authoritative.** If it fails, `aiPrompt` silently falls back to raw generation output (ai-chat.ts:1116-1119). The **guaranteed** gate therefore lives on the generation side (system rule + review checklist). The evaluator is a strict second pass, not the last line of defense.
2. **The evaluator inherits the generation system prompt automatically.** A static system rule reaches both consumers from a single insertion point.

### 2.4 Existing hooks (implemented in Phase 1)

| Location | Today | Coverage |
|---|---|---|
| `RULES_EMBODIED_SCENE_CONTINUITY` (prompt.ts:151) | static system rule, spliced into both `first` and `next` system prompts via `buildFirstPageRuleSet` (prompt.ts:301) | posture/orientation transitions, camera teleport, pronominal anchoring, reality-distortion carve-out |
| `buildFirstBookReviewChecklist` §5 (prompt.ts:642) | first-page self-review: "no orphaned pronoun/possessive in the target language with no clear owner" | first-page staging + referential clarity |
| Review checklist §4 "Embodied Scene Continuity" (prompt.ts:1198) | full HARD GATE section, plus §3 pipe "POV posture continuous with the previous page's ending position?" (prompt.ts:1195) | position/posture derivability, physical transitions, camera Vantage, pronoun anchoring, physically-performable |
| Evaluator COHERENCE Internal (prompt.ts:1331) + STEP 1.5 (prompt.ts:1295) | scene reconstruction before scoring + hard-fail triggers (prompt.ts:1340) | posture/teleport/POV-break failures force correction at threshold 15 |
| `firstBookFieldInstructions` (prompt.ts:3723-3724) | first-page: physical baseline early, body tracked continuously, pronouns anchored | first-page generation instructions |

---

## 3. Phase 1 — Prompt-Only Fix (✅ Complete)

**Principle (mirrors ChatGPT §14 + §11):** light constraints in generation, strict checks in evaluation. No schema/type/DB changes. Reversible in seconds.

> **Language-agnostic final wording:** all Phase-1 edits were written to be **universally grammatical** rather than tied to English or Indonesian lexemes, because the pipeline generates in any target language. Pronoun rules are expressed as grammatical classifications (subject/object forms, possessive suffixes/clitics, verb-agreement person-marking) instead of `"dia"/"nya"/"mereka"` or `"I"`, and POV rules refer to "the target language's first-person singular forms" instead of `"I"`. English sample phrases were replaced with pattern-neutral examples (e.g. "rising, stepping back").

### 3.1 Task 1.0 — Static system rule `RULES_EMBODIED_SCENE_CONTINUITY`

- **Status:** ✅ Implemented (prompt.ts:151-157)
- **Insertion:** exported const, injected via `buildFirstPageRuleSet` (prompt.ts:301).
- **Why that single insertion point:** `firstPageRules` feeds both the `first` and `next` system prompts (prompt.ts:321-330) — one line covers page 1, all next pages, and (via systemPrompt reuse) the evaluator.

Final wording (language-agnostic):

```text
EMBODIED SCENE CONTINUITY (CAMERA RULES):
- You are staging a scene the reader can only perceive through the POV character's body. Keep the physical state continuously legible.
- Before writing, know: the POV character's location, posture (standing/sitting/lying/kneeling/crouching/moving), and orientation (facing whom/what); the position and posture of every character present; the placement of objects that matter.
- Never change the POV character's location, posture, or orientation silently. Every change needs a written physical transition performed by the character (e.g. rising, stepping back) — never skip the intermediate action.
- Never teleport the narrative camera: do not describe what the POV character cannot see, hear, or infer from their fixed vantage (e.g., an expression on a face they can't see, a reaction they couldn't observe).
- Anchor every pronoun, possessive marker, and person-marked inflection in the target language (subject/object forms, possessive suffixes or clitics, verb agreement) to one unambiguous antecedent in the same or previous sentence. Re-name the owner before a body part acts; a body part always belongs to a named person, never to a nearby noun or location.
- Reality distortion is intentional in this story — but it applies to WHAT is perceived, not to how the prose stages space. Even a hallucination must be physically self-consistent within its own frame. Break logic deliberately, never accidentally.
```

**Acceptance passed:** cross-checked against `experimental` preset intent (config/book-creation.ts:272-294) — the carve-out keeps deliberate reality-breakage legal.

### 3.2 Task 1.1 — `text` field instructions (next pages)

- **Status:** ✅ Implemented (prompt.ts:890-897)
- **Insertion:** `text` block of `buildNextPageFieldInstructions` (prompt.ts:885).

Final wording (language-agnostic):

```text
  - Write in the target language's first-person singular. Never refer to the MC as "the protagonist" or "the narrator".
  ...
  - Open from the physical state the previous page ended on (where the MC is, how their body is positioned). If that baseline isn't unambiguous, establish it in the first line.
  - Track the MC's body continuously: posture and orientation never change without a written physical transition. No off-screen repositioning.
  - Keep the camera welded to the MC: show only what they can see/hear/infer. Anchor every pronoun to one clear antecedent; name the owner before a body part acts.
```

- **Cache note:** these bullets live on the semi-static cached layer (cache-order comment, prompt.ts:~5000 area). Added once, kept stable, not toggled per page.
- **Coverage note (automatic):** `candidate-generation.ts` calls `generateNextPages` (src/utils/candidate-generation.ts:498, 517), so candidate/alternative fates get the same rules for free.

### 3.3 Task 1.2 — First-page `text` field instructions

- **Status:** ✅ Implemented (prompt.ts:3721-3724)
- **Insertion:** `firstPage.text` in `firstBookFieldInstructions` (prompt.ts:3677). Page 1 is *where* body-state failures disproportionaly originate (zero baseline). Kept to 2 bullets mirroring 1.1, language-agnostic ("every pronoun and possessive marker in the target language").

### 3.4 Task 1.3 — Review checklist "Embodied Scene Continuity" (the real hard gate)

- **Status:** ✅ Implemented (prompt.ts:1198-1203) as a **mandatory** HARD GATE
- **Insertion:** `buildNextPageReviewChecklist` (prompt.ts:1160), new §4 "Embodied Scene Continuity (HARD GATE — apply to the page text)" after §3 (following sections re-numbered).

Final wording (language-agnostic):

```text
4. Embodied Scene Continuity (HARD GATE — apply to the page text)
  □ Is the POV character's physical position, posture, and orientation derivable at every moment of the page? → If NO: establish the baseline and the transitions.
  □ Does every posture/movement change have a written physical transition (sitting → standing → stepping)? → If NO: write the missing action.
  □ Does the camera ever show something the MC cannot perceive from their vantage? → If NO: rewrite from the MC's cramped, honest POV.
  □ Can every third-person pronoun and possessive anatomical reference be traced to one unambiguous owner? → If NO: replace with the explicit character name.
  □ Could a real actor physically perform this page exactly as written, in order? → If NO: fix the impossible action.
```

Plus one pipe in §3 (prompt.ts:1195): *"Is the POV character's posture continuous with the previous page's ending position? → If NO: fix the transition."*

**Why this is the #1 enforcement point:** the checklist runs inside the generator's mandatory "REVIEW & FIX" self-check **before** JSON is emitted (prompt.ts:4954-4957) — it can prevent a spatial bug from leaving. The evaluator can only repair or (silently) fail.

### 3.5 Task 1.4 — Evaluator Option A (buildNextPageEvaluatorPrompt)

- **Status:** ✅ Implemented (Option A). **Q1 decided: Option A executed; Option B deferred** until residual spatial failures appear (see §4).
- **Insertion:** `buildNextPageEvaluatorPrompt` (prompt.ts:1259).

**STEP 1.5 — scene reconstruction** (inserted after STEP 1, prompt.ts:1292-1295). Deepest technique from the design: evaluator rebuilds the stage before scoring.

```text
STEP 1.5 — RECONSTRUCT THE SCENE BEFORE SCORING
Silently rebuild the physical staging from the page text alone:
  - POV character: location, posture, orientation, what they can actually see/hear.
  - Every character present: position, posture, relative to the MC.
  - Key objects: where they are vs. the MC.
Then verify: can the prose be executed by real bodies in real space without inventing unstated movement, and without revealing anything the MC cannot perceive?
```

**COHERENCE Internal** (prompt.ts:1331-1337) — deduct + hard-fail clauses (language-agnostic pass):

```text
2. COHERENCE (0-20) — Threshold: 15
   Internal (0-10): Page makes logical sense on its own. No contradictory actions or unwritten scene breaks.
   Deduct heavily for:
   - POV posture/location change without a written physical transition (e.g. asleep → steps backward).
   - The reader unable to determine the MC's physical position at any point.
   - The narrative camera describing what the MC cannot see/hear/infer.
   - Pronouns, possessives, or body parts with no unambiguous owner in the target language (an "orphaned" person-marked form).
   HARD FAILURES (force correction even if total ≥ 75):
   - Impossible physical sequence (posture contradiction, teleport, off-screen movement).
   - POV break — the camera left the MC.
```

### 3.6 Task 1.5 — First-book evaluator spatial bullets

- **Status:** ✅ Implemented (prompt.ts:1452 `buildFirstBookEvaluatorPrompt`)
- **Insertion:** FIRST PAGE QUALITY dimension (prompt.ts:1523-1530). Added: *"MC's physical baseline (position, posture, what's within reach) established — the reader can orient immediately"* as an award bullet, and *"POV posture/position ambiguous or physically impossible (teleported camera, posture contradiction, pronoun with no unambiguous owner)"* as a deduct bullet.

### 3.7 Phase 1 exit criteria

- ✅ Indonesian sample page regenerates without the four failure modes in §2.1 — the pronoun rule is now **universal** (any target language), so the referential-ambiguity mode is covered regardless of the surface language.
- ⬜ A 5-10 page English + Indonesian smoke book shows no new "Kala berdiri. Kala menghadap meja…" robot-style regression (Layer 0+1 must stay light) — **not yet run**; prompts kept light and craft-oriented to minimize this risk.
- ✅ `bun typecheck` + `bun lint` pass (tasks 1.0-1.5 touch prompt strings only).

---

## 4. Phase 2 — Evaluator Option B (Dedicated Dimension)

- **Status:** ⚪ (deferred — do only if Phase 1 leaks; see §7-Q1)
- **Rationale from design:** an overall 90/100 must never hide a posture contradiction. A dedicated dimension + per-dimension threshold = structural hard gate, not a soft taste call.
- **Change is prompt-only** — `AIJsonScoreBreakdown` is `{ dimension: string, score: number }[]` (schema/story.ts:710), so the evaluator's free-form `breakdown` arrays accept a 7th entry with zero schema change.

Proposed weights (`buildNextPageEvaluatorPrompt` scoring rubric, prompt.ts:1302-1390 + OUTPUT FORMAT breakdown arrays at prompt.ts:1414-1438):

| Dimension | Before | After | Threshold |
|---|---|---|---|
| Tension | 25 | 25 | 18/20/22 |
| Coherence | 20 | **15** | 15 → **11** |
| Style | 15 | 15 | 11 |
| Progression | 20 | **15** | 14 → **11** |
| Illusion | 10 | 10 | 7/8 |
| Consistency | 10 | 10 | 7 |
| **Scene & POV Continuity** | — | **10** | **8** |
| **Total** | 100 | 100 | pass ≥ 75 |

- Existing "or if any single dimension scores below its threshold" trigger (prompt.ts:1306) makes SCENE & POV a hard gate automatically; keep the 3.5 hard-fail wording as belt-and-suspenders.
- The `scoreBefore`/`scoreAfter` breakdown JSON arrays in OUTPUT FORMAT must list the 7 dimension names.

---

## 5. Phase 3 — Persisted `sceneAnchor` (Structured Scene State)

- **Status:** ⚪ (bigger win; schema + types + state-delta work)
- **Goal:** stop *implying* physical state and start *carrying* it, matching Twistloom's state-driven architecture (the "SCENE STATE → GENERATION → PROSE → RECONSTRUCTION → EVALUATOR" loop from the design).

### 5.1 Task 3.0 — AI-authored `sceneAnchor` (end-of-page physical snapshot)

```typescript
interface SceneAnchor {
  location: string;          // placeId ("unknown" if ambiguous)
  mcPosture: string;         // standing | sitting | lying | kneeling | crouching | moving
  mcOrientation?: string;    // facing whom/what
  characters?: { characterId: string; position: string; posture: string }[];
  objects?: { name: string; position: string }[];   // only plot-relevant
}
```

**Touch points:**
| File | Change |
|---|---|
| `types/story.ts` | new `SceneAnchor` type; optional on `StoryPageGeneration` (1321) |
| `schema/story.ts` | `sceneAnchor` property in `STORY_PAGE_GENERATION_SCHEMA` (675); candidates inherit automatically (690) |
| `utils/prompt.ts` | `nextPageOutputFormat` (627) + field instruction for `sceneAnchor` |

**Persistence — no DB migration:** store the full snapshot on each page's existing `stateDelta` jsonb, same full-snapshot contract as `sanityState`:
| File | Change |
|---|---|
| `utils/story.ts` `extractStateDelta` (284) | add `sceneAnchor: generation.sceneAnchor` |
| `utils/story.ts` `applyStateDelta` | apply `sceneAnchor` onto `StoryState` |
| `types/story.ts` `StateDelta` | optional `sceneAnchor` |
| `types/story.ts` `StoryState` (1493) | optional `sceneAnchor` (carried baseline for future pages) |

> Recovery path is automatic: `reconstructStoryState` / delta-chain replay reads `stateDelta.sceneAnchor` exactly like the other delta fields.

### 5.2 Task 3.1 — CURRENT SCENE ANCHOR context injection

- **Insertion:** `formatPreviousPageEntry` (prompt.ts:1643) renders `previousPage.stateDelta.sceneAnchor` as:

```text
  → Scene anchor: standing, adrift behind Ibu Ratih (facing away); soup bowl on table at MC's left
```

- And `formatNextPageStoryContextPrompt` (prompt.ts:2898) gets a "CURRENT SCENE ANCHOR" block so the writer starts from an explicit physical baseline instead of inferring it from prose.

### 5.3 Task 3.2 — Evaluator verifies against anchors

- In STEP 1.5 (from Task 1.4), replace "reconstruct from text alone" with **"reconcile the prose against the PREVIOUS page's known anchor"** — no unstated movement allowed except the current page's written transitions. Optionally cross-check the newly generated `sceneAnchor` self-consistency (does the page actually end where the anchor says it does?).

### 5.4 Phase 3 risks

- **Token/cost:** `sceneAnchor` adds ~30-80 tokens/page of output. Acceptable; it also *reduces* ambiguity-driven regeneration.
- **Schema weight:** keep `objects`/fields minimal (see §7-Q3) so it never stresses Gemini's constrained decoder (see `isSchemaTooComplex`, ai-chat.ts:1189).
- **Distortion scenes:** anchor should be allowed to be "undefined"/dissonant during deliberate reality-break pages (§7-Q4).

---

## 6. Phase 4 — Validation & Measurement

- **Status:** ⚪

### 6.1 Golden-sample corpus (acceptance tests)

| Case | Must catch/allow |
|---|---|
| Indonesian page (§2.1) | posture contradiction, camera teleport, "lehernya" ambiguity → revised/flagged |
| Deliberate hallucination page | allowed (content distortion) but staging stays legible |
| `experimental` preset | deliberate space-breaks allowed only with in-text signaling |
| Finale page | cast claustrophobia + staging still derivable |
| Candidate/alt-fate multiverse pages | same continuity within each fate |

### 6.2 Failure-rate telemetry (near-zero extra work)

The evaluation result is already logged with `scoreBefore`/`scoreAfter` breakdowns (`edgeGroup.wrap`, ai-chat.ts:1082). Once a `sceneContinuity` dimension exists (Option B), that log line *is* the telemetry — grep/aggregate `"dimension":"sceneContinuity"` scores to measure spatial-failure rate per provider/model and regression over time. Until then, COHERENCE hard-fail triggers (`buildNextPageEvaluatorPrompt`, prompt.ts:1340-1342) generate `issues`/`fixes` entries that grep can approximate as a pre-telemetry substitute.

---

## 7. Open Questions — Need Your Decision

> Each question: context → options → **my recommendation**. Phase-1 scope decisions are now **decided** (✅) — the recommendations below were followed during implementation. Phase 2–3 questions remain open for future phases.

### Q1. Evaluator gate: Option A (strengthen COHERENCE) vs Option B (dedicated dimension) — now vs later?

- **Decision: ✅ Option A implemented; Option B deferred** to Phase 2 (only if residual spatial failures appear).
- **Context:** Option A is lighter-touch but hides spatial issues inside the COHERENCE bucket; Option B structurally enforces them via a per-dimension threshold and breaks out into telemetry (true per-ChatGPT "hard failure over weighted average").
- **Options:**
  1. A now, B only if leaks persist.
  2. A and B together in Phase 1 (bigger single prompt diff).
  3. B only (skip A).
- **Recommendation (followed):** **Option A now, promote to B if Phase-1 exit tests show residual spatial failures.** A zero-rebalance, low-risk first step; B is a pure-prompt promotion later (no architectural debt). Do **not** skip A — STEP 1.5 scene reconstruction is the highest-value single technique and belongs in both.

### Q2. Phase 3 persistence: full-snapshot on `stateDelta` vs first-class `StoryState` column?

- **Options:**
  1. Full snapshot on existing `stateDelta` jsonb (like `sanityState`) — no migration, reconstruction contract proven.
  2. New dedicated DB column / table — queryable, but migration + populate path for every book.
- **Recommendation:** **Option 1.** Zero-migration, reuses the exact reconstruction pattern `sanityState` already uses (see StateDelta JSDoc, types/story.ts:1221). Queryability isn't needed for this feature.

### Q3. `sceneAnchor` detail level — minimal vs full blocking?

- **Context:** richer anchors (orientation, object placements) give the evaluator more to verify against, but inflate output tokens and schema weight.
- **Recommendation:** **Minimal first:** `mcPosture` + `mcOrientation` + per-present-character `position`/`posture`, plus plot-relevant `objects` **only when they matter**. Skip absolute coordinates entirely. Extend later if evaluation checks need it. Also keep the field **optional** (Q4's distortion carve-out needs it).

### Q4. How strictly do the camera rules apply to `experimental` preset / reality-break pages?

- **Decision: ✅ Option 1 adopted in `RULES_EMBODIED_SCENE_CONTINUITY`** (prompt.ts:151-157).
- **Context:** the whole engine rests on unreliable narration, memory corruption, composure crashes, and the `experimental` preset (config/book-creation.ts:272-294). Blanket camera rules could fight the story's core.
- **Options:**
  1. "Legibility always, content distortion allowed" (Task 1.0 wording).
  2. Exempt `experimental` entirely.
- **Recommendation (followed):** **Option 1.** Readers should be able to doubt *what is real* — never *what physically happened*. Allow deliberate spatial fractures only when signaled in-text ("the walls rearranged"). This preserves every preset and the existing COHERENCE distortion note (prompt.ts:1339).

### Q5. Is the §3.5 checklist a *mandatory* gate or advisory?

- **Decision: ✅ Mandatory wording implemented** (prompt.ts:1198 "HARD GATE"; the self-check intro at prompt.ts:4957 reads "Treat every requirement below as mandatory").
- **Context:** the checklist text says "Treat every requirement below as mandatory" (prompt.ts:4957), but compliance is model self-reported — no deterministic backend check can catch prose-level spatial breaks reliably.
- **Options:**
  1. Wording as mandatory, plus Option B telemetry to audit compliance rate.
  2. Advisory only.
- **Recommendation (followed):** **Mandatory wording + telemetry, no deterministic regex check.** Regex on free-form prose = false-positive machines. The fix is pressure + measurement, not deterministic parsing.

### Q6. Does the offline/pen engine (`src/services/pen.ts`) need the same rules?

- **Status: ⚪ not yet verified** (Q6 carried forward).
- **Context:** `pen.ts:976` documents "the `generateNextPage` path minus the AI call", and continues continuity pages via "single-page engine path (mirrors generateNextPage)". If it reuses `buildNextPageFieldInstructions` + the system prompt, it inherits everything for free; if it builds its own prompts, it won't.
- **Recommendation:** **Verify coverage when implementing; add the static rule to any pen-specific prompt builder if it constructs its own.** Cheap check (~10 min), prevents silent regression on the narration-formatting path.

### Q7. Page-1 (book creation) treatment — full effort or light?

- **Decision: ✅ Option 1 fully implemented** — static rule (prompt.ts:151) reaches first-page generation + evaluation, Task 1.2 bullets in `firstBookFieldInstructions` (prompt.ts:3721-3724), and Task 1.5 evaluator bullets (prompt.ts:1523-1530).
- **Context:** page 1 is where body-state failures originate (zero baseline), but the first-page pipeline (book init) is transient content (only 1 page) and its field instructions are longer/denser.
- **Options:**
  1. Full parity: Task 1.0 static rule (covers it) + Task 1.2 field bullets + Task 1.5 evaluator bullets.
  2. Static rule only (covers generation + evaluation wording implicitly).
- **Recommendation (followed):** **Option 1.** Cost is ~1h of prompt text; the static rule already reaches it, and 1.2 + 1.5 are a few bullets each. First impressions matter — the ChatGPT analysis rated "POV physical position unclear" as 🔴 Critical on exactly a page-1 example.

---

## 8. Files to Touch (Reference)

| File | Tasks | Notes |
|---|---|---|
| `src/utils/prompt.ts` | 1.0 ✅, 1.1 ✅, 1.2 ✅, 1.3 ✅, 1.4 ✅, 1.5 ✅; 2.0, 3.0/3.1/3.2 (formatting) | Bulk of the work |
| `src/utils/ai-chat.ts` | none (verification only) | evaluator reuses `systemPrompt` at :1055, logs breakdowns at :1082, fallback at :1116-1119 |
| `src/utils/story.ts` | 3.0 (`extractStateDelta`, `applyStateDelta`) | Phase 3 only |
| `src/types/story.ts` | 3.0 (`SceneAnchor`, `StateDelta`, `StoryState`) | Phase 3 only |
| `src/schema/story.ts` | 3.0 (`STORY_PAGE_GENERATION_SCHEMA`) | Phase 3 only |
| `src/config/book-creation.ts` | none | reference only (preset distortion carve-out) |
| `src/services/pen.ts` | 6.0 (verify) | Q6 — still open |

**Deliberately NOT changed:** DB schema (no migrations), evaluation schema (`buildEvaluationSchemaDefinition` — breakdown is free-form), AI provider/fallback code.

---

## 9. Risks & Trade-offs (from the design, kept alive)

1. **Robotic prose** — over-stuffing the *generation* prompts yields "Kala berdiri. Kala menghadap meja…". Mitigation: Light in generation (system rule + field bullets stay short and craft-oriented), strict in evaluation (checklist + evaluator). Phase-1 wording was deliberately kept light; **smoke-book regression check (§3.7) still pending.**
2. **Fighting the unreliable narrator** — mitigation: carve-out in the system rule (§7-Q4, Option 1 — adopted).
3. **Evaluator fallback masks the gate** — the evaluator is non-authoritative (ai-chat.ts:1116-1119). Mitigation: enforce on the generation side (checklist is the real gate), treat evaluator as the lift.
4. **Weighted-average blindness** — an overall 90/100 hiding a posture break. Mitigation: hard-fail triggers (Phase 1, implemented) + dedicated dimension threshold (Phase 2, deferred).
5. **Prompt-cache churn** — mitigation: keep additions static on the semi-static cached layer, no per-page toggling (see cache-order comment, prompt.ts:~5000 area).
6. **Token/cost** — evaluator reconstruction + 7th dimension add small per-call overhead; Phase 3 anchors add ~30-80 output tokens/page. Acceptable, and they reduce ambiguity-driven regenerations.

---

## 10. Suggested Execution Order

```text
[x] Q decisions (§7)  ── resolved: Q1 (Option A), Q4 (Option 1), Q5 (mandatory), Q7 (full parity); Q2/Q3 deferred to Phase 3; Q6 open
[x] 1.0  static system rule            (0.5-1 h)   ✅ done
[x] 1.1  next-text field instructions  (0.5-1 h)   ✅ done
[x] 1.2  first-page field instructions (0.5 h)     ✅ done
[x] 1.3  checklist HARD GATE section   (1-2 h)     ✅ done (real enforcement)
[x] 1.4  evaluator STEP 1.5 + COHERENCE (1-2 h)   ✅ done
[x] 1.5  first-book evaluator bullets  (0.5 h)     ✅ done
[ ] Phase 1 exit tests (§3.7) + Q6 pen-engine check   ← next step
[ ] 2.0  Option B dimension (only if leaks)     (1-2 h)
[ ] 3.0-3.2  sceneAnchor persistence + context  (6-10+ h)
[ ] 4.0  golden corpus + telemetry drill        (2-4 h)
```

---

## 11. Conclusion

Twistloom already treats narrative consistency as **structured state**, not prose history — `placeId`, time, weather, composure, trauma tags, future-note scheduling. "Where is everyone, physically, right now?" is the one axis the state model doesn't yet carry, and it's exactly the axis that generates the immersion-breaking failures readers notice most.

**Phase 1 is complete.** The fix shipped through prompt engineering alone (system rule → field instructions → checklist gate → strict evaluator), reversible and safe, and was **language-agnosticized** so every target language benefits from the same universal grammatical rules. Phases 2-3 harden it first into a dedicated scored dimension, then into persisted per-page physical state with an explicit forward-fed anchor and evaluator verification against it. Phase 4 proves the improvement with a golden corpus and per-dimension failure telemetry.

The moment a reader stops asking "wait… where is the character?" is the moment this roadmap is done.