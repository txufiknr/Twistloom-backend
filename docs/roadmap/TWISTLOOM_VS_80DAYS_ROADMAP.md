# Twistloom vs. *80 Days* — Competitive Roadmap

**Status:** Implementation in progress. Backend items completed; frontend items deferred.
**Reviews:** `80days-success-roadmap-gemini.md` (Gemini)
**Grounded against:** `types/story.ts`, `story_utils.ts` (`derivePsychologicalProfile`, `updateHiddenState`, `determineOptimalEnding`, `calculateStoryMomentum`), `types/places.ts`

---

## 0. Fact-checking the Gemini doc before building anything on top of it

Gemini's writeup is directionally useful but mixes three different kinds of claims together without distinguishing them: things that are publicly true about *80 Days*, things Twistloom has **already built**, and things that don't exist anywhere in the code you've shared. Worth separating before this becomes a roadmap, since two of its five "advantages" are actually status reports, not opportunities.

| Gemini claim | Reality check |
|---|---|
| *80 Days* is fully pre-written in `ink`, no AI/NLP, deterministic given identical state | Accurate, well-established public history of the game (inkle, written by Meg Jayanth, 2014). No correction needed. |
| **"Deep Psychological Mirroring"** — tie `realityStability` to `momentum`/`sceneType`, target playstyle archetypes like "the_paranoid" | **Already shipped, not a roadmap item.** `updateHiddenState()` already derives `realityStability`/`threatProximity` from `momentumModifier` + `sceneStress`, explicitly *not* page count (`story_utils.ts:1239`: *"Threat is now purely driven by momentum and scene, NOT page count"*). `derivePsychologicalProfile()` already detects `the_paranoid`/`the_risk_taker`/`the_guilty`/`the_avoider`/`the_denier`/`the_explorer` from `flags` + recent `actionsHistory`, and `determineOptimalEnding()` already routes the ending choice through that archetype. Gemini is describing your own architecture back to you as a suggestion. Reframed below as item #1 — not "build this," but "the work is done, now *surface* it to the player," which is genuinely easy and high-value. |
| **"Real-Time Gamified Hooks"** — "the Registry-Driven State Architecture you designed for achievements," progress-gradient badges | **No evidence this exists.** There is no `achievement`, `badge`, or `registry` concept anywhere in `story.ts`, `story_utils.ts`, `character.ts`, or `places.ts`. This looks like Gemini inferring a plausible-sounding system rather than describing something real. Treated below as a genuine net-new build, not an extension of existing infrastructure — see item #5. |
| **"Procedural, Infinite Mapping"** via the "Piggyback Method" | "Piggyback Method" is Gemini's own label, not your terminology — but the underlying claim is half-true and half-already-built. `PlaceMemory`/`PlaceConnection` already form a graph the AI populates dynamically as the story progresses (new places, `travelTime`, `obstacles`, `accessibility` all already in the schema, capped by `MAX_PLACES`/`placesSlot`). What's genuinely missing is a **visual map** — the data model already supports procedural place generation, the gap is presentation. Reframed as item #6. |
| **"Unbound Player Agency"** (free-text actions) | This is the custom-actions system — already has its own dedicated, much more detailed doc (`TWISTLOOM_CUSTOM_ACTIONS_ROADMAP.md`). Referenced, not duplicated, as item #4. |
| **"Seamless Context Transitions"** | Partially already true — `sceneStress`/`sceneType` already drive pacing/grounding effects in `updateHiddenState`. Not significant enough on its own to warrant a dedicated roadmap item; folded into item #1's framing. |
| Closing question: a ticking-clock / consumable-resource mechanic | This is the one fully legitimate, fully net-new idea in the doc, and it's correctly identified as core to *why 80 Days* creates anxiety. Item #7 below. |

**The corrected takeaway:** don't try to out-*80 Days* *80 Days* by copying its genre (travel logistics, money, trains) — psychological horror doesn't want a banking ledger. Beat it at the *principles* it's actually praised for (visible consequence, resource anxiety, an indifferent world, replayability worth talking about) using mechanics that already fit your genre, several of which you've already built and just haven't surfaced.

