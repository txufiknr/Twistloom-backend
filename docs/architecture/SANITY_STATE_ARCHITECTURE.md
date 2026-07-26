# Sanity State Architecture

## Overview

`StoryState.sanityState` is the **reader-facing composure resource** — a horror-themed ticking clock analogous to HP or money in systems like *80 Days*. It answers one question only:

> How much composure does the reader have left before psychological crisis?

It is **engine-owned** (never AI-authored), **momentum- and threat-driven** (not a fixed page timer), and **distinct** from every other psychological field on `StoryState`.

This document is the source of truth for:

- What `sanityState` is and is not
- How it differs from `memoryIntegrity`, `psychologicalProfile`, and `hiddenState`
- Where values are defined, mutated, persisted, and consumed
- Crisis / ending integration
- Naming: why `StyleInput.memoryClarity` is not called “sanity”

---

## Core Philosophy

Twistloom tracks several “how broken is the MC / world?” signals. They look similar in English but live on **different layers** with different consumers:

```
┌─────────────────────────────────────────────────────────────────┐
│ READER RESOURCE (game HUD)                                      │
│   sanityState.composure 0–100                                   │
│   Question: How much composure is left before crisis?           │
│   Consumers: UI HUD, crisis endings, AI pressure guidance       │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ MC DISCRETE FLAGS (AI + engine)                                 │
│   flags: trust / fear / guilt / curiosity (low|medium|high)     │
│   Question: What is the MC feeling right now?                   │
│   Consumers: prompts, danger scoring, bleed instructions        │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ MEMORY RELIABILITY (narrative truth of recall)                  │
│   memoryIntegrity: stable | fragmented | corrupted              │
│   Question: How accurately does the MC remember?                │
│   Consumers: prompts, RULES_ROUTE_MEMORY, health mental score,  │
│              StyleInput.memoryClarity (prose engine)            │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ BEHAVIORAL PROFILE (who the player "is")                        │
│   psychologicalProfile: archetype, stability, traits, affinity  │
│   Question: What kind of person is emerging from choices?       │
│   Consumers: prompts, action tendency, ending advice,           │
│              future-note stability triggers                     │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ HIDDEN NARRATIVE DIALS (steer AI, not player-facing)            │
│   hiddenState.truthLevel / threatProximity / realityStability   │
│   + endingPlan / profileShift / worldClock                      │
│   Question: How should the story secretly behave?               │
│   Consumers: prompts (formatHiddenState), danger, flag mods     │
└─────────────────────────────────────────────────────────────────┘
```

**Rule of thumb**

| If you need… | Use |
|---|---|
| A bar the reader can see / feel as a resource | `sanityState` |
| Unreliable narration / false memories | `memoryIntegrity` |
| Prose texture (fragmentation, clarity) | `StyleInput.memoryClarity` ← from `memoryIntegrity` |
| “Who is this player becoming?” | `psychologicalProfile` |
| World/physics breaking | `hiddenState.realityStability` |
| Immediate emotion | `flags` |

---

## Type Definition

```typescript
// src/types/story.ts
export type SanityState = {
  /** Current composure 0–100. At 0 the reader is in crisis. */
  composure: number;
  /**
   * Maximum composure (starts at 100). Permanently reduced by accumulated
   * trauma tags so recovery never fully restores pre-trauma capacity.
   */
  maxComposure: number;
  /** Base decay per page when momentum is critical (default ~5). */
  decayRate: number;
  /** Whether composure has hit 0 at least once this story. Sticky. */
  hasCrashed: boolean;
  /** Page number when composure first hit 0 (ending / crisis forcing). */
  crashedAtPage?: number;
};
```

Defaults live in `src/schema/story.ts` as `SANITY_STATE_DEFAULTS` and are included in `STORY_STATE_DEFAULTS`.

Tuning constants live in `src/config/story.ts`:

| Constant | Default | Role |
|---|---|---|
| `SANITY_DEFAULT_MAX_COMPOSURE` | 100 | Starting / absolute max |
| `SANITY_DEFAULT_DECAY_RATE` | 5 | Full decay on `critical` momentum |
| `SANITY_TRAUMA_MAX_PENALTY` | 5 | Permanent max loss per trauma tag |
| `SANITY_MIN_MAX_COMPOSURE` | 40 | Floor for maxComposure |
| `SANITY_RESOLUTION_RECOVERY` | 3 | Heal on `resolution` momentum |
| `SANITY_REALITY_RESIST_COST` | 15 | Cost for `spendComposureToResistReality` |
| `SANITY_CRITICAL_THRESHOLD` | 25 | Prompt “critical” band helper |

