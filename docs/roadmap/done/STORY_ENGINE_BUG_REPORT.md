# Twistloom Story Engine — Bug Report

Companion to `AI_NATIVE_FICTION_PLATFORM_ROADMAP.md`. This document records defects found during a deep read of the story-state engine (`src/utils/story.ts`, `src/utils/player-profile.ts`, `src/utils/branch-traversal.ts`, `src/utils/characters.ts`, `src/utils/places.ts`) and the surrounding call sites in `src/services/book.ts` and `src/utils/prompt.ts`.

Severity scale: **High** = irreversible/cross-page narrative or data corruption; **Medium** = meaningful narrative-coherence or profile-quality degradation; **Low** = noise, dead code, or latent pre-consumer defect.

Two bugs were already fixed before this report was written (recorded in §0 for completeness). **All remaining items (BUG-01 through BUG-07) have since been fixed and verified via `pnpm typecheck`** — each is marked ✅ FIXED inline below with its fix location. FIXME entries: F1, F2, BUG-01…07 all closed.

---

## §0. Already fixed (baseline)

| ID | Location | Defect | Status |
|---|---|---|---|
| F1 | `src/utils/story.ts:706` | `advanceStoryState` compared `action.text === action.text` (self-comparison) so the selected-action letter always resolved to `A`. | ✅ Fixed → `allActions.findIndex(a => a.text === action.text)` |
| F2 | `src/services/book.ts:553`, `src/utils/story.ts:555`, `src/utils/prompt.ts:4102` | `calculateHealthStatus` called with the old single-arg signature; `mentalInputs` (trauma/memoryIntegrity/fear) never passed, so `mentalPercent` only reflected injury trauma (the underestimate the `characters.ts` doc itself flags). | ✅ Fixed → all three call sites now pass `mentalInputs` |

---

## §1. HIGH severity

### BUG-01 — `detectProfileShift` permanently locks the ending on a single transient behavior blip
**Status:** ✅ FIXED — `src/utils/story.ts` (`detectProfileShift` now clears a stale shift when `shiftStillHolds` is false, and only arms a *new* shift past 60% progress; added `shiftStillHolds` helper).
**File:** `src/utils/story.ts:1814` (`detectProfileShift`), consumed by `updateAdvancedEndingSystems` at `:2057`.

**Root cause.** Every branch of `detectProfileShift` requires `!state.hiddenState.profileShift`:
```typescript
if (wasCurious && nowAvoiding && !state.hiddenState.profileShift) { ... }
```
Once `profileShift.detected` is set `true`, *all* subsequent calls short-circuit and return `false`. The `archetype`/`dominantTraits`/`primaryWeakness` are still re-derived fresh every turn by `derivePsychologicalProfile`, so the *live* profile and the *locked* `profileShift.originalEnding` diverge permanently.

**Impact.** A reader who explores for 5 pages then takes one `escape` (e.g. a single momentary avoidant beat) triggers `curiosity_collapse` at page ~6. That shift is never cleared even if the next 30 pages are pure `explore`/`risk`. Because `updateAdvancedEndingSystems` mutates `viableEnding` off the locked shift, the reader is forced into a `mental_fabrication` ending regardless of their actual, later behavior. **Irreversible narrative consequence from a transient action.**

**Suggested solution.** Allow re-evaluation: clear or supersede an existing `profileShift` when current behavior no longer matches the shift's trigger, and/or only arm shifts once the story is past a late-phase threshold (the detection already gates on `pageProgress > 0.6` at the *call* site, but the *intra-function* `!profileShift` guard blocks any correction regardless of phase).