---

## How to read the impact ratings

These are directional, complexity-weighted estimates for prioritization — not measured data, you don't have A/B test results on a feature that doesn't exist yet. Treat the percentages as "rough order of magnitude effect on engagement/retention/shareability if executed well," not a forecast.

---

## 1. Surface the psychological profile you already compute (EASIEST) ✅ BACKEND DONE

**Backend:** `GET /api/books/:identifier/psychological-profile` — returns archetype, stability, dominant traits, the ending reached, and teasers for what the reader didn't trigger. No AI calls needed: purely templated from already-computed data. Implemented in `src/services/psychological-profile.ts` + route in `books.ts`.

**Complexity:** Low — almost entirely reuses existing data; the only new thing is presentation.
**What's already there:** `PsychologicalProfile` (`archetype`, `stability`, `dominantTraits`, `manipulationAffinity`), `HiddenState.realityStability`, `determineOptimalEnding`'s 3-tier reasoning (`endingPlan` → `profileShift` → base archetype), and the full set of `EndingType`s your engine already supports (`fake_escape`, `loop`, `identity_twist`, `false_reality`, `possession`, `irreversible_loss`, `pyrrhic_victory`, `mental_fabrication`, `ambiguity`, `simulation`).

**What's new:** A post-ending "psychological autopsy" results screen. After the MC reaches an ending, show the reader who they became — their dominant archetype, the traits that drove it, and (the *80 Days*-style hook) a teaser of what they *didn't* trigger ("Your fear stayed low and your curiosity stayed high — you never saw the version of this story where it falls apart"). This is the single cheapest thing on this list with the most leverage, because it turns data you're already computing into the exact kind of "what did YOU get" result screen that drives screenshots and shares (the *80 Days*/Reigns/BuzzFeed-quiz effect).

Implementation is mostly: one new lightweight summary call (or even zero AI calls, purely templated from `psychologicalProfile` + `because` reasoning already returned by `determineOptimalEnding`) plus a results UI. No new state, no new types, no new prompt rules.

**Impact: Major (~15–25% lift on share/replay-intent metrics if it ships well).** This is the highest-leverage-per-engineering-hour item on the list, specifically because the hard part (the psychology engine) is finished.

---

## 2. Make "locked path" consequences visible (EASY) ✅ BACKEND DONE

**Backend:** `GET /api/books/:identifier/locked-paths` — scans story state history to detect when place connections became blocked/destroyed/restricted and when story threads were closed. Returns a timeline of locked-path events. Implemented in `src/services/locked-paths.ts` + route in `books.ts`.

**Complexity:** Low — mostly prompt guidance + a small UI affordance.
**What's already there:** `PlaceAccessibility` already includes `'destroyed'`/`'blocked'`/`'restricted'`, `StoryThread.status` already includes `'closed'`. The schema already supports a choice permanently locking something out — it just isn't narratively/visually *announced* as a loss right now.

**What's new:** When a choice closes off a place or thread, have the page generation explicitly mark the loss as a beat ("You'll never know what was behind that door") rather than letting it pass silently, and surface a small "this path is now closed" indicator in the reader UI on a re-visit attempt. This is *80 Days*' single most-praised design principle — Dubrovnik-instead-of-Rome locking out the entire Italian storyline — and you already have the data model for it; you're just not telling the reader it happened.

**Impact: Moderate–Major (~10–15% lift on perceived agency/replay value).** Costs little, directly targets the exact mechanic critics single out most when praising *80 Days*.

---

## 3. A stylized, obscured tension HUD (EASY–MODERATE) 🚧 FRONTEND ONLY

> Backend data already exists (`momentum`, `injuries[]`, `difficulty`, `hiddenState.realityStability` — all computed every page). The sanity state (Item 7) and world clock (Item 8) also now provide additional data points. Remaining work is frontend visualization only.

**Complexity:** Low–moderate — frontend-heavy, backend data already exists.
**What's already there:** `momentum`, `injuries[]`, `difficulty`, `hiddenState.realityStability` — all computed every page already.