---

## Lifecycle

### 1. Initialization

- New stories: `createEmptyStoryState` / book creation spreads `STORY_STATE_DEFAULTS` → full `sanityState`.
- Old rows without the column: `ensureSanityState` / `updateSanity` lazy-init defaults; `mapStoryStateFromDb` maps `null` → `undefined` then engine re-inits on advance.

### 2. Mutation (only path)

Called from `advanceStoryState` **after** `updateHiddenState` (so threat proximity is fresh):

```
advanceStoryState
  → updateFlags
  → updateHiddenState        // threatProximity, memoryIntegrity, realityStability, …
  → updateSanity             // composure decay / recovery / crash flag
  → applySanityCrisisEffects // one-shot dials + arm ending on crash page
  → updatePsychologicalProfile
  → updateAdvancedEndingSystems
```

#### `updateSanity(state, context)`

1. Ensure object exists; sync `maxComposure` from trauma count.
2. If already crashed → force `composure = 0` and return (no recovery).
3. Decay from **previous page’s** `momentum` in `NarrativeContext`:
   - `critical` → full `decayRate`
   - `rising` → half `decayRate`
   - `building` / `resolution` → 0 decay
4. Amplify by `hiddenState.threatProximity` (`immediate` ×1.5, `near` ×1.2).
5. Extra +1 decay per 3 trauma tags this page.
6. On `resolution` momentum → +`SANITY_RESOLUTION_RECOVERY` (capped at max).
7. First time composure ≤ 0 → `hasCrashed = true`, `crashedAtPage = state.page`.

#### `applySanityCrisisEffects(state)`

On the **crash page only** (`crashedAtPage === page`):

- Step `memoryIntegrity` toward `corrupted`
- Step `realityStability` toward `broken`
- Step `threatProximity` toward `immediate`
- Bump `difficulty` one tier

Every page while crashed (if needed):

- Arm `hiddenState.endingPlan` with `type: 'unreliable_reality'` if none armed

#### `spendComposureToResistReality(state, cost?)`

Optional reader action (future UI). Spends composure to walk `realityStability` one step toward `stable`. Returns `false` if crashed or insufficient composure.

### 3. Persistence

| Path | Behavior |
|---|---|
| DB column | `story_states.sanity_state` JSONB (`src/db/schema.ts`) |
| `insertStoryState` | Writes `sanityState` on insert + conflict update |
| `mapStoryStateFromDb` | Reads `sanityState` into domain state |
| `StateDelta.sanityState` | Full snapshot after advance (engine-owned) |
| `calculatePsychologicalDeltas` | Diffs base vs new; includes `sanityState` when changed |
| `applyStateDelta` | Applies full snapshot when present; else keeps base |

Reconstruction (`applyDeltaChain` / parent-chain / branch traversal) does **not** re-run `advanceStoryState`. Composure is restored from:

1. Snapshot’s stored `sanityState`, then
2. Per-page `stateDelta.sanityState` written at generation time

---

## StateDelta design decision (keep `sanityState` on the delta)

**Recommendation implemented: keep `StateDelta.sanityState` as a full post-advance snapshot.**

### Problem

Live generation always has a full `StoryState` in memory after `advanceStoryState`, and `insertStoryState` persists `sanity_state` on the page’s `story_states` row. That is enough **when** a full row exists for the target page.

Reconstruction often does **not** load every page’s full row:

```
find nearest story_states snapshot (e.g. page 30)
  → applyDeltaChain(pages 31…40)   // only page.stateDelta — no advanceStoryState
  → result for page 40
```

`cleanupStoryStatesWithStrategy` may delete intermediate full-state rows. If composure lived only on `story_states` and never on the page delta, rebuild would freeze composure at the snapshot’s value (e.g. page 30’s bar on page 40).

### Why the delta field (same pattern as other engine psych fields)

| Layer | Authored by | On AI schema? | On `StateDelta`? |
|---|---|---|---|
| Characters, places, flags, … | AI | Yes (`StateDeltaGeneration`) | Yes |
| Profile / hidden / memoryIntegrity / difficulty | Engine | **No** | Yes (`PsychologicalStateDelta`) |
| `sanityState` | Engine (`updateSanity`) | **No** | Yes (full snapshot) |