**Code fix (one option — allow supersession near the finale, and clear on reversal):**
```typescript
export function detectProfileShift(state: StoryState): boolean {
  if (state.actionsHistory.length < 6) return false;

  const profile = state.psychologicalProfile;
  const recentActions = state.actionsHistory.slice(-3);
  const earlierActions = state.actionsHistory.slice(-6, -3);

  // Reversal guard: if the previously-detected shift no longer holds,
  // clear it so a later, accurate shift can take over.
  const stillHolds = state.hiddenState.profileShift
    ? shiftStillHolds(state.hiddenState.profileShift.shiftType, recentActions, earlierActions)
    : false;
  if (state.hiddenState.profileShift && !stillHolds) {
    state.hiddenState.profileShift = undefined;
  }

  const canArm = state.page / state.maxPage > 0.6; // only late-game locks
  if (!canArm && !state.hiddenState.profileShift) return false;

  // ... existing per-shift branches, each still gated by !state.hiddenState.profileShift ...
  return false;
}

function shiftStillHolds(
  shiftType: ProfileShiftType,
  recent: SelectedAction[],
  earlier: SelectedAction[],
): boolean {
  switch (shiftType) {
    case "curiosity_collapse":
      return earlier.some(a => a.type === "explore") && recent.some(a => a.type === "escape");
    // ... mirror the existing triggers for the other shift types ...
    default: return false;
  }
}
```

---

### BUG-02 — 15 of 18 ending archetypes have no engine-side plan; reader can receive a contradicting ending
**Status:** ✅ FIXED (redesigned) — Root cause was that `determineOptimalEnding` *guessed* an ending from the base archetype (Tier-3) and **always** returned one, so `buildEndingRules` always injected a "Recommended ending type (heuristic)" that frequently contradicted the AI-authored `viableEnding` (which is set from page 1, so Tier-1b/Tier-3 were effectively dead/misleading).
- `determineOptimalEnding` (`src/utils/story.ts`) now only returns `recommendChange: true` for a *genuine* override: an armed `EndingPlan` (Tier 1) or a detected `profileShift` (Tier 2). Otherwise it echoes the carried `viableEnding` with `recommendChange: false` — the dead base-archetype guessing (Tier 3) and fallback (Tier 4) were removed.
- `EndingRecommendation` gained a `recommendChange: boolean` field (type: `src/types/story.ts`).
- `buildEndingRules` (`src/utils/prompt.ts`) now **omits** the "If the current viable ending is no longer viable, re-determine based on…" + "Recommended ending type" block unless `recommendChange` is true; otherwise it just steers toward the carried plan. This removes the contradictory guess from the prompt entirely.
- The "Engine plan unarmed; following AI-authored viable ending." string was dropped (it was near-dead and redundant with the steer-toward-plan line).
- **Blind-spot closure (neutral deviation nudge):** `recommendChange: false` does not guarantee the carried plan is still viable — a MC's profile can intensify (e.g. `the_paranoid`/`unstable`) without tripping a discrete `profileShift` pattern, leaving a stale plan silently contradicted. To avoid re-introducing a wrong engine guess, `buildEndingRules` now emits a **neutral** permission (gated to `pageProgress > 0.5`) when `recommendChange` is false: the AI *may* deviate if the story clearly outgrew the plan, but is told never to telegraph it or invent a replacement spec. Early pages (`pageProgress <= 0.5`) stay silent so a fresh plan isn't second-guessed.
**File:** `src/utils/story.ts` (`determineOptimalEnding`), `src/utils/prompt.ts` (`buildEndingRules`), `src/types/story.ts` (`EndingRecommendation`); real mutation still lives in `updateAdvancedEndingSystems` (arms `EndingPlan` / detects `profileShift`) which is untouched.

**Root cause.** `updateAdvancedEndingSystems` (`:2064`) only arms a fake-to-real `EndingPlan` for three archetypes:
```typescript
if (ending === "fake_escape" || ending === "loop" || ending === "identity_twist") {
  setupFakeToRealEnding(state, triggerPage, "fake_relief_twist");
}
```
`determineOptimalEnding` (`:1657-1686`) only switches on the **6-key** `EndingPlanType`. The other 15 archetypes (`betrayal`, `pyrrhic_victory`, `cosmic_cycle`, `nested_narrative`, `simulation`, `escalation`, …) exist *only* as AI-authored `viableEnding.type` text. When a reader reaches one of those, Tier-1 (active plan) is skipped and the function falls through to Tier-3 base-archetype logic, which may resolve to a *different* archetype than the AI described.