**The tension here:** *80 Days*' anxiety comes from a *visible* dashboard (health bar, bank balance, ticking clock) the player anxiously watches. Twistloom's hidden-state design philosophy deliberately keeps `HiddenState` and exact scores away from the reader — and that's correct, you don't want to leak `realityStability: 0.43` as a literal number, it breaks the unreliable-narrator effect. The fix isn't to expose raw numbers; it's to expose an **abstracted, diegetic** version of the same anxiety: a visible injuries list (already real data, already safe to show), a stylized visual effect that intensifies with momentum (screen vignette, subtle distortion at `slipping`/`broken` reality stability) rather than a number. This gives players something to *watch* — 80 Days' core trick — without compromising the mystery.

**Impact: Major (~10–20% lift on session length/tension perception).** Directly targets 80 Days' most-cited mechanic (visible, anxiety-inducing resource tracking), reframed in a way that doesn't fight your existing hidden-state design.

---

## 4. Custom actions / unbound agency (MODERATE–COMPLEX) ✅ BACKEND DONE

> Types (`ActionSource`, `Action.source`), config, Gates 0–2 service, DB schema (`customActions`, `customActionTemplates`), and both route endpoints (`POST /api/books/:id/pages/:pageId/custom-actions/preview` and `/submit`) were already implemented. Remaining work is frontend integration (StoryActionButton, ConfirmationDialog) and template reuse tiers.

**Complexity:** Moderate–complex — fully scoped in a dedicated companion document (`TWISTLOOM_CUSTOM_ACTIONS_ROADMAP.md`), not duplicated here.
**What's already there:** `ActionType`/`ActionHintType` already include a `'custom'` slot, `getHintGuidanceForAI` already has a case for it — the page-generation layer is already custom-action-ready.

This is Gemini's "Unbound Player Agency" item, and it's the one place free-text input genuinely exceeds anything *80 Days*' fixed A/B/C choices can offer — *80 Days* cannot do this *at all*, by construction (it's pre-written). See the companion roadmap for the full gate architecture, inventory/scene-check rules, and tone-discipline handling.

**Impact: Major (the single largest structural differentiator on this list — not directly comparable to a %, since it's a capability *80 Days* cannot have, not an enhancement to a shared mechanic).**

---

## 5. Achievement / progress-gradient system (MODERATE) ✅ BACKEND DONE

> Fully implemented: types (`src/types/achievements.ts`), config registry (`src/config/achievements.ts` with 24 badge definitions), evaluation service (`src/services/achievements.ts` with auto-award), DB schema (`userCounters`, `userAchievements` tables), and route endpoints (`GET /api/user/achievements` + `POST /api/user/achievements/acknowledge`).

**Complexity:** Moderate — genuinely net-new (no existing registry, per §0's fact-check). New types, new DB tables, new frontend badge UI.
**What's already there:** Nothing directly — this is the one item on the list that needs to be built from scratch, not extended.

**What's new:** A lightweight achievement table keyed to existing signals you already compute — ending types reached, archetypes triggered, thread-resolution patterns, momentum peaks — so the *content* is mostly free (you already generate the underlying events), only the *tracking/display* layer is new. "Locked Progress Gradients" (Gemini's framing: grayed-out badges showing fractional progress, e.g. "2/6 endings discovered") is a legitimate, well-tested engagement loop independent of *80 Days* specifically — it's the same mechanic behind most replayable narrative games' completion-percentage hooks.

**Impact: Moderate (~5–10% lift on long-term retention/replay count).** Worth doing, but it's the most generic item here — it's a good engagement mechanic, not a Twistloom-specific differentiator the way items 1, 3, and 4 are.

---

## 6. Interactive place-graph map visualization (MODERATE–COMPLEX) 🚧 FRONTEND ONLY

> Backend data already exists (`PlaceMemory` + `PlaceConnection` form a real graph). Locked paths (Item 2) now also track which connections became blocked. Remaining work is frontend visualization only.

**Complexity:** Moderate–complex, but **backend-light** — the data this needs already exists (`PlaceMemory` + `PlaceConnection` form a real graph with `travelTime`, `accessibility`, `obstacles`). The complexity is almost entirely a frontend visualization problem: a force-directed or manually-laid-out graph of visited/known places and their connections, updating as the AI introduces new locations.

**Why it matters:** *80 Days*' animated world map with the travel line tracing across it is one of its most iconic, instantly-recognizable assets — it's most players' first screenshot. Twistloom's psychological horror setting won't want a literal world map, but a stylized "memory map" of explored locations (fragmenting/distorting visually as `realityStability` degrades — tying back into item #3's tension framing) gives you an equivalent "wow, look at this" marketing asset that the underlying data already supports.