Reconstruction is **apply-only**. Engine progression that happens in `advanceStoryState` must therefore be **recorded** on each page’s delta at generation time (`calculatePsychologicalDeltas` → merge into `fullStateDelta`), then **replayed** via `applyStateDelta`.

### Why a full snapshot (not a partial patch)

`SanityState` is a small fixed object (`composure`, `maxComposure`, `decayRate`, `hasCrashed`, `crashedAtPage`). Storing the whole post-advance value:

- Guarantees exact restore (no merge bugs)
- Matches “record what the live path computed”
- Avoids re-deriving decay from incomplete history

Profile/hidden still use partial field patches for size; composure does not need that optimization.

### Rejected alternatives

| Alternative | Why not |
|---|---|
| Rely only on full `story_states` rows | Breaks when cleanup drops intermediate snapshots; reconstruction is delta-based by design. |
| Re-simulate `updateSanity` during reconstruction | Fragile: needs prior momentum, threat, trauma timeline; can diverge from live values; duplicates engine logic in two paths. |
| Omit from delta and accept freeze | Incorrect HUD / crisis state after any sparse reconstruct. |

### Contract for implementers

1. **Live path:** `advanceStoryState` mutates `state.sanityState` → after AI apply, `calculatePsychologicalDeltas` copies a full snapshot onto the page delta when it changed.
2. **Persist path:** `insertStoryState` still writes `sanity_state` on the full row (fast load by `pageId`).
3. **Reconstruct path:** `applyStateDelta` / `applyDeltaChain` **only** apply stored `stateDelta.sanityState` — never call `updateSanity`.
4. **AI path:** schemas use `StateDeltaGeneration`, which omits `PsychologicalStateDelta` (including `sanityState`).

### 4. Consumption

| Consumer | How |
|---|---|
| AI prompt (`formatNextPageNarrativePrompt`) | `formatSanityState` under **COMPOSURE** block |
| `RULES_ROUTE_MEMORY` | Text guidance for high/low/crashed composure |
| Ending systems | Crash arms `endingPlan`; may force `fakeToReal` sooner |
| Frontend (planned) | HUD bar from page/story state API |
| Narrative Style Engine | **Does not** use `sanityState` — uses `memoryClarity` |

---

## Naming: `memoryClarity` vs “sanity”

Historically `StyleInput` had a field named `sanity` that was **always** derived from `memoryIntegrity`. That collided with the new reader resource.

**Rename (current):**

```typescript
// StyleInput — prose engine only
memoryClarity: number; // 0–1 from memoryIntegrity
// StoryState — game resource
sanityState: SanityState; // composure 0–100
```

| Name | Source | Meaning |
|---|---|---|
| `StyleInput.memoryClarity` | `memoryIntegrity` | How clear should narration sound? |
| `StoryState.memoryIntegrity` | `updateHiddenState` | Recall reliability enum |
| `StoryState.sanityState.composure` | `updateSanity` | Reader resource meter |

Do **not** feed composure into the style engine. Composure is pressure/crisis; memory clarity is unreliable-narrator texture. Mixing them makes low-HP pages always read as “insane prose” even when the story wants cold, clear panic.

---

## Pairwise Differences (Non-Redundancy)

| A | B | Same? | Difference |
|---|---|---|---|
| `sanityState` | `memoryIntegrity` | No | Resource meter vs recall reliability |
| `sanityState` | `psychologicalProfile.stability` | No | HUD bar vs discrete behavioral lens for AI tactics |
| `sanityState` | `hiddenState.realityStability` | No (by design) | Resource can be **spent** to resist world break; world dial is hidden |
| `memoryIntegrity` | `profile.stability` | Partial overlap | Memory axis vs general psych coherence; both can be low independently |
| `profile.stability` | `realityStability` | Related | Mind lens vs world rules; profile reads broken reality as +instability |
| `flags.fear` | all above | No | Immediate emotion, not a bar or world dial |

---

## Why Not a Fixed Page Timer?

AI scene length and momentum are variable. A strict “N pages until doom” fights that pacing. Composure instead:

- Decays only under `rising` / `critical` momentum
- Amplifies when `threatProximity` is near/immediate
- Recovers slightly on `resolution`
- Shrinks max capacity with trauma (permanent scar)

This reuses signals `updateHiddenState` already computes.

---

## Data Flow (Complete)