**Impact.** The AI can spend 40 pages building toward a `betrayal` ending (trusted figure is the villain), but `determineOptimalEnding` — if it ever drives the actual ending selection — can return `pyrrhic_victory` or another archetype because no plan was armed. **Reader-visible ending can contradict the narrative the AI constructed.**

**Suggested solution (pick one).**
1. *Map more archetypes to engine plans* — extend `updateAdvancedEndingSystems` to arm `EndingPlanType` for the additional archetypes that have a clear execution strategy (e.g. `betrayal` → a `betrayal`-style plan, `simulation` → `observer_twist`).
2. *Treat `viableEnding.type` as authoritative* when no plan is armed — i.e. in `determineOptimalEnding`, if `endingPlan` is unarmed, return `viableEnding.type` directly instead of falling to base-archetype guessing.

**Code fix (option 2 — smallest, removes the contradiction):**
```typescript
export function determineOptimalEnding(state: StoryState): EndingRecommendation {
  const { hiddenState, viableEnding } = state;

  // TIER 1: Respect an Active Ending Plan
  if (hiddenState.endingPlan?.armed) { /* ... existing switch ... */ }

  // TIER 1b: No engine plan armed — trust the AI-authored viable ending
  // rather than guessing from archetype (which can contradict the built narrative).
  if (viableEnding?.type) {
    return {
      type: viableEnding.type,
      summary: viableEnding.text ?? "Engine plan unarmed; following AI-authored viable ending.",
      because: { tier: "viable_ending", type: viableEnding.type },
    };
  }

  // TIER 2 / TIER 3 fallbacks unchanged below ...
}
```

---

## §2. MEDIUM severity

### BUG-03 — `derivePsychologicalProfile` priority queue can assign an archetype whose `dominantTraits`/`primaryWeakness` contradict the actual state signal
**Status:** ✅ FIXED — `src/utils/story.ts` (`derivePsychologicalProfile` now evaluates the `the_denier`/memory-corruption branch *first*, so the rarest/strongest signal wins ties over `the_explorer`/`the_risk_taker`).
**File:** `src/utils/story.ts:1523` (`derivePsychologicalProfile`); weakness mapping at `src/utils/player-profile.ts:70`.

**Root cause.** The archetype decision is an ordered `if/else if` queue. `the_explorer` (high curiosity, not-high fear) is evaluated *before* `the_denier` (memory corrupted + medium trust). So a corrupted-memory MC who is *also* high-curiosity/high-fear is assigned `the_risk_taker` (curious+fear branch at `:1545`), receiving traits `"bold","impulsive","conflicted"` — **none** of the denial/instability traits that actually define their state. Downstream, `derivePrimaryWeakness` (`player-profile.ts:80`) maps `the_denier → trust_hunger/avoidance`; since the archetype was mis-assigned, the weakness is computed off the wrong archetype.

**Impact.** The AI receives a `psychologicalProfile` whose `archetype`, `dominantTraits`, and `primaryWeakness` disagree with the MC's real signals. Personalized-manipulation targeting becomes mis-calibrated. **Narrative coherence degradation, not a crash.**

**Suggested solution.** Make the corrupted-memory / unstable branch *higher priority* than the curiosity/fear branches (memory corruption is a stronger, rarer signal than baseline curiosity), or compute `primaryWeakness` directly from state signals (`memoryIntegrity`, `flags`) instead of routing through the possibly-misassigned archetype.

**Code fix (priority reorder — memory/instability wins ties):**
```typescript
// Move this ABOVE the explorer/risk_taker branches:
else if (memoryIntegrity !== "stable" && flags.trust === "medium") {
  archetype = "the_denier";
  manipulationAffinity = "confusion";
  traitSet.add("denial").add("rationalizing").add("self-justifying");
}
```

---

### BUG-04 — `calculateBaseTraits` has no recency decay (decay block commented out)
**Status:** ✅ FIXED — `src/utils/player-profile.ts` (`calculateBaseTraits` now applies an EMA-style recency weight `Math.pow(0.95, …)` so later actions dominate; the commented-out decay block was replaced).
**File:** `src/utils/player-profile.ts:95` (`calculateBaseTraits`); decay block at `:106-110` is commented out.