**Impact: Major (~10–15% lift on marketing/first-impression conversion, harder to quantify on retention).** High visual payoff for what is mostly a frontend build, since the backend graph already exists.

---

## 7. A horror-themed "ticking clock" / consumable resource mechanic (COMPLEX) ✅ BACKEND DONE

**Backend:** `SanityState` type (composure 0–100, maxComposure, decayRate, hasCrashed), `updateSanity()` function in `story.ts`, and integration into `advanceStoryState()`. Sanity decays under sustained critical momentum (not fixed page count), is amplified by threat proximity and trauma, and can force crisis outcomes on depletion. Persisted in `storyStates.sanityState` JSONB column. Exposed automatically via page API through the story state.

**Complexity:** High — new state fields, decay logic mirroring your existing `Injury.decayPerPage` pattern, new prompt rules, and (the hard part) integration with the ending system so resource depletion can actually force a bad ending rather than just being flavor text.
**What's already there:** The decay pattern itself isn't new — `decayInjuries()` already implements page-based decay for injury severity, which is the right template to extend rather than invent.

**What's new:** This is Gemini's closing question, and it's the one genuinely missing piece from the *80 Days* comparison — Twistloom currently has no equivalent to money/health/time pressure the reader actively manages. Frame it in horror terms rather than logistics terms to fit the genre: composure/sanity that decays under sustained `critical` momentum and is spent (deliberately, by the reader) to resist `realityStability` collapse, or a literal countdown ("they're getting closer") tied to `threatProximity` that the reader can see ticking. The key design risk: a *literal* fixed-page countdown fights your variable-pacing AI generation (a strict turn-based timer assumes predictable page-to-page progress, which your momentum-smoothed, AI-paced system deliberately doesn't guarantee) — so this needs to be threat-proximity-driven and momentum-aware rather than a hard page-count timer, which is exactly the kind of system `updateHiddenState` already computes the inputs for.