```
User picks action on page N
        │
        ▼
advanceStoryState(state, actionedPage)
  ├── updateFlags(action)              → flags
  ├── updateHiddenState(context)       → hiddenState, memoryIntegrity, difficulty
  ├── updateSanity(context)            → sanityState ★ primary writer
  ├── applySanityCrisisEffects()       → dials + endingPlan on crash
  ├── updatePsychologicalProfile(...)  → psychologicalProfile
  └── updateAdvancedEndingSystems()    → endingPlan / profileShift
        │
        ▼
AI generates page
  ├── createNarrativeStyle → memoryClarity from memoryIntegrity
  ├── formatPsychologicalFlags + memoryIntegrity
  ├── formatSanityState (composure pressure) ★
  ├── formatPsychologicalProfile
  └── formatHiddenState
        │
        ▼
extractStateDelta (AI creative fields only — no sanityState)
applyStateDelta (advanced state already holds live composure)
calculatePsychologicalDeltas → if composure changed, full sanityState snapshot on delta ★
        │
        ▼
page.stateDelta stored (for reconstruction) + insertStoryState (full row) ★

Later reconstruction (no advanceStoryState):
  snapshot.sanityState → apply each page.stateDelta.sanityState → exact bar
```

---

## API / Frontend Contract

Reader page responses expose a **reader-safe** slice on `EnrichedStoryPageContext.sanityState`
(`EnrichedSanityState` — omits `decayRate`):

```json
{
  "context": {
    "healthStatus": { "condition": "injured", "healthPercent": 72, "…": "…" },
    "sanityState": {
      "composure": 68,
      "maxComposure": 90,
      "hasCrashed": false
    }
  }
}
```

Wired in `mapToEnrichedPage` (`src/services/book.ts`). Full engine `SanityState`
(including `decayRate`) remains on `story_states` for reconstruction.

**UI contract (frontend)**

- Dual-rail HUD: physical HP + composure (`ReaderPageInfo` / `SingleHealthBar`).
- Popover: four injury axes under Status; composure under Resource (`n/max`).
- On `hasCrashed`, crisis label + no fake recovery.
- **Do not** derive composure from `realityStability` or `mentalPercent`.

See Twistloom-web `docs/architecture/HEALTH_SYSTEM_ARCHITECTURE.md`.

Never invent composure client-side; always trust server state after each action.

---

## Incomplete / Future Work

| Item | Status |
|---|---|
| Type + defaults | Done |
| Decay / trauma max / recovery | Done |
| Persist + map from DB | Done |
| StateDelta + reconstruction | Done |
| Prompt surface | Done |
| Crash → ending pressure | Done |
| `StyleInput.sanity` → `memoryClarity` | Done |
| Reader UI HUD | Frontend |
| Explicit “spend composure” player action | Backend helper ready; route/UI TBD |
| Achievements on crash / survival | Optional |

---

## Related Files

| File | Role |
|---|---|
| `src/types/story.ts` | `SanityState`, `StyleInput.memoryClarity`, `StateDelta.sanityState` |
| `src/schema/story.ts` | `SANITY_STATE_DEFAULTS`, `STORY_STATE_DEFAULTS` |
| `src/config/story.ts` | Tuning constants |
| `src/utils/story.ts` | `updateSanity`, `applySanityCrisisEffects`, `spendComposureToResistReality`, deltas |
| `src/utils/player-profile.ts` | `createStyleInput` → `memoryClarity` |
| `src/utils/narrative-style.ts` | Prose engine consumes `memoryClarity` |
| `src/utils/prompt.ts` | `formatSanityState`, route-memory rules |
| `src/services/story.ts` | `insertStoryState`, `mapStoryStateFromDb` |
| `src/db/schema.ts` | `story_states.sanity_state` column |
| `docs/roadmap/TWISTLOOM_VS_80DAYS_ROADMAP.md` | Product rationale (item 7) |

---

## Anti-Patterns

1. **Do not** set `StyleInput.memoryClarity` from `sanityState.composure`.
2. **Do not** let the AI author `sanityState` in JSON schemas — engine-only.
3. **Do not** re-run full `advanceStoryState` / `updateSanity` during reconstruction; apply stored `stateDelta.sanityState` snapshots only.
4. **Do not** remove `StateDelta.sanityState` “because insertStoryState already persists it” — cleanup + delta reconstruction need both.
5. **Do not** escalate crisis dials every page after crash (only on crash page).
6. **Do not** treat low composure as automatic “write gibberish” — use prompt pressure bands; keep prose legible.

---

*Last updated with the complete backend implementation of the composure resource, crisis integration, persistence, prompt surface, and `memoryClarity` rename.*