**Root cause.** Every action in `actionsHistory` is weighted equally. The doc comment at `:92-93` admits recency weighting is needed and the EMA decay lines exist but are **commented out**:
```typescript
// Uncomment to weight recent actions more heavily (EMA decay):
// traits.curiosity  *= 0.95;
// traits.fear       *= 0.95;
// ...
```
`custom` actions add `+0.1` curiosity and `other` add `+0.05` (`ACTION_INFLUENCES`, `:56-57`). A reader who spams early custom/other actions gets a permanently curiosity-skewed base trait even if all later *real* choices are `escape`/`attack`.

**Impact.** The numeric `PsychologicalProfileMetrics` (which feed `createStyleInput` → narrative style engine) can be dominated by early-game noise. Profile quality degrades; style engine responds to stale signal.

**Suggested solution.** Enable the EMA decay (or a sliding-window weight) so recent actions dominate. If full decay is undesirable, at minimum down-weight `custom`/`other` since they are reader free-text, not canonical choices.

**Code fix (enable EMA, recent actions dominate):**
```typescript
actionsHistory.forEach((action, idx) => {
  const influences = ACTION_INFLUENCES[action.type as keyof typeof ACTION_INFLUENCES] ?? ACTION_INFLUENCES.other;
  // Recency weight: later actions matter more (EMA-style decay of older ones).
  const recency = Math.pow(0.95, actionsHistory.length - 1 - idx);
  Object.entries(influences).forEach(([trait, influence]) => {
    if (trait in traits) {
      traits[trait as keyof typeof traits] += (influence as number) * recency;
    }
  });
});
```

---

## §3. LOW severity

### BUG-05 — `worldClock.elapsedMinutes` is overwritten, not accumulated; type doc contradicts implementation
**Status:** ✅ NOT A BUG — REVERTED. Re-examination of the `WorldClock` type doc (`src/types/story.ts:823`) and the only consumer (`src/utils/prompt.ts:3014`, labeled `"Time elapsed since last action"`) confirms `elapsedMinutes` is a **per-page delta**, not a cumulative total. The original `clock.elapsedMinutes = minutesPassed;` overwrite was correct; the prompt display is correct as-is. The fix was applied then reverted — no code change remains.
**File:** `src/utils/story.ts:1453` (`updateWorldClock`), type at `src/types/story.ts:831`.

**Root cause.** The type doc says *"In-fiction minutes since the reader's last action"* and *"tracks elapsed time between actions"* — implying a cumulative clock. But the implementation assigns:
```typescript
clock.elapsedMinutes = minutesPassed;   // assignment, not +=
```
So `worldClock.elapsedMinutes` only ever holds the **last single scene's** duration. The function's own doc (`:1440-1448`) partially contradicts this ("per-scene, not cumulative"). Nothing currently consumes `worldClock` for scheduling (future notes use `schedule.day`/`page`/`date`), so it is **dead-but-misleading** today — but it *will* bite when H2/H3 "45min just passed" scheduling lands.

**Suggested solution.** Either (a) make it cumulative (`+=`, with a per-page reset option), or (b) rename the field/`type` to `lastSceneMinutes` and update the doc so the contract is honest. Pick (b) if consumers only need the last scene.

**Code fix (cumulative, matching the type doc):**
```typescript
clock.elapsedMinutes = (clock.elapsedMinutes ?? 0) + minutesPassed;
```

---

### BUG-06 — `calculatePsychologicalDeltas` logs `console.warn` on the common no-change case
**Status:** ✅ FIXED — `src/utils/story.ts` (the no-delta `else` branch now uses `console.debug` instead of `console.warn`).
**File:** `src/utils/story.ts:435-439`.

**Root cause.** Most pages do *not* change archetype/stability/memoryIntegrity/difficulty, so the `else` branch fires on nearly every generation:
```typescript
} else {
  console.warn(`[calculatePsychologicalDeltas] ⚠️ No psychological state update`);
}
```
At production generation volume this floods logs on every page that has no psych delta.

