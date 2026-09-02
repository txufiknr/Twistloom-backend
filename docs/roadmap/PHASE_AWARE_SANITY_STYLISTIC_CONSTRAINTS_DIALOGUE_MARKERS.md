# Phase-Aware Sanity, Stylistic Constraints & Gamified Dialogue Enhancement

**Status:** Implemented — backend generation contract, schema, DB persistence, and prompt-caching hardening complete (2026-09-02). Frontend rendering in progress. See [Implementation Notes](#implementation-notes).
**Created:** 2026-09-01 · **Last updated:** 2026-09-02
**Scope:** `src/utils/prompt.ts`, `src/utils/story.ts`, `src/config/story.ts`, `src/types/story.ts`, `src/types/book.ts` (read-only, verified), `src/utils/field-instructions.ts`, `src/utils/characters.ts`, `src/utils/page-validation.ts`, `src/schema/story.ts`, `src/schema/db.ts` (Drizzle `pages` table), `src/services/book.ts` (page mappers), `src/utils/narrative-style.ts` (read-only, verified), `src/utils/player-profile.ts` (read-only, verified), new `src/utils/localized-style.ts`, new `src/utils/dialogue-parser.ts` · frontend: `reader-store.ts`, `SettingsModal.tsx`, new `dialogue-parser` (client), `StoryText.tsx` (pending), `ReaderPageClient.tsx` (pending)
**Priority:** High — affects narrative quality and reader-facing rendering across all stories

---

## Implementation Notes

### Round 1 (2026-09-01) — backend generation contract
- Phase-scaled composure decay (`SANITY_PHASE_DECAY_MULTIPLIER`) + phase floors (`SANITY_EARLY_PHASE_FLOOR`=30 hard, `SANITY_MID_PHASE_FLOOR`=15 lifted only once `traumaTags.length >= SANITY_MID_PHASE_EARNED_CRASH_TRAUMA`=3) — extends this doc's flat-multiplier proposal with an earned-crash gate, since a multiplier alone makes a MID crash *less common*, not genuinely *rare*.
- Phase-aware `formatSanityState`; enriched `storyPhases` (types/story.ts) with narrative beats (EARLY: relief/allies; MID: earned power-ups/weapons, shifting alliances; LATE: collapse possible) — kept out of `formatSanityState` to preserve the composure/narrative-goal separation this doc's own analysis established.
- `RULES_DIALOGUE_ATTRIBUTION`, `[character_id]`/`[mc]`/`[???]` markers, `utils/dialogue-parser.ts`, soft validation hook — 2 malformed-regex bugs in this doc's own draft snippets fixed (missing capture-group paren in `stripDialogueMarkers` and the validation hook).
- `utils/localized-style.ts` (id/es/fr/ja/ko/pt/de) — replaces a dead, unwired draft of the same function found sitting in `utils/story.ts`.
- `imagePrompt`/`imageImportance` per-page fields added to the generation contract mid-round, as a forward-looking optional-illustration feature (not in this doc's original 3 problems).

### Round 2 (2026-09-02) — closing gaps found once `schema/story.ts`, `schema/db.ts`, `services/book.ts`, `narrative-style.ts`, `player-profile.ts` came in hand

**Schema/DB wiring for `imagePrompt`/`imageImportance` (previously flagged as blocked, now closed):**
- `schema/story.ts`'s `STORY_PAGE_GENERATION_SCHEMA` (the AI JSON schema, `satisfies Record<keyof StoryPageGeneration, AIJsonProperty>`) — added both keys; cascades automatically into the first-page and multi-turn schemas via existing spread composition, no further edits needed there.
- `schema/db.ts`'s Drizzle `pages` table — added `imagePrompt`/`imageImportance` columns (`text`/`real`, matching the `sceneFocus`-style score-column convention already used elsewhere).
- `services/book.ts` — **three independent page mappers** needed the same two fields added by hand, since none of them derive from a single shared source: `mapToStoryPage` (would have failed to compile — `satisfies Record<keyof StoryPage, unknown>`), `mapToPersistedStoryPage` (would NOT have failed to compile, since optional fields don't force `satisfies X` to list them — silently drops the fields instead, which is worse), and `mapToEnrichedPage` (the reader-facing serializer — its `satisfies Record<keyof EnrichedStoryPage, unknown>` check is commented out in the source, so this one would have shipped silently broken with no compiler warning at all). Also added to the `DBNewPage` insert payload.
- ⚠️ **Flagged, not changed:** `mapToEnrichedPage`'s commented-out `satisfies` check looks worth re-enabling (it's exactly the guard that would have caught this gap automatically), but re-enabling it without a full type-checker to verify against risks introducing a real compile error I can't detect with a syntax-only check. Left as-is; recommend the team re-enable it under `tsc`.

**`[dialogue]` collision — investigated, not a bug, guarded further:**
- `services/book.ts` revealed `stripActionTypeTags`, a pre-existing, *intentional* mechanism that strips bracketed `ActionType` control markers (e.g. `[dialogue].`) from page text before persistence. Round 1 had reworded `field-instructions.ts`'s dialogue-action instruction away from literally emitting `[dialogue].`, having read it as ambiguous prose rather than a known, working mechanism — that reword is still correct to keep (the strip function remains a harmless no-op safety net either way, and the reword reduces confusion with the new `[character_id]` markers), but it surfaced a **real, narrow collision risk**: `ACTION_TYPE_TAG_PATTERN` matches any of 13 reserved words in brackets (`explore/escape/social/risk/ignore/attack/deceive/protect/create/heal/dialogue/custom/other`) — if a side character's AI-generated ID ever exactly equals one of those words, their dialogue marker would be silently stripped before storage. No code-level slug generator exists to guard against this (character IDs are AI-generated, not deterministically slugified), so guarded at the prompt/schema level instead: `characterId`'s schema description and `RULES_DIALOGUE_ATTRIBUTION` both now explicitly forbid those 13 words plus `mc`/`???` as character IDs. This reduces but — same caveat as everywhere prompt compliance is the only guardrail — does not mathematically eliminate the risk.

**New parallel finding — `memoryIntegrity`/`realityStability` had the same phase-blindness composure did:**
- `narrative-style.ts`'s `determineNarrativeMode` forces `'fractured'` prose mode whenever `memoryClarity <= 0.3` (i.e. `memoryIntegrity === 'corrupted'`), with **no phase check** — the only existing phase gate is `isEnding` (FINALE) forcing fractured unconditionally; nothing stopped EARLY from reaching the same state.
- Traced to `updateHiddenState` (story.ts): unlike composure, `memoryScore`/`stabilityScore` are recomputed **fresh every page** with no memory of prior pages — so this was never a "decays too fast" problem, it's that a single worst-case page (critical momentum + a horror-tagged scene + a couple of trauma tags) can swing straight to `'corrupted'`/`'broken'` with zero ramp-up, confirmed reachable as early as page 5.
- Fixed with the same floor pattern as composure: `MEMORY_INTEGRITY_EARLY_PHASE_FLOOR`/`_MID_PHASE_FLOOR` and `REALITY_STABILITY_EARLY_PHASE_FLOOR`/`_MID_PHASE_FLOOR` (config/story.ts), applied in `updateHiddenState`. EARLY floors sit just above each resource's worst-band threshold so the *middle* band (fragmented/slipping — "seeds of doubt," per `storyPhases.EARLY`) stays reachable; only the worst band is floored out.
- `narrative-style.ts` and `player-profile.ts` themselves needed **no changes** — both are pure consumers of `state.memoryIntegrity`/`state.hiddenState`, so they inherit the fix automatically. Confirmed neither file references `sanityState`/composure anywhere (the separation SANITY_STATE_ARCHITECTURE.md describes is real, not aspirational).

**Self-review checklist now cross-checks prose against the composure band (new, not in original proposal):**
- The clamp guarantees the composure *number* behaves correctly per phase, but nothing previously stopped the AI from narrating a full psychological break in prose while the engine correctly held the number well above 0 — a real narrative/mechanic mismatch risk, raised directly by the user. Added a bullet to both `buildNextPageReviewChecklist` and its Turn-A-duplicate `buildStoryPageReviewChecklist` (Section 2, Tension & Pacing) explicitly cross-checking narrated intensity against the Composure/Pressure band shown earlier in the same prompt. This is a second, independent check (self-review, not just generation-time steering) but — like the phase floor itself — is LLM compliance, not a hard guarantee; a keyword-heuristic backstop in `page-validation.ts` (same pattern as `checkDialogueMarkerCoverage`) was considered and deferred as likely too noisy to be useful signal.

**Prompt-caching hardening (new, not in original proposal):**
- `getLocalizedStyleConstraints`'s output was being spliced into the *system* prompt (via a `language` param on `buildPresetSystemPrompt`), which fragments the prompt-cache into one bucket per language instead of one shared entry across the whole platform — expensive given this system prompt includes every `RULES_*` block. `buildPresetSystemPrompt` is now 100% static given `(type, preset)` alone; the style constraints moved to the user turn instead (`formatNextPageNarrativePrompt`, unconditionally for both Turn A and Turn B; `buildBookCreationPrompt` for the first page) — both were already fully dynamic per call, so nothing was lost from caching that wasn't already uncached. `RULES_LANGUAGE_LOCALIZATION` stays in the system prompt since it's already language-agnostic prose. Trade-off worth watching: system-role instructions are generally followed slightly more reliably than user-role ones on weaker models in the waterfall.

**Frontend (in progress):**
- `reader-store.ts`: new `dialogueDisplayMode: 'plain' | 'gamified'` preference + `setDialogueDisplayMode`, following the existing `ReaderPrefs` pattern exactly (deep-merge-on-load already makes new fields forward-compatible, per the store's own persist logic).
- `SettingsModal.tsx`: new toggle, reusing existing `soundtrackVolumeRow` styling — no new CSS needed.
- New client-side `dialogue-parser` (mirrors `utils/dialogue-parser.ts`; duplicated rather than shared since frontend/backend read as separate deployable units from the files in hand).
- **Still pending:** `StoryText.tsx` (both the static JSX render path and the TypeIt typewriter-animation path need to detect and render/strip markers — the animation path in particular needs care, since TypeIt's HTML typing behavior with block-level "balloon" markup hasn't been verified against a live implementation), `StoryText.module.css` (balloon styling), and confirming `ReaderPageClient.tsx` passes what `StoryText.tsx` will need (character/lore data for avatar+name resolution).

**Still open from the original proposal:** OQ-3 (translation pipeline — strip or preserve markers), OQ-9 (marker visibility to readers pre-frontend-support) — resolved by the frontend work above once it lands.

---

## At-a-Glance Status

| # | Item | Status | Phase |
|---|------|--------|-------|
| 1 | Phase-aware composure decay (engine) | ✅ Implemented (extended with MID earned-trauma floor) | Story Engine |
| 2 | Phase-aware composure prompt guidance | ✅ Implemented | Prompt |
| 3 | Language-specific stylistic constraints | ✅ Implemented, relocated to user turn for cache efficiency | Prompt |
| 4a | Dialogue attribution rules (prompt) | ✅ Implemented (+ reserved-word collision guard) | Prompt |
| 4b | Character ID in prompt context | ✅ Already exists | — |
| 4c | Dialogue parser utility (backend) | ✅ Implemented (2 regex bugs fixed vs. this doc's draft) | New Utility |
| 4c′ | Dialogue parser utility (frontend) | ✅ Implemented | New Utility |
| 4d | Validation hook for markers | ✅ Implemented (soft/non-blocking) | Validation |
| 5 | Early phase floor value decision | ✅ Resolved — 30 | Design |
| 6 | Dialogue marker format decision | ✅ Resolved — line-start prefix, `[mc]` reserved token | Design |
| 7 | Translation pipeline integration | ⏳ Open (needs translation-cron file) | Pipeline |
| 8 | Prompt token budget impact | ✅ Accepted (~300-400 tokens, see OQ-4) | Performance |
| 9 | Marker visibility to readers | 🔄 Settings + store done; `StoryText.tsx` rendering pending | Frontend |
| 10 | `imagePrompt`/`imageImportance` per-page fields | ✅ Fully wired: generation contract, AI schema, DB columns, all 3 page mappers | New (added 2026-09-01) |
| 11 | `memoryIntegrity`/`realityStability` phase floors | ✅ Implemented | Story Engine (new, found 2026-09-02) |
| 12 | Composure/prose alignment self-review check | ✅ Implemented (soft, checklist-level) | Prompt (new, found 2026-09-02) |
| 13 | Prompt-caching: static system prompt | ✅ Implemented | Prompt (new, 2026-09-02) |

> **Legend:** ✅ Complete | ⏳ Pending | ◻️ Not Started | ⏩ Deferred | 🔄 In Progress

---

## Table of Contents

1. [Problem 1: Sanity/Composure Drops Too Fast in Early Phase](#problem-1-sanitycomposure-drops-too-fast-in-early-phase)
2. [Problem 2: No Language-Specific Stylistic Constraints](#problem-2-no-language-specific-stylistic-constraints)
3. [Problem 3: No Gamified Dialogue Attribution](#problem-3-no-gamified-dialogue-attribution)
4. [Implementation Plan](#implementation-plan)
5. [Testing Strategy](#testing-strategy)

---

## Problem 1: Sanity/Composure Drops Too Fast in Early Phase

### Symptom

Readers report that `sanityState.composure` drops from 100 to critical (≤25) within the first 10–15 pages, even when the story is in EARLY phase where the narrative goal is "Intrigue & Seeding — keep tension light, prioritizing intrigue over outright dread."

### Root Cause Analysis

The composure decay engine (`updateSanity` in `src/utils/story.ts:1484`) has **zero phase-awareness**. It applies identical decay math regardless of whether the story is on page 2 (EARLY) or page 90 (LATE).

#### Current Decay Formula (no phase gate)

```
decayThisPage = 0
if momentum === 'critical': decayThisPage = decayRate (5)
if momentum === 'rising':   decayThisPage = decayRate * 0.5 (2.5)

// Threat amplifiers (no phase check):
if threatProximity === 'immediate': decayThisPage *= 1.5
if threatProximity === 'near':      decayThisPage *= 1.2

// Trauma tag escalation (no phase check):
if traumaCount >= 3: decayThisPage += floor(traumaCount / 3)
```

**Worst-case EARLY phase scenario:**
- momentum = critical (5) × immediate threat (1.5) = **7.5 composure/page**
- After 3 trauma tags: **8.5 composure/page**
- Starting at 100 → crash (0) in **~12 pages**
- With `maxComposure` reduced by trauma (5 per tag): crash in **~8 pages**

This completely defeats the EARLY phase goal of "ground the character and introduce the core mystery" — the reader is in crisis before the mystery even begins.

#### Contributing Factor: Prompt Lacks Phase-Specific Composure Guidance

`formatSanityState` (prompt.ts:3826) provides pressure bands based on ratio only:

```
ratio ≤ 0.25 → CRITICAL — barely holding on. Tunnel vision, panic
ratio ≤ 0.5  → STRAINED — stress shows in body and thought
ratio ≤ 0.75 → WEARING — tension accumulates
ratio > 0.75 → HOLDING — MC can still function
```

There are **no instructions telling the AI how composure pressure should differ by phase**. The AI sees the same "CRITICAL — barely holding on" text on page 5 as on page 85, and responds with identical narrative intensity.

#### Contributing Factor: Narrative Style Engine Has No Composure-Phase Coupling

`determineNarrativeMode` (narrative-style.ts:143) uses `memoryClarity` (from `memoryIntegrity`) — not `composure` — to decide between grounded/uneasy/fractured. This is architecturally correct (composure ≠ narrative style), but it means the AI receives **no signal** that composure is low AND the story is early, which should feel very different from low composure in LATE.

### Design Constraints

1. **Engine-owned:** `sanityState` must remain engine-computed, never AI-authored (per SANITY_STATE_ARCHITECTURE.md).
2. **Delta-compatible:** Any changes to decay logic must be recorded as full `StateDelta.sanityState` snapshots for reconstruction.
3. **Momentum-first:** Decay must remain primarily momentum-driven (not page-count-driven) per the architecture doc.
4. **Early ≠ free:** Composure should still decay in EARLY — just slower. Early-phase stories should see composure drift to ~60–70 by mid-phase, not crash.

---

## Problem 2: No Language-Specific Stylistic Constraints

### Symptom

Non-English stories (especially Indonesian, Japanese, Spanish) suffer from:
- Formal "Bahasa Baku" vocabulary instead of novelistic Indonesian
- AI defaults to polite/formal register (saya → should be aku)
- Translated-sounding prose instead of native expressions
- Educational/textbook tone instead of gritty thriller voice

### Root Cause

The current localization rule (`RULES_LANGUAGE_LOCALIZATION` in prompt.ts:81) is:

```
STRICT LANGUAGE & LOCALIZATION:
- The requested language is an ABSOLUTE MANDATE...
- Use everyday expressions, slang, and terminology that feel native...
- Preserve proper nouns and provided names as-is.
- Defaulting back to any unrequested language is treated as an incorrect response.
```

This enforces **language correctness** but not **stylistic quality**. It tells the AI "write in Indonesian" but not "write in *novelistic* Indonesian that avoids formal register."

The `PROMPT_SYSTEM_WRITING_STYLE` (book-creation.ts) sets tone but is language-agnostic. Weaker models in the waterfall (Mistral-7B, Llama-3.1) default to formal training data when generating non-English text.

### Design Constraints

1. **ISO 639-1 input:** Function accepts language code, returns style rules.
2. **DRY:** Inject once into system prompt, not duplicated per generation phase.
3. **Extensible:** Easy to add new languages (switch/case pattern).
4. **Token-efficient:** Fallback to universal baseline for unsupported languages.

---

## Problem 3: No Gamified Dialogue Attribution

### Symptom

All dialogue in story pages appears as unattributed quoted text:

```
"You shouldn't have come here."
"I heard nothing."
"Then hurry."
```

Readers must mentally track "who said that" — especially difficult in stories with 4–6 characters. No mechanism exists for future character avatars, TTS voice casting, or relationship UI.

### Root Cause

The AI generates dialogue as plain prose with no speaker attribution metadata. The prompt system has no instruction for dialogue marking. The output schema (`nextPageOutputFormat`) produces flat `text` with no dialogue structure.

### Proposed Solution: Lightweight `[character_id]` Markers

Rather than a full `StoryBlock[]` restructuring (which would require massive schema, prompt, and frontend changes), adopt the **minimal marker approach**:

**Format in generated text:**

```
The hallway had gone strangely quiet.

[mara] "You heard it too, didn't you?"

Elias stopped halfway down the staircase.

[elias] "I heard nothing."

He was lying. Mara could tell from the way his hand tightened around the railing.
```

**Advantages over full structured blocks:**
- Zero schema changes (still flat `text` field)
- Zero frontend rendering changes (markers are plain text for now)
- Backend can parse `[id]` markers for future structured extraction
- Works with existing translation pipeline
- Incremental upgrade path to full `StoryBlock[]` later

### Design Constraints

1. **Character ID format:** Use compact IDs already in the system (`characterId` from `state.characters`), not UUIDs.
2. **MC narration:** First-person narration must NOT get `[mc_id]` markers — only external dialogue.
3. **Unknown speakers:** Support `[???]` for unidentified speakers (thriller staple).
4. **Recognition levels:** Markers should respect `recognitionLevel` — never reveal a name the MC doesn't know.
5. **Consecutive same-speaker:** Allow consecutive lines from same speaker without repeating marker (grouped).
6. **Parser-friendly:** Markers must be parseable from the text for future structured extraction.

---

## Implementation Plan

### ◻️ Phase 1: Phase-Aware Composure Decay (Story Engine)

**File: `src/config/story.ts`**

Add phase-specific decay multipliers:

```typescript
/**
 * Phase-specific composure decay multipliers.
 * EARLY = 0.4 (slow bleed), MID = 0.7, LATE = 1.0 (full), FINALE = 1.2 (aggressive).
 * Applied to the base decay rate before threat/trauma amplifiers.
 */
export const SANITY_PHASE_DECAY_MULTIPLIER: Record<StoryPhase, number> = {
  EARLY:  0.4,
  MID:    0.7,
  LATE:   1.0,
  FINALE: 1.2,
};

/**
 * Minimum composure floor during EARLY phase — prevents crash before
 * the mystery is established. Lifted once MID phase begins.
 */
export const SANITY_EARLY_PHASE_FLOOR = 30;
```

**File: `src/utils/story.ts` — `updateSanity()`**

Add phase parameter to `NarrativeContext` (it already has `phase?`), then gate decay:

```typescript
export function updateSanity(state: StoryState, context: NarrativeContext): void {
  const { momentum = 'building', phase = 'EARLY' } = context;
  const sanity = ensureSanityState(state);
  
  // ... existing trauma max sync ...
  
  if (sanity.hasCrashed) { sanity.composure = 0; return; }
  
  // Phase-gated decay
  const phaseMultiplier = SANITY_PHASE_DECAY_MULTIPLIER[phase] ?? 1.0;
  
  let decayThisPage = 0;
  if (momentum === 'critical') {
    decayThisPage = sanity.decayRate;
  } else if (momentum === 'rising') {
    decayThisPage = Math.round(sanity.decayRate * 0.5);
  }
  
  // Apply phase multiplier BEFORE threat amplifiers
  decayThisPage = Math.round(decayThisPage * phaseMultiplier);
  
  // ... existing threat proximity amplifiers (unchanged) ...
  // ... existing trauma tag escalation (unchanged) ...
  
  // EARLY phase floor — prevents crash during setup
  if (phase === 'EARLY' && sanity.composure - decayThisPage < SANITY_EARLY_PHASE_FLOOR) {
    decayThisPage = Math.max(0, sanity.composure - SANITY_EARLY_PHASE_FLOOR);
  }
  
  // ... existing decay application and resolution recovery ...
}
```

**Effective decay rates (with phase multiplier, before threat amplifiers):**

| Phase | Momentum: critical | Momentum: rising | Momentum: building |
|-------|-------------------|-------------------|---------------------|
| EARLY | 5 × 0.4 = **2** | 2.5 × 0.4 = **1** | **0** |
| MID   | 5 × 0.7 = **3.5** | 2.5 × 0.7 = **1.75** | **0** |
| LATE  | 5 × 1.0 = **5** | 2.5 × 1.0 = **2.5** | **0** |
| FINALE| 5 × 1.2 = **6** | 2.5 × 1.2 = **3** | **0** |

**With EARLY floor at 30, worst-case EARLY scenario:**
- 100 → 30 minimum = 70 points of decay headroom
- At 2 composure/page (critical momentum, no threat amp): **35 pages** to reach floor
- At 3 composure/page (critical + immediate threat): **23 pages** to reach floor
- This matches the EARLY phase window (~25% of 80–200 pages = 20–50 pages)

### ◻️ Phase 2: Phase-Aware Composure Prompt Guidance

**File: `src/utils/prompt.ts` — `formatSanityState()`**

Replace the static pressure bands with phase-aware guidance:

```typescript
function formatSanityState(sanityState: SanityState | undefined, phase?: StoryPhase): string {
  const { composure, maxComposure, hasCrashed, crashedAtPage } = sanityState ?? SANITY_STATE_DEFAULTS;
  const ratio = maxComposure > 0 ? composure / maxComposure : 0;

  const pressure = hasCrashed
    ? 'CRISIS — force psychological collapse: no safe choices, reality fractures, identity slips'
    : ratio <= 0.25 ? 'CRITICAL — barely holding on. Tunnel vision, panic, poor judgment. World pressure feels crushing'
    : ratio <= 0.5  ? 'STRAINED — stress shows in body and thought. Brief lucidity still possible between blows'
    : ratio <= 0.75 ? 'WEARING — tension accumulates. Occasional cracks; not yet broken'
    : 'HOLDING — MC can still function under pressure. Allow clear thought when the scene permits';

  // Phase-specific behavioral guidance for the AI
  const phaseGuidance = (() => {
    if (hasCrashed) return '';
    
    switch (phase) {
      case 'EARLY':
        if (ratio > 0.75) return 'EARLY PHASE: Composure is healthy. Keep psychological pressure SUBTLE — unease in implication, not overt breakdown. The MC should feel growing curiosity and mild discomfort, NOT panic or despair.';
        if (ratio > 0.5) return 'EARLY PHASE: Composure is dipping. Introduce quiet wrongness — a detail that doesn't add up, a character who feels off. Do NOT escalate to overt psychological warfare yet. The mystery is still seeding.';
        return 'EARLY PHASE: Composure is low — unusual for this early. Reduce overt threat and allow a grounding beat (dialogue, reflection, safe space). The story needs the MC functional for the mystery to develop.';
      
      case 'MID':
        if (ratio > 0.75) return 'MID PHASE: Composure is resilient. Push harder — introduce betrayals, impossible choices, or reality glitches that the MC cannot explain.';
        if (ratio > 0.5) return 'MID PHASE: Composure is strained. Alternate pressure with brief recovery — a trusted ally appears, a clue clicks, a moment of dark humor. Pacing needs rhythm, not constant escalation.';
        return 'MID PHASE: Composure is critical. The MC is cracking — paranoia, tunnel vision, poor judgment. But allow ONE lucid moment per page so the reader can still follow the plot.';
      
      case 'LATE':
        if (ratio > 0.5) return 'LATE PHASE: Composure still holds — surprising given the circumstances. Use this resilience against the MC: they think they can handle it, then pull the rug.';
        return 'LATE PHASE: Composure is shredded. The MC operates on instinct and fear. Every scene should feel like it could be the breaking point. Converge storylines toward the ending.';
      
      case 'FINALE':
        return 'FINALE PHASE: Composure is irrelevant — crisis is here. Write with maximum psychological intensity. No safe spaces, no recovery beats, no mercy.';
      
      default:
        return '';
    }
  })();

  const crashNote = hasCrashed && crashedAtPage
    ? `\n• Crashed at page: ${crashedAtPage} (sticky crisis — do not restore safety)`
    : '';

  const guidanceLine = phaseGuidance ? `\n• Phase Guidance: ${phaseGuidance}` : '';

  return `• Composure: ${composure}/${maxComposure}${hasCrashed ? ' [CRASHED]' : ''}
• Pressure: ${pressure}${crashNote}${guidanceLine}
• Never name "composure" or a sanity meter to the reader — pressure the prose, not the label.`;
}
```

**Update call site** in `formatNextPageNarrativePrompt` (prompt.ts:3607):

```typescript
// Before:
${formatSanityState(sanityState)}

// After:
${formatSanityState(sanityState, phase)}
```

### ◻️ Phase 3: Language-Specific Stylistic Constraints

**New file: `src/utils/localized-style.ts`**

```typescript
/**
 * Generates language-specific tone and style constraints for the LLM prompt.
 *
 * Ensures the AI avoids formal, robotic translations and maintains a gritty,
 * novelistic, and emotive first-person narrative voice. Dynamically tailors
 * negative constraints to the grammatical quirks of specific target languages
 * (ISO 639-1) to prevent "language drift" where weaker models default to
 * formal training data.
 *
 * @param languageCode - ISO 639-1 language code (e.g., 'en', 'id', 'es')
 * @returns Localized style constraint prompt block for system prompt injection
 *
 * @example
 * // Returns universal baseline plus Indonesian overrides
 * getLocalizedStyleConstraints('id');
 *
 * @example
 * // Returns universal baseline only (no specific overrides)
 * getLocalizedStyleConstraints('de');
 */
export function getLocalizedStyleConstraints(languageCode: string): string {
  const universalBaseline = `CRITICAL TONE & LOCALIZATION CONSTRAINTS:
- LITERARY PROSE: Write in a highly evocative, novelistic style suitable for a gritty thriller. STRICTLY AVOID formal, academic, standard, or "AI-sounding" rigid vocabulary.
- INFORMAL POV: The narrative voice must feel deeply personal and emotive. Never sound like a formal translator or assistant.
- SENSORY LANGUAGE: Favor visceral, concrete imagery over abstract description. Let the reader feel the cold, smell the decay, hear the silence.
- SENTENCE RHYTHM: Vary sentence length for pacing. Short punchy sentences for tension. Longer flowing sentences for dread. Never monotonous.`;

  let localizedOverrides = '';

  switch (languageCode.toLowerCase()) {
    case 'id':
      localizedOverrides = `
- INDONESIAN OVERRIDES: You are STRICTLY FORBIDDEN from using "Bahasa Baku" (formal Indonesian). Never use rigid phrasing like "Identik dengan saya" or "Saya merasa". You MUST use "aku" for first-person pronouns — never use "saya". Use contemporary novelistic Indonesian with visceral, poetic phrasing. Favor metaphorical expressions over literal descriptions. Use informal contractions and sentence fragments when they serve the emotional rhythm.`;
      break;

    case 'es':
      localizedOverrides = `
- SPANISH OVERRIDES: Use informal, visceral phrasing. Default to "tú" for internal monologue and casual dialogue — never "usted" unless the specific character dynamic demands formal address. Avoid sterile, textbook Spanish. Use regional idioms and concrete sensory language over abstract literary constructions.`;
      break;

    case 'fr':
      localizedOverrides = `
- FRENCH OVERRIDES: Write in modern, gritty literary style. Default to "tu" for internal thoughts and casual dialogue — avoid the formal "vous" unless contextually required. Use concrete, visceral imagery. Avoid bureaucratic or overly polite phrasing. Favor short, punchy sentences for tension over complex subordinate clauses.`;
      break;

    case 'ja':
      localizedOverrides = `
- JAPANESE OVERRIDES: AVOID polite/formal forms (Desu/Masu). Use casual, dramatic forms (Da/De aru) appropriate for psychological thriller inner monologue. First-person pronouns: use "boku" or "ore" for male MC, "watashi" or "atashi" for female MC — never the overly formal "watakushi". Use gritty, concrete imagery over abstract literary constructions.`;
      break;

    case 'ko':
      localizedOverrides = `
- KOREAN OVERRIDES: Use casual/dramatic verb endings (-다, -어/아) for internal monologue — avoid formal (-입니다/합니다) unless in formal dialogue. First-person: use "나" for casual narration, "나는" for emphasis — never the formal "저". Use visceral, concrete sensory language over abstract descriptions.`;
      break;

    case 'pt':
      localizedOverrides = `
- PORTUGUESE OVERRIDES: Use informal Brazilian Portuguese register. Default to "você" for second person — avoid "o senhor/a senhora". Use contractions (pra, pro) in dialogue. Favor visceral, concrete imagery over formal literary constructions. Use short sentences for tension.`;
      break;

    case 'de':
      localizedOverrides = `
- GERMAN OVERRIDES: Use "du" for internal monologue — never "Sie" unless formal dialogue is contextually required. Favor concrete, sensory language over abstract philosophical constructions. Use sentence fragments and em dashes for tension. Avoid overly complex compound sentences that slow pacing.`;
      break;

    // Add more languages as Twistloom expands
  }

  return `${universalBaseline}${localizedOverrides}`.trim();
}
```

**Integration into prompt system:**

**File: `src/utils/prompt.ts` — `buildPresetSystemPrompt()`**

```typescript
import { getLocalizedStyleConstraints } from './localized-style.js';

function buildPresetSystemPrompt(
  type: 'first' | 'next' | 'state-delta', 
  preset: WritingPreset = 'default',
  language?: string
): string {
  const writingStyle = PROMPT_SYSTEM_WRITING_STYLE[preset] ?? PROMPT_SYSTEM_WRITING_STYLE.default;
  
  // ... existing rules logic ...
  
  const styleConstraints = language 
    ? `\n\n---\n${getLocalizedStyleConstraints(language)}`
    : '';

  return `${writingStyle}\n\n---\n${RULES_LANGUAGE_LOCALIZATION}${styleConstraints}\n\n---\n${rules}`;
}
```

### ◻️ Phase 4: Gamified Dialogue Markers

**Approach:** Minimal text markers in the `text` field, parseable by backend and frontend.

**◻️ Step 4a: Add dialogue attribution rules to the system prompt**

**File: `src/utils/prompt.ts` — new rule block**

```typescript
export const RULES_DIALOGUE_ATTRIBUTION = `DIALOGUE ATTRIBUTION RULES:
- Every line of spoken dialogue MUST be preceded by a speaker marker on its own line.
- Format: [character_id] "dialogue text"
- Use the exact character IDs from the characters list below (e.g., [tom_m], [lisa_park]).
- For the MC (first-person narrator): do NOT add markers to narration or internal thoughts. Only add [mc_id] when the MC speaks aloud to another character.
- For unknown speakers: use [???] when the reader cannot know who spoke.
- For narrator voice (no character speaking): no marker — plain prose.
- Consecutive dialogue from the same speaker: repeat the marker on each new paragraph for clarity.
- NEVER invent character IDs. NEVER use character names — only IDs from the provided list.
- The marker appears on its own line BEFORE the dialogue line, not inline.

Example:
The hallway was empty except for the sound of rain.

[mara] "You heard it too, didn't you?"

Elias stopped halfway down the staircase.

[elias] "I heard nothing."

He was lying. Mara could tell from the way his hand tightened around the railing.
```

**Integration:** Add `RULES_DIALOGUE_ATTRIBUTION` to `buildFirstPageRuleSet()` (prompt.ts:302):

```typescript
function buildFirstPageRuleSet(preset: WritingPreset = 'default'): string {
  const pageTextRules = RULES_PAGE_TEXT_BY_PRESET[preset] ?? RULES_PAGE_TEXT_BY_PRESET.default;
  return [
    RULES_DIFFICULTY_SCALING,
    RULES_ENDING_ARCHETYPES,
    RULES_STORY_MOMENTUMS,
    RULES_SCENE_TYPES,
    RULES_PLACE,
    RULES_CHARACTER,
    RULES_CHARACTER_RECOGNITION,
    RULES_EMBODIED_SCENE_CONTINUITY,
    RULES_DIALOGUE_ATTRIBUTION,  // NEW
    pageTextRules,
    RULES_ACTIONS,
  ].join('\n\n---\n');
}
```

**✅ Step 4b: Character ID mapping in prompt context**

The character list in the prompt already shows `[ID: character_id]` (see `formatCharactersForPrompt` in characters.ts:424). The AI already sees these IDs. The dialogue attribution rule tells it to use them as markers.

**◻️ Step 4c: Backend parser for future structured extraction**

**New file: `src/utils/dialogue-parser.ts`**

```typescript
/**
 * Parsed dialogue segment from a story page's text field.
 */
export type DialogueSegment = {
  type: 'prose';
  text: string;
} | {
  type: 'dialogue';
  speakerId: string;
  text: string;
};

/**
 * Regex pattern matching dialogue markers: [character_id] or [???]
 * Captures the speaker ID (inside brackets) and the dialogue text.
 */
const DIALOGUE_MARKER_PATTERN = /^\[([\w_]+|\?\?\?)\]\s*/gm;

/**
 * Parses a page text field into prose and dialogue segments.
 *
 * Segments are split on dialogue markers. Text before the first marker
 * (if any) is prose. Each marker introduces a dialogue segment.
 *
 * @param text - Raw page text from AI generation
 * @returns Array of prose and dialogue segments
 *
 * @example
 * const segments = parseDialogueMarkers(
 *   'The hall was quiet.\n[mara] "Hello."\n[elias] "Hi."'
 * );
 * // [
 * //   { type: 'prose', text: 'The hall was quiet.' },
 * //   { type: 'dialogue', speakerId: 'mara', text: '"Hello."' },
 * //   { type: 'dialogue', speakerId: 'elias', text: '"Hi."' }
 * // ]
 */
export function parseDialogueMarkers(text: string): DialogueSegment[] {
  const segments: DialogueSegment[] = [];
  const lines = text.split('\n');
  
  let currentProse: string[] = [];
  
  for (const line of lines) {
    const match = line.match(/^\[([\w_]+|\?\?\?)\]\s*(.*)/);
    
    if (match) {
      // Flush accumulated prose
      const proseText = currentProse.join('\n').trim();
      if (proseText) {
        segments.push({ type: 'prose', text: proseText });
      }
      currentProse = [];
      
      // Add dialogue segment
      segments.push({
        type: 'dialogue',
        speakerId: match[1],
        text: match[2].trim(),
      });
    } else {
      currentProse.push(line);
    }
  }
  
  // Flush remaining prose
  const proseText = currentProse.join('\n').trim();
  if (proseText) {
    segments.push({ type: 'prose', text: proseText });
  }
  
  return segments;
}

/**
 * Strips dialogue markers from text, returning plain prose.
 * Used for translation pipeline, TTS, and EPUB export.
 *
 * @param text - Raw page text with markers
 * @returns Text with all [id] markers removed
 *
 * SHIPPED VERSION NOTE: the regex below as originally drafted here —
 * `/^\[[\w_]+|\?\?\?)\]\s*/gm` — is malformed (missing the opening
 * capture-group paren after `\[`, leaving a stray unmatched `)`); it throws
 * `SyntaxError: Invalid regular expression` at import time rather than
 * running. The actual shipped `utils/dialogue-parser.ts` fixes this by
 * deriving both this function and `parseDialogueMarkers` from one source
 * pattern string (`DIALOGUE_MARKER_SOURCE`) instead of two independently
 * hand-written literals — see that file. Corrected inline below for anyone
 * copying from this doc directly.
 */
export function stripDialogueMarkers(text: string): string {
  return text.replace(/^\[([\w_]+|\?\?\?)\]\s*/gm, '');
}
```

**✅ Step 4d: Post-generation validation hook** — Implemented

In the page validation pipeline (`checkGeneratedPage`), a soft warning fires when markers are inconsistently used:

```typescript
// In checkGeneratedPage (corrected regex — see stripDialogueMarkers note above
// for the same missing-paren bug this snippet originally had too):
const hasAnyMarkers = /^\[([\w_]+|\?\?\?)\]/m.test(page.text);
const dialogueLines = page.text.match(/"[^"]+"/g);
if (dialogueLines && dialogueLines.length > 2 && !hasAnyMarkers) {
  // Soft warning — don't reject, but log for prompt refinement
  console.warn(`[PageValidation] Page ${page.page} has ${dialogueLines.length} dialogue lines but no speaker markers`);
}
```

---

## Implementation Plan Summary

| Status | Phase | Files | Effort | Risk |
|--------|-------|-------|--------|------|
| ◻️ | 1: Phase-aware composure decay | `config/story.ts`, `utils/story.ts` | Medium | Low — additive change, existing tests validate |
| ◻️ | 2: Phase-aware composure prompt | `utils/prompt.ts` | Low | Low — prompt-only change, A/B testable |
| ◻️ | 3: Localized style constraints | New `utils/localized-style.ts`, `utils/prompt.ts` | Low | Low — additive, fallback to universal baseline |
| ◻️ | 4a: Dialogue attribution rules | `utils/prompt.ts` | Low | Low — prompt addition, opt-in feel |
| ✅ | 4b: Character ID in prompt | Already exists | None | None |
| ◻️ | 4c: Dialogue parser | New `utils/dialogue-parser.ts` | Medium | Low — standalone utility, no schema changes |
| ◻️ | 4d: Validation hook | `utils/page-validation.ts` | Low | Low — soft warnings only |

**Total estimated effort:** 3–5 days for a senior developer.

---

## Testing Strategy

### Phase 1 Tests

```typescript
// Unit test: updateSanity with phase parameter
it('applies 0.4x decay multiplier in EARLY phase', () => {
  const state = createTestStoryState({ page: 5, maxPage: 100 });
  state.sanityState = { composure: 100, maxComposure: 100, decayRate: 5, hasCrashed: false };
  state.hiddenState.threatProximity = 'immediate';
  
  updateSanity(state, { momentum: 'critical', phase: 'EARLY' });
  
  // Without phase: 5 × 1.5 = 7.5 → ~8 decay
  // With phase: 5 × 0.4 = 2, × 1.5 = 3 → composure = 97
  expect(state.sanityState.composure).toBe(97);
});

it('EARLY phase floor prevents crash during setup', () => {
  const state = createTestStoryState({ page: 5, maxPage: 100 });
  state.sanityState = { composure: 35, maxComposure: 100, decayRate: 5, hasCrashed: false };
  
  updateSanity(state, { momentum: 'critical', phase: 'EARLY' });
  
  // 5 × 0.4 = 2 decay, but floor at 30 → only 5 decay
  expect(state.sanityState.composure).toBeGreaterThanOrEqual(30);
  expect(state.sanityState.hasCrashed).toBe(false);
});
```

### Phase 2 Tests

```typescript
// Prompt output test: formatSanityState includes phase guidance
it('returns EARLY phase guidance when composure > 0.75', () => {
  const result = formatSanityState(
    { composure: 85, maxComposure: 100, decayRate: 5, hasCrashed: false },
    'EARLY'
  );
  expect(result).toContain('EARLY PHASE');
  expect(result).toContain('SUBTLE');
});

it('returns FINALE phase guidance when composure is low', () => {
  const result = formatSanityState(
    { composure: 20, maxComposure: 100, decayRate: 5, hasCrashed: false },
    'FINALE'
  );
  expect(result).toContain('FINALE PHASE');
  expect(result).toContain('maximum psychological intensity');
});
```

### Phase 3 Tests

```typescript
// Unit test: getLocalizedStyleConstraints
it('returns Indonesian overrides for id', () => {
  const result = getLocalizedStyleConstraints('id');
  expect(result).toContain('Bahasa Baku');
  expect(result).toContain('aku');
  expect(result).toContain('STRICTLY FORBIDDEN');
});

it('returns universal baseline for unsupported language', () => {
  const result = getLocalizedStyleConstraints('xx');
  expect(result).toContain('LITERARY PROSE');
  expect(result).toContain('INFORMAL POV');
  // No language-specific overrides
});
```

### Phase 4 Tests

```typescript
// Unit test: parseDialogueMarkers
it('parses prose and dialogue segments', () => {
  const text = 'The hall was quiet.\n[mara] "Hello."\n[elias] "Hi."';
  const segments = parseDialogueMarkers(text);
  
  expect(segments).toEqual([
    { type: 'prose', text: 'The hall was quiet.' },
    { type: 'dialogue', speakerId: 'mara', text: '"Hello."' },
    { type: 'dialogue', speakerId: 'elias', text: '"Hi."' },
  ]);
});

it('handles unknown speakers', () => {
  const text = '[???] "Don\'t turn around."';
  const segments = parseDialogueMarkers(text);
  expect(segments[0]).toEqual({ type: 'dialogue', speakerId: '???', text: '"Don\'t turn around."' });
});

it('strips markers for plain text export', () => {
  const text = '[mara] "Hello."\n[elias] "Hi."';
  expect(stripDialogueMarkers(text)).toBe('"Hello."\n"Hi."');
});
```

---

## Open Questions for Discussion

### ⏳ OQ-1: Early Phase Floor Value

**What:** The proposed `SANITY_EARLY_PHASE_FLOOR = 30` prevents composure from dropping below 30 during EARLY phase. Is this the right threshold?

**Why it matters:** Too high (e.g., 50) makes EARLY feel consequence-free — readers won't feel any tension. Too low (e.g., 10) allows crisis before the mystery is established, which defeats the purpose.

#### Options

| Option | Floor Value | Composure Range in EARLY | Feel |
|--------|-------------|--------------------------|------|
| A: Conservative | 30 | 100 → 30 (70 point headroom) | Safe setup, subtle unease. Reader may not notice the meter moving. |
| B: Aggressive | 20 | 100 → 20 (80 point headroom) | More tension, but still prevents crash. Reader feels stakes early. |
| C: Dynamic | 40 − (page × 0.5) | Starts at 40, decreases over EARLY | Higher floor at page 1, gradually lowers as story progresses. |
| D: None | 0 (no floor) | 100 → 0 possible | Current behavior. Crash can happen in EARLY. |

**Pros & Cons:**

- **Option A (30):** ✅ Matches the CRITICAL threshold (ratio ≤ 0.25 = 25), so "CRITICAL" pressure text never appears in EARLY. ✅ Simple to reason about. ⚠️ May feel too safe for readers who want early stakes.
- **Option B (20):** ✅ Allows CRITICAL pressure to briefly appear, giving a taste of horror before MID. ⚠️ Risk of crash if threat amplifiers stack heavily. ⚠️ More complex tuning.
- **Option C (Dynamic):** ✅ Most realistic — composure naturally erodes faster as story progresses. ✅ Feels organic. ⚠️ More complex implementation. ⚠️ Harder to reason about in tests. ⚠️ Floor could be negative if `page × 0.5 > 40` (page 80+), but EARLY ends at ~25% so max page is ~50.
- **Option D (No floor):** ✅ Maximum narrative freedom. ⚠️ Defeats the entire purpose of this enhancement. ⚠️ Current behavior that caused the problem.

**Recommendation: Option A (30).** Simple, effective, and aligns with the CRITICAL threshold boundary. The EARLY phase goal is to seed intrigue, not to test survival. If testing reveals it's too safe, bump down to 25. Avoid dynamic complexity for a first implementation — tune with data later.

---

### ⏳ OQ-2: Dialogue Marker Format

**What:** Should dialogue markers use compact character IDs (`[mara]`) or display names (`[Mara]`)? Or something else entirely?

**Why it matters:** The format affects token cost, parsing reliability, frontend rendering, and reader experience. This decision also affects the future upgrade path to structured `StoryBlock[]`.

#### Options

| Option | Format | Example | Token Cost | Parse Reliability |
|--------|--------|---------|------------|-------------------|
| A: Character ID | `[character_id]` | `[tom_m] "Hello."` | Low (short) | High (deterministic) |
| B: Display name | `[KnownName]` | `[Mara] "Hello."` | Medium | Medium (name collisions) |
| C: ID + name | `[id:name]` | `[mara:Mara] "Hello."` | High | Very High (redundant) |
| D: Superscript | `¹` or `⁽¹⁾` | `¹ "Hello."` | Minimal | Low (no semantic info) |

**Pros & Cons:**

- **Option A (Character ID):** ✅ Deterministic — `mara` always means the same character. ✅ Shortest token cost. ✅ Already displayed in prompt as `[ID: tom_m]`. ✅ Parser can resolve display names from `state.characters[id].knownName`. ⚠️ IDs like `tom_m` look technical to readers if rendered raw. ⚠️ Frontend must resolve for display.
- **Option B (Display Name):** ✅ Human-readable in source text. ✅ No resolution needed for display. ⚠️ Names can collide (two characters named "Tom"). ⚠️ Recognition levels complicate things — `[The Tall Man]` is valid for `seen` level but awkward. ⚠️ Token cost varies by name length.
- **Option C (ID + Name):** ✅ Both human-readable and parseable. ⚠️ Redundant — wastes tokens on duplicate info. ⚠️ Sync drift risk (name changes but ID stays).
- **Option D (Superscript):** ✅ Minimal visual disruption. ⚠️ No semantic content — requires footnote system. ⚠️ Complex parsing. ⚠️ Breaks plain-text export.

**Recommendation: Option A (Character ID).** The prompt already shows `[ID: character_id]` for every character, so the AI already has these IDs in context. The frontend can resolve IDs to display names (including recognition-level gating) at render time. This matches the existing architecture where `resolveCharacterDisplayName()` handles the ID→name mapping. If raw markers are visible to readers before frontend processing, we can add a post-processing step that replaces IDs with names — but the canonical format should be IDs for reliability.

---

### ⏳ OQ-3: Translation Pipeline Impact

**What:** How should `stripDialogueMarkers()` integrate with the existing translation cron job? Should markers be preserved in translations or stripped?

**Why it matters:** The translation cron runs as an async background job. If markers are stripped before translation, the translated text loses speaker attribution. If markers are preserved, the translation must handle them correctly (not translate the ID inside brackets).

#### Options

| Option | Behavior | Translation Quality | Post-Translation Work |
|--------|----------|---------------------|----------------------|
| A: Strip pre-translate | Remove markers, translate clean text | ✅ Clean translation | Re-apply markers via re-parsing or AI re-attribution |
| B: Preserve in translation | Keep `[id]` markers, instruct translator to skip them | ⚠️ Translator may mangle markers | Minimal — markers survive |
| C: Dual-layer | Store `text_clean` + `text_with_markers` | ✅ Both clean and attributed | Moderate — maintain two fields |
| D: Post-process restore | Translate with markers, fix any broken markers after | ⚠️ Fragile regex repair | Post-processing pass |

**Pros & Cons:**

- **Option A (Strip pre-translate):** ✅ Cleanest translation input — no markers to confuse the translator. ✅ Works with any translation provider. ⚠️ Lost attribution must be recovered — either re-parse (impossible without markers) or re-run AI attribution (expensive). ⚠️ Not viable without a recovery strategy.
- **Option B (Preserve in translation):** ✅ Zero post-processing — markers survive as-is. ✅ Translated text is immediately attributed. ⚠️ Translation AI may translate content inside brackets (`[tom_m]` → `[tomás_m]`). ⚠️ Need explicit instruction to translators: "Do not translate content inside square brackets." ⚠️ Risk of marker corruption in weak models.
- **Option C (Dual-layer):** ✅ Clean text for export/EPUB, attributed text for display. ✅ No data loss. ⚠️ Storage overhead (2× text field). ⚠️ Schema change needed. ⚠️ Maintenance burden — must keep both in sync.
- **Option D (Post-process restore):** ✅ Translation sees markers, can use them for context. ⚠️ Post-translation regex repair is fragile — translated text may shift character offsets. ⚠️ Complex to implement reliably.

**Recommendation: Option B (Preserve in translation) with explicit translator instruction.** Add a rule to the translation prompt: `DO NOT translate or modify content inside square brackets [like this]. These are structural markers, not translatable text.` This is the simplest viable path. If corruption occurs in practice, fall back to Option A with a re-parsing step that uses character name fuzzy matching.

---

### ⏳ OQ-4: Prompt Token Budget Impact

**What:** Adding `RULES_DIALOGUE_ATTRIBUTION` (~200 tokens) and `getLocalizedStyleConstraints()` (~100–200 tokens) increases prompt size. Is this within acceptable limits?

**Why it matters:** Every provider in the 8-provider waterfall has a maximum prompt length (`AI_MAX_PROMPT_LENGTH`). The existing prompt is already ~2K tokens for system + user. Adding 300–400 more tokens could push smaller-context models (some Cohere or Cloudflare models) closer to limits.

#### Analysis

| Component | Current Tokens | Added Tokens | New Total |
|-----------|---------------|--------------|-----------|
| System prompt (writing style + rules) | ~1,200 | +200 (dialogue rules) | ~1,400 |
| Language constraints | 0 | +100–200 (localized) | +100–200 |
| User prompt (context + state) | ~800 | 0 | ~800 |
| Documents (characters, places, etc.) | ~500 | 0 | ~500 |
| **Total** | **~2,500** | **+300–400** | **~2,800–2,900** |

The smallest context window in the waterfall is Cohere at ~32K tokens. 2,900 tokens is ~9% of that — well within limits.

#### Options

| Option | Approach | Token Cost | Compatibility |
|--------|----------|------------|---------------|
| A: Always include | Add rules to every prompt | +300–400 | ✅ All providers |
| B: Conditional include | Only include dialogue rules when ≥2 characters present | +0–400 | ✅ All providers |
| C: Cache in system prompt | Include once in system prompt (already cached by Gemini) | +300–400 | ✅ Gemini cache saves repeats |
| D: Separate turn | Dialogue rules only in multi-turn Turn B | +200 (Turn A only) | ⚠️ Complex routing |

**Pros & Cons:**

- **Option A (Always include):** ✅ Simplest implementation. ✅ No conditional logic. ⚠️ Wastes tokens on solo-MC scenes with no dialogue. ⚠️ Slightly higher latency on token-limited providers.
- **Option B (Conditional include):** ✅ Token-efficient — no dialogue rules when there's no dialogue. ⚠️ Requires checking `charactersPresent` before prompt construction. ⚠️ Edge case: MC talks to themselves (internal dialogue) — still needs rules.
- **Option C (Cache in system prompt):** ✅ Gemini's explicit caching means the rules are only sent once. ⚠️ Other providers re-send every time. ⚠️ Doesn't save tokens on non-Gemini providers.
- **Option D (Separate turn):** ✅ Only Turn A (prose) gets dialogue rules. ⚠️ Multi-turn architecture complexity. ⚠️ Dialogue attribution must happen in Turn A anyway.

**Recommendation: Option A (Always include) for initial implementation, then optimize to Option B.** The token cost is negligible (~300 tokens = ~1% of even the smallest context window). Premature optimization here adds conditional logic that must be tested across all generation paths. Once the feature is stable, measure actual dialogue frequency and optimize if needed. Gemini caching (Option C) is free to add alongside.

---

### ⏳ OQ-5: Marker Visibility to Readers

**What:** Should `[character_id]` markers be visible to readers in the current implementation, or should the frontend immediately hide them?

**Why it matters:** If markers are visible, readers see technical IDs like `[tom_m]` — ugly but functional. If hidden, the frontend must parse and replace them before rendering, which requires frontend work.

#### Options

| Option | Reader Experience | Frontend Effort | Backend Effort |
|--------|-------------------|-----------------|----------------|
| A: Show raw markers | Readers see `[tom_m] "Hello."` | None | None |
| B: Replace with names | Readers see `Mara "Hello."` | Low — regex replace | None |
| C: Avatar UI | Readers see `[avatar] Mara "Hello."` | High — new component | None |
| D: Hide entirely | Readers see `"Hello."` (no attribution) | Low — strip regex | None |

**Pros & Cons:**

- **Option A (Show raw):** ✅ Zero frontend work. ✅ Useful for debugging. ⚠️ Ugly — readers see technical IDs. ⚠️ Breaks immersion. ⚠️ May confuse readers unfamiliar with the system.
- **Option B (Replace with names):** ✅ Clean reading experience. ✅ Minimal frontend effort (one regex + lookup). ✅ Preserves attribution without technical noise. ⚠️ Loses the gamified "character entity" feel. ⚠️ Recognition level gating needed (don't show real name if MC hasn't learned it).
- **Option C (Avatar UI):** ✅ Full gamified experience — character avatars, popover cards, TTS integration path. ✅ Matches the vision in TODO-gamified-dialogue-chatgpt.md. ⚠️ Significant frontend work (new component, state management, styling). ⚠️ Blocks backend deployment.
- **Option D (Hide entirely):** ✅ Clean prose, no visual changes. ✅ Zero frontend work. ⚠️ Defeats the purpose of the feature. ⚠️ Attribution data exists but is invisible.

**Recommendation: Option B (Replace with names) as the immediate solution, with Option C as a follow-up frontend epic.** The backend should ship with markers in the text regardless — the frontend decides how to render them. Option B is a 30-minute frontend fix that gives readers clean attributed dialogue. Option C is a separate frontend task that can be planned as a visual enhancement epic. The backend work is identical for both.

---

### ⏳ OQ-6: Consecutive Same-Speaker Dialogue Handling

**What:** When the same character speaks multiple consecutive paragraphs, should each paragraph get a marker, or should markers only appear on the first line of a "speech block"?

**Why it matters:** Repeating markers on every paragraph is more parseable but noisier. Grouping reduces visual clutter but complicates the parser.

#### Options

| Option | Format | Parse Complexity | Visual Cleanliness |
|--------|--------|------------------|--------------------|
| A: Repeat every line | `[mara] "First."\n[mara] "Second."` | Low (always matches) | Low (noisy) |
| B: First line only | `[mara] "First."\n"Second."` | Medium (must track speaker state) | High (clean) |
| C: Block delimiter | `[mara]\n"First."\n"Second."\n[/mara]` | Low (explicit delimiters) | Medium (verbose) |

**Pros & Cons:**

- **Option A (Repeat):** ✅ Simplest to parse — every `[id]` is a new dialogue. ✅ No state tracking needed. ⚠️ Visually repetitive. ⚠️ Wastes tokens on repeated IDs.
- **Option B (First line only):** ✅ Cleanest prose. ✅ Standard novel convention (attribution on first speech, then implicit). ⚠️ Parser must track "current speaker" state. ⚠️ Edge case: narrator prose between speech paragraphs breaks the "consecutive" assumption.
- **Option C (Block delimiter):** ✅ Explicit start/end — no ambiguity. ✅ Easy to parse. ⚠️ Verbose — `[/mara]` closing tags are unusual in prose. ⚠️ Looks like HTML/markup, breaks literary feel.

**Recommendation: Option A (Repeat every line) for initial implementation.** The parser simplicity is worth the visual noise. The frontend can easily group consecutive same-speaker markers for display (like the TODO-gamified-dialogue-chatgpt.md suggests). Once the parser is battle-tested, migrate to Option B where the prompt instructs: "For consecutive dialogue from the same speaker, repeat the marker on each paragraph for parsing clarity — the frontend will group them visually." This gives us reliable parsing now and clean prose later.

---

### ⏳ OQ-7: MC Internal Monologue vs Spoken Dialogue

**What:** How should the system distinguish between the MC's internal thoughts and their spoken dialogue? Both are first-person, but only spoken dialogue gets a marker.

**Why it matters:** The prompt must clearly instruct the AI on when to add markers. Confusion here would produce inconsistent attribution.

#### Options

| Option | Behavior | Prompt Complexity | Consistency |
|--------|----------|-------------------|-------------|
| A: No MC markers at all | Never add markers to any MC text | Low | High (simple rule) |
| B: Markers only for spoken | Add `[mc]` only when MC speaks aloud | Medium (must detect "aloud") | Medium (ambiguous cases) |
| C: Different markers | `[mc_thought]` for thoughts, `[mc]` for speech | High (two marker types) | Low (AI confusion risk) |

**Pros & Cons:**

- **Option A (No MC markers):** ✅ Simplest rule — "never mark the MC." ✅ Consistent with first-person narration convention. ⚠️ Loses attribution when MC speaks aloud to others (dialogue scene). ⚠️ Frontend can't distinguish thought vs speech for TTS.
- **Option B (Spoken only):** ✅ Correct attribution for dialogue scenes. ✅ Thoughts remain unmarked (natural reading). ⚠️ AI must detect "aloud" vs "internal" — sometimes ambiguous. ⚠️ Edge case: MC muttering to themselves.
- **Option C (Different markers):** ✅ Full semantic distinction. ⚠️ Two marker types increase AI confusion. ⚠️ More complex parser. ⚠️ Frontend must handle both types.

**Recommendation: Option B (Spoken only) with explicit prompt instruction.** The prompt should say: "When the MC speaks aloud to another character, add [mc_id] before the dialogue line. Internal thoughts and narration never receive markers." This matches natural reading conventions — readers know who the narrator is, so marking every "I" would be redundant. For TTS purposes later, the frontend can infer "thought" vs "speech" from context (quoted text = speech, unquoted first-person = thought).

---

### ⏳ OQ-8: Integration with Future Note System

**What:** Should dialogue markers interact with the future note system? For example, a future note might say "Mara reveals she knows about the basement" — should the AI be instructed to attribute that revelation dialogue specifically?

**Why it matters:** Future notes are narrative obligations. If a note says "character X reveals Y," the AI needs to know which character to attribute the dialogue to. Currently, future notes don't specify speaker attribution.

#### Options

| Option | Approach | Prompt Complexity | Attribution Accuracy |
|--------|----------|-------------------|---------------------|
| A: Ignore | Future notes don't mention attribution | Low | Low (AI guesses) |
| B: Add speaker hint | Future notes include optional `speakerId` field | Medium | High |
| C: Infer from context | AI infers speaker from note's character references | Low | Medium (usually correct) |

**Pros & Cons:**

- **Option A (Ignore):** ✅ No schema changes. ✅ Works today. ⚠️ AI may attribute the wrong character. ⚠️ Future notes about dialogue events become unreliable.
- **Option B (Add speaker hint):** ✅ Explicit attribution — AI knows exactly who speaks. ⚠️ Schema change to `FutureNote` type. ⚠️ All existing future notes need migration. ⚠️ Some notes aren't dialogue-related.
- **Option C (Infer from context):** ✅ No schema changes. ✅ Usually correct — "Mara reveals..." implies Mara speaks. ⚠️ Ambiguous cases: "The truth comes out" — who says it?

**Recommendation: Option C (Infer) for now, with Option B as a follow-up.** The AI can usually infer the speaker from the future note's language. If attribution errors appear in practice, add an optional `speakerHint` field to `FutureNoteGeneration` (not required, so no migration needed for existing notes).

---

### ⏳ OQ-9: Dialogue Markers in Branching Paths

**What:** When a story branches (multiverse mode), should dialogue markers be consistent across branches? If Mara says "I know" on the main path, and the branch diverges before that point, should the branch also have Mara speaking?

**Why it matters:** Branching creates parallel timelines. Dialogue markers are embedded in the `text` field, which is branch-specific. This is already handled by the page-level generation, but worth considering for prompt consistency.

#### Options

| Option | Behavior | Implementation |
|--------|----------|----------------|
| A: Branch-specific | Each branch generates its own markers independently | Already works — markers are in `text` |
| B: Shared markers | Markers are consistent across branches | Impossible — text diverges |
| C: Marker audit | Post-generation check that markers reference valid characters in branch | Validation step |

**Recommendation: Option A (Branch-specific) is already the natural behavior.** Since markers are embedded in the page text, and each branch generates its own text, markers are inherently branch-specific. No additional work needed. Option C (marker audit) could be a useful validation addition to ensure markers only reference characters present in the scene's `charactersPresent` array.

---

## Related Files

| Status | File | Changes |
|--------|------|---------|
| ✅ | `src/config/story.ts` | Added `SANITY_PHASE_DECAY_MULTIPLIER`, `SANITY_EARLY_PHASE_FLOOR`, `SANITY_MID_PHASE_FLOOR`, `SANITY_MID_PHASE_EARNED_CRASH_TRAUMA`, `MEMORY_INTEGRITY_*_PHASE_FLOOR`, `REALITY_STABILITY_*_PHASE_FLOOR` |
| ✅ | `src/utils/story.ts` | Phase-gated `updateSanity()`; phase-floored `memoryScore`/`stabilityScore` in `updateHiddenState()`; removed dead `getLocalizedStyleConstraints` draft (moved to localized-style.ts) |
| ✅ | `src/utils/prompt.ts` | Phase-aware `formatSanityState()`; `RULES_DIALOGUE_ATTRIBUTION` (+ reserved-word collision guard); `imagePrompt`/`imageImportance` in all 3 output-format templates; `buildPresetSystemPrompt` reverted to static (no `language` param) for prompt-cache efficiency; style constraints moved to `formatNextPageNarrativePrompt`/`buildBookCreationPrompt`; composure/prose alignment bullet added to both review-checklist functions |
| ✅ | `src/types/story.ts` | Enriched `storyPhases` EARLY/MID/LATE narrative-beat text; added `imagePrompt`/`imageImportance` to `StoryScene` |
| ✅ | `src/utils/localized-style.ts` | New file: `getLocalizedStyleConstraints()` — fuller id/es/fr/ja/ko/pt/de coverage than the dead draft it replaces |
| ✅ | `src/utils/dialogue-parser.ts` | New file: `parseDialogueMarkers()`, `stripDialogueMarkers()`, `hasDialogueMarkers()` — regex bugs from this doc's own draft fixed |
| ✅ | `src/utils/page-validation.ts` | Soft warning for missing dialogue markers (`checkDialogueMarkerCoverage`); soft range-check for `imageImportance` |
| ✅ | `src/utils/field-instructions.ts` | Added `imagePrompt`/`imageImportance` field instructions; fixed a pre-existing `[dialogue].` literal that collided with the new marker convention |
| ✅ | `src/utils/characters.ts` | JSDoc note on `formatCharactersForPrompt` explaining why the MC has no `[ID: ...]` tag (ties into the reserved `[mc]` marker) |
| ✅ | `src/schema/story.ts` | `imagePrompt`/`imageImportance` added to `STORY_PAGE_GENERATION_SCHEMA`; `characterId` description now forbids the 13 reserved ActionType words + `mc`/`???` |
| ✅ | `src/schema/db.ts` (Drizzle `pages` table) | Added `imagePrompt` (text) / `imageImportance` (real) columns |
| ✅ | `src/services/book.ts` | `imagePrompt`/`imageImportance` added to the `DBNewPage` insert payload and all 3 independent page mappers (`mapToStoryPage`, `mapToPersistedStoryPage`, `mapToEnrichedPage`) — see Round 2 notes above for why each needed its own fix |
| ✅ (verified, no change needed) | `src/utils/narrative-style.ts` | Confirmed no `sanityState`/composure reference anywhere; `phaseDirectives` text confirmed complementary (not conflicting) with `storyPhases`; this is the file that surfaced the `memoryIntegrity` finding above |
| ✅ (verified, no change needed) | `src/utils/player-profile.ts` | Confirmed pure consumer of `state.memoryIntegrity`/flags; inherits the phase-floor fix automatically; confirmed no sanityState reference |
| ✅ | `docs/architecture/SANITY_STATE_ARCHITECTURE.md` | Updated lifecycle docs and constants table to reflect phase-awareness |
| ✅ | `reader-store.ts` (frontend) | New `dialogueDisplayMode` preference + setter |
| ✅ | `SettingsModal.tsx` (frontend) | New toggle for dialogue display mode |
| ✅ | `dialogue-parser` (frontend, new file) | Client-side marker parsing, mirrors the backend module |
| 🔄 | `StoryText.tsx` / `StoryText.module.css` (frontend) | Pending — marker-aware rendering for both the static and TypeIt animation paths |
| ⏳ | `ReaderPageClient.tsx` (frontend) | Not yet reviewed for whether it already passes what `StoryText.tsx` will need |
| ⚠️ flagged, not changed | `src/services/book.ts`'s `mapToEnrichedPage` | Its `satisfies Record<keyof EnrichedStoryPage, unknown>` check is commented out in the source — recommend re-enabling under `tsc` (couldn't verify safely with only a syntax-only checker in hand) |

---

*Last updated: 2026-09-01*