**Impact: Major (~15–25% lift on tension/session engagement if executed well) — but high implementation risk if the clock fights the AI's variable pacing instead of being derived from it.** This is the highest-reward, highest-risk item that isn't also the hardest engineering lift (that's #8).

---

## 8. NPC schedules / "the world doesn't wait" time-of-day system (HARDEST) ✅ BACKEND DONE (LIGHTWEIGHT)

**Backend:** `CharacterSchedule` type (availability window, location, missed consequence), `WorldClock` type (timeOfDay, calendarDate, hoursElapsed, totalDaysElapsed), `updateWorldClock()` function in `story.ts` that advances time based on scene type, and integration into `advanceStoryState()`. NPC schedule is exposed on `CharacterMemory.schedule` and available via the page API. The world clock advances naturally through the story and can be used by the frontend to show time-of-day transitions and schedule-based character availability.

**Complexity:** Highest on this list — requires new character/place schedule fields, prompt logic to enforce them, UI to communicate them, and the same variable-AI-pacing risk as item #7 but compounded across every character instead of one global clock.
**What's already there:** `PastInteraction` tracks *that* something happened at a page, not *when* in an in-fiction timeline; there's no existing time-of-day or schedule concept to extend.

**What's new:** Characters with availability windows ("the night-shift guard leaves at dawn") that lapse if the reader dawdles, reinforcing the "world is indifferent to you" feeling *80 Days*' train schedules create. This is conceptually the deepest match to *80 Days*' "clockwork world," but it's also the item most likely to fight your branching, AI-paced architecture — a missed-train mechanic only works if the world's clock and the reader's page-count stay in lockstep, which is much easier to guarantee in *80 Days*' fully pre-written `ink` graph than in a system where the AI is generating variable-length scenes on the fly.

**Impact: Moderate (~5–15%, wide range reflecting execution risk) — recommend treating this as a research spike before committing, not a committed roadmap item.** Everything above it on this list has a clearer cost/benefit; this one's payoff is real but uncertain enough that it shouldn't be scheduled until items 1–7 are shipped and you have actual engagement data to decide whether the juice is worth the squeeze.

---

## Summary table

| # | Item | Complexity | Impact (rough) | Backend status | Frontend status |
|---|---|---|---|---|---|
| 1 | Surface psychological profile (results screen) | Easiest | Major (~15–25%) | ✅ Done — API endpoint | 🚧 Planned — Item 1 in [FRONTEND PLAN](../twistloom-web/docs/roadmap/FRONTEND_80DAYS_IMPLEMENTATION_PLAN.md) |
| 2 | Visible "locked path" consequences | Easy | Moderate–Major (~10–15%) | ✅ Done — API endpoint | 🚧 Planned — Item 3 in [FRONTEND PLAN](../twistloom-web/docs/roadmap/FRONTEND_80DAYS_IMPLEMENTATION_PLAN.md) |
| 3 | Stylized tension HUD | Easy–Moderate | Major (~10–20%) | ✅ Data exists (sanity, momentum, injuries) | 🚧 Planned — Item 2 in [FRONTEND PLAN](../twistloom-web/docs/roadmap/FRONTEND_80DAYS_IMPLEMENTATION_PLAN.md) |
| 4 | Custom actions | Moderate–Complex | Major (structural, not %) | ✅ Done — types, config, gates, DB, routes | 🚧 Planned — Item 5 in [FRONTEND PLAN](../twistloom-web/docs/roadmap/FRONTEND_80DAYS_IMPLEMENTATION_PLAN.md) |
| 5 | Achievements/progress gradients | Moderate | Moderate (~5–10%) | ✅ Done — types, registry, service, DB, routes | 🚧 Planned — Item 4 in [FRONTEND PLAN](../twistloom-web/docs/roadmap/FRONTEND_80DAYS_IMPLEMENTATION_PLAN.md) |
| 6 | Interactive place map | Moderate–Complex | Major (~10–15%) | ✅ Data exists (PlaceMemory + PlaceConnection graph) | 🚧 Planned — Item 7 in [FRONTEND PLAN](../twistloom-web/docs/roadmap/FRONTEND_80DAYS_IMPLEMENTATION_PLAN.md) |
| 7 | Sanity/clock resource mechanic | Complex | Major (~15–25%, high risk) | ✅ Done — SanityState, updateSanity, DB persistence | 🚧 Planned — Item 6 in [FRONTEND PLAN](../twistloom-web/docs/roadmap/FRONTEND_80DAYS_IMPLEMENTATION_PLAN.md) |
| 8 | NPC schedules / world clock | Hardest | Moderate (~5–15%, high risk) | ✅ Done — CharacterSchedule, WorldClock, updateWorldClock | 🚧 Planned — Item 8 in [FRONTEND PLAN](../twistloom-web/docs/roadmap/FRONTEND_80DAYS_IMPLEMENTATION_PLAN.md) |

Items 1–3 are the standout move here: they're the cheapest things on the list *and* among the highest-impact, because the engine work is already done — Twistloom built a more sophisticated psychological-tracking system than *80 Days* has months before this comparison ever came up, it's just invisible to the reader right now.

---

## Frontend implementation

A detailed, step-by-step implementation plan covering all 8 items (frontend only) is available at:
[`twistloom-web/docs/roadmap/FRONTEND_80DAYS_IMPLEMENTATION_PLAN.md`](../twistloom-web/docs/roadmap/FRONTEND_80DAYS_IMPLEMENTATION_PLAN.md)

**Priority order** (by impact ÷ complexity):
1. Surface psychological profile (results screen)
2. Stylized tension HUD  
3. Visible "locked path" consequences
4. Achievements / progress gradients
5. Custom actions integration
6. Sanity display polish
7. Interactive place map
8. NPC schedules / world clock