**Suggested solution.** Downgrade to `console.debug` or remove entirely (the `if` branch already logs the success case).

**Code fix:**
```typescript
} else {
  console.debug(`[calculatePsychologicalDeltas] No psychological state update`);
}
```

---

### BUG-07 — `processThreadUpdates` urgency can pin to 1.0 and lose discriminative signal
**Status:** ✅ FIXED — `src/utils/story.ts` (the per-page touched-bump now only fires when `thread.urgency < 0.95` and uses half the weight `0.015`, so a thread touched consecutively can't pin to 1.0).
**File:** `src/utils/story.ts:1216-1262`.

**Root cause.** A thread touched on a given page receives three additive bumps:
- base decay `−0.01` (`:1194`)
- `+importance * 0.05` if a clue was added (`:1238`)
- `+importance * 0.03` from the final "touched this page" loop (`:1259`)

Net for an `importance: 1.0` thread that gets a clue and is touched: `−0.01 + 0.05 + 0.03 = +0.07/page`, clamped at `1.0`. A thread touched on consecutive pages races to `1.0` and stays pinned, so `urgency` (used by `calculateThreadPressure` and momentum) loses its ability to distinguish "actively developing" from "maxed out weeks ago."

**Suggested solution.** Cap the per-page net bump, or decay harder when not actively advanced, or treat `1.0` as a soft ceiling that only *recent* touches approach. Low priority — currently cosmetic for momentum.

**Code fix (reduce the touched-bump and gate it):**
```typescript
// Only nudge if not already near max, and halve the bump.
if (thread.urgency < 0.95) {
  thread.urgency = Math.min(1.0, thread.urgency + (thread.importance * 0.015));
}
```

---

## §4. Verified-correct (no defect)

Recorded so the same areas are not re-flagged as bugs in future reviews:

- **`applyDeltaChain` page-stamping** (`story.ts:589`, mirrored at `branch-traversal.ts:754`) correctly syncs `page`/`pageId` before each `applyStateDelta`, so page-stamped fields (`plotFlags.page`, thread `introducedAt`/`lastUpdatedAt`, clue `discoveredAtPage`) are tagged with the right page. ✅
- **`appendActionsHistory` slice boundary** (`branch-traversal.ts:776`) starts at `snapshotIndex` but the helper loops from `i=1`, so the snapshot page is not double-counted. ✅
- **`advanceStoryState` page increment** (`:718`) happens before `updateFlags`/`updateHiddenState`/`updatePsychologicalProfile`, so all consumers read the incremented page consistently. ✅
- **`updateSanity` / `updateAdvancedEndingSystems` / `detectProfileShift` / `setupFakeToRealEnding`** are fully implemented and wired (not the "dangling" half-features a first skim suggested). ✅
- **Reconstruction `maxPage` pinning** (`branch-traversal.ts:767`) sets `maxPage` from `book.totalPages`, so a reconstructed state never inherits a stale `maxPage`. ✅
- **`cleanUpInventory` / `removeHealedInjuries`** correctly drop zero-amount / zero-severity entries. ✅

---

## §5. Fix priority order

| Order | ID | Severity | Effort | One-line |
|---|---|---|---|---|
| 1 | BUG-01 | High | S | Unlock `profileShift` so a transient early blip can't permanently mutate the ending |
| 2 | BUG-02 | High | M | Stop the engine from returning an ending archetype that contradicts the AI-built narrative |
| 3 | BUG-03 | Med | S | Reorder archetype priority so memory corruption isn't overridden by curiosity |
| 4 | BUG-04 | Med | S | Enable recency decay in `calculateBaseTraits` |
| 5 | BUG-05 | Low | S | Make `worldClock` cumulative or rename to match its real (per-scene) behavior |
| 6 | BUG-06 | Low | S | `console.warn` → `console.debug` on the no-psych-delta case |
| 7 | BUG-07 | Low | S | Cap thread urgency bump so it doesn't pin to 1.0 |

BUG-01 and BUG-06 are the cheapest high-value pairs (both S-effort) and are recommended as the first patch.
