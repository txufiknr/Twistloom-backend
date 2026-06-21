# Twistloom Custom Actions System — Implementation Roadmap

**Status:** Design doc, ready for phased implementation
**Supersedes:** `TWISTLOOM_CUSTOM_ACTIONS_SYSTEM.md` (ChatGPT draft)
**Grounded against:** `types/story.ts`, `types/character.ts`, `types/places.ts`, `prompt.ts` (current next-page generation pipeline)

---

## 0. How this differs from the ChatGPT draft

The original draft is a solid generic design for *any* branching-fiction product. It wasn't written against your actual schema, so it invents a parallel context model (`genre`, `worldRules: string[]`, `availableTechnology`, `availableMagicSystems`, `viableEndings: string[]`, `activeMysteries`, `activeConflicts`) that doesn't exist in Twistloom and would duplicate state you already track in a richer form.

| ChatGPT draft assumed | Twistloom actually has | Implication |
|---|---|---|
| `genre: string` per story | Fixed genre baked into `PROMPT_SYSTEM` (psychological thriller/horror) | No genre field needed in validation context at all |
| `worldRules: string[]` | `factsHistory` (typed `world`/`location`/`organization`), `RULES_STORY_CONSISTENCY`, place/character memory | Derive "world rules" from existing facts, not a new free-text array |
| `viableEndings: string[]` (plural) | `state.viableEnding: Ending` — **one** planned ending at a time, set dynamically, often `undefined` early-story | Ending-alignment check is single-target and must degrade gracefully when no ending is set yet |
| `activeMysteries` + `activeConflicts` (two arrays) | Unified `state.threads: StoryThread[]` (`priority`, `status`, `urgency`, `clues`, `truth`) | One bypass check against threads, not two |
| `availableTechnology` / `availableMagicSystems` | Doesn't exist — Twistloom is grounded psychological horror, not systems-magic fiction | Drop these fields; physical plausibility is judged from places/characters/inventory instead |
| `accessiblePlaces: string[]` (flat) | `state.places: Record<string, PlaceMemory>` with `knownConnections[].accessibility` (`open/blocked/dangerous/restricted/unknown/destroyed`) | Far richer signal already exists — use it directly |
| New `ActionType`/intent system | `actionTypes` **already includes `"custom"`**, and `actionHintTypes` **already includes `"custom"`**, with a dedicated case in `getHintGuidanceForAI()` already written for it | You half-built this already. See §1. |
| 3 sequential LLM calls (safety classifier → compatibility → ending alignment) | You already run a single evaluator pass per page (`buildNextPageEvaluatorPrompt`) and a multi-provider waterfall tuned for cost/quota discipline | Consolidate into **one** structured-output call (§3) |
| Generic `SharedAction` community pool keyed by `genre`/`storyType` | Every place/character/thread ID is book-specific; nothing reuses across stories without heavy abstraction | Reframe community reuse as per-book first, cross-book templates later (§9) |

Everything below is written against your real types and your real prompt-building functions, with file/function names matching your existing conventions so this can be implemented as drop-in additions rather than a parallel system.

---

## 1. Critical finding: your schema already has a slot for this

You don't need to invent an "intent canonicalization" concept — it already exists, just unused for reader input.

```ts
// types/story.ts — already shipped
export const actionTypes = {
  // ...
  "custom": "Custom prompt from reader",
  "other": "Catch-all for uncategorized actions"
};

export const actionHintTypes = [
  "dark_discovery", "relationship_revelation", "betrayal", "confrontation",
  "truth_revelation", "survival", "psychological", "custom", "none",
] as const;
```

```ts
// prompt.ts:1668 — already shipped, already handles hint.type === 'custom'
function getHintGuidanceForAI(hintType: ActionHintType): string {
  switch (hintType) {
    // ...
    case "custom": return "Reader provided unique direction. Honor their creative intent "
      + "while maintaining narrative consistency. Weave their suggestion naturally into "
      + "the story's existing themes and character development, avoiding abrupt tonal "
      + "shifts or plot contradictions.";
    // ...
  }
}
```

This means the **page-generation layer is already custom-action-ready**. `buildNextPageFieldInstructions`, `formatActionChoices`, `formatPreviousPageEntry`, `appendActionsHistory` — none of them need to change. The entire build is really just:

> **One validation/canonicalization service that produces a conforming `Action` object, sitting in front of a pipeline that already knows what to do with it.**

That reframes scope dramatically versus the original 4-layer-pipeline-plus-storage-plus-pricing description.

---

## 2. Revised architecture

```text
Reader submits custom action text
        │
        ▼
┌──────────────────────────────┐
│ Gate 0 — Eligibility          │  deterministic, no AI, <5ms
│ (credits, rate limit, phase)  │
└──────────────────────────────┘
        │ pass
        ▼
┌──────────────────────────────┐
│ Gate 1 — Security Filter      │  deterministic regex/denylist, no AI
└──────────────────────────────┘
        │ pass
        ▼
┌──────────────────────────────────────────────┐
│ Gate 2 — Consolidated AI Interpreter           │  ONE structured-output call
│  • content safety                              │  (replaces draft's Layers 2+3+4)
│  • story compatibility (plausibility)          │
│  • ending/thread bypass check                  │
│  • intent canonicalization                     │
│  • action-type + hint-type classification      │
└──────────────────────────────────────────────┘
        │ allowed
        ▼
Construct canonical `Action` object
        │
        ▼
Existing `buildNextPagePrompt` / page-generation pipeline (UNCHANGED)
        │
        ▼
Persist via existing `appendActionsHistory` + new `custom_actions` audit row
        │
        ▼
(optional, later phase) promote to per-book / cross-book template pool
```

Four conceptual layers from the draft collapse into two real gates plus one AI call. This matters for your stack specifically: every extra AI call is another hop through the waterfall, another quota line in `rpmo`, another retry/timeout surface, and added latency on something a paying user is sitting and waiting on.

---

## 3. Gate 0 — Eligibility, rate limiting, credits

Not in the original draft (it jumped straight to security), but it's the cheapest filter you have and it's where abuse economics actually get decided.

Checks, in order, all synchronous/Redis-backed:

1. **Story phase gate.** During `isFinale` (entropy collapse), block custom actions outright, or silently downgrade them to "blend into nearest generated action" rather than running the full pipeline. The finale is deliberately narrowing choice toward a single orchestrated ending (`RULES_ACTIONS` → `ENTROPY COLLAPSE SYSTEM`); an unconstrained reader-authored action fighting that narrowing is the single highest-risk moment for this feature to break narrative integrity. **Recommend: disabled in finale, v1.** Revisit only after you trust Gate 2's ending-alignment accuracy.
2. **Credit balance check** against `useUser.ts` — fail fast with the existing insufficient-credits UX before spending anything.
3. **Per-user, per-book rate limit** via Upstash Redis (you already lean on Redis for this kind of thing) — e.g. max N custom-action attempts per page, max N per hour account-wide. This is your actual defense against jailbreak-probing loops, not the security regex.
4. **Per-page cooldown**, separate from per-user — prevents one page becoming a community-pool spam target if/when Phase 5 (template reuse) ships.

```ts
// config/custom-actions.ts
export const CUSTOM_ACTION_CREDIT_COST = 3;
export const CUSTOM_ACTION_MAX_ATTEMPTS_PER_PAGE = 3;      // free retries on rejection, see §13
export const CUSTOM_ACTION_RATE_LIMIT_PER_HOUR = 10;
export const CUSTOM_ACTION_DISABLED_PHASES: StoryPhase[] = ['FINALE'];
```

---

## 4. Gate 1 — Deterministic security filter

Keep the draft's core idea (regex denylist, no LLM), but harden it and don't leak it.

```ts
// config/custom-actions.ts
export const CUSTOM_ACTION_SECURITY_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  /reveal\s+.*(prompt|system|instructions)/i,
  /show\s+.*(system\s*prompt|hidden\s*state|raw\s*json)/i,
  /you\s+are\s+now/i,
  /pretend\s+(you('re|\s+are)|to\s+be)/i,
  /\b(assistant|system|developer)\s*:/i,
  /<\s*(system|assistant|developer)\s*>/i,
  /print\s+(the\s+)?(story\s*)?state/i,
  /reveal\s+(the\s+)?(hidden|viable)\s+ending/i,
] as const;

export const CUSTOM_ACTION_DENYLIST_KEYWORDS: string[] = [
  // explicit sexual / hate / self-harm / illegal seed terms — heuristic first pass only
];

export const MIN_CUSTOM_ACTION_CHARS = 3;
export const MAX_CUSTOM_ACTION_CHARS = 200;
```

Three additions worth making over the draft's version:

- **Normalize before matching.** Run `text.normalize('NFKC')` and strip zero-width characters (`\u200B-\u200D\uFEFF`) before testing patterns — trivial unicode tricks otherwise bypass every regex here.
- **Don't return the matched pattern to the client.** The draft's `SecurityValidationResult.reasons` includes `Matched ${pattern}` — fine server-side for logs, never surface that string to the UI. It teaches people exactly how to route around your filter. Map internally to a generic category (`'injection_attempt' | 'length' | 'denylist'`) and show the user one bland message regardless of which rule fired (see §11).
- **This is also where length validation lives** (`MIN/MAX_CUSTOM_ACTION_CHARS`), so you never pay an AI call for a 1-character or 2,000-character submission.

```ts
export interface CustomActionSecurityResult {
  passed: boolean;
  category?: 'injection_attempt' | 'denylist' | 'length' | 'empty';
}
```

---

## 5. Gate 2 — Consolidated AI interpreter

This is the one new AI call, and it's deliberately built to mirror your existing `buildNextPageEvaluatorPrompt` / `executePromptForJSON` pattern rather than introduce a new calling convention.

### 5.1 Context builder — reuse, don't reinvent

Every input field the draft's `ActionValidationContext`/`EndingAlignmentContext` wants already has a formatter in `prompt.ts`. Build a **slimmed-down** version of the same context you already assemble for `formatNextPageStoryContextPrompt`, dropping anything write-oriented (field-instructions, scoring rubric) since this call only judges, never writes prose.

```ts
// services/custom-actions.ts
function buildCustomActionValidationContext(state: StoryState, currentPage: ActionedStoryPage | UserStoryPage): string {
  const stateInfo = getStoryStateInfo(state);

  return `CURRENT SCENE:
${formatCurrentSituationForPrompt(currentPage, state)}

ACCESSIBLE PLACES & CONNECTIONS:
${formatAccessiblePlacesForValidation(state)}   // new, thin wrapper — see below

CURRENT FACTS:
${formatCurrentFacts(state.factsHistory)}

${formatThreadsPrompt(state.threads, stateInfo)}   // reused as-is, read-only context here

${formatEndingPrompt(state)}   // reused as-is — single viableEnding, may be "No ending plan yet."

STORY PHASE:
${stateInfo.phase} — ${stateInfo.phaseGoal}`;
}
```

`formatAccessiblePlacesForValidation` is the one genuinely new formatter, and it's small — it just projects `state.places` + each place's `knownConnections[].accessibility/obstacles` into a compact list, which is strictly more useful than the draft's flat `accessiblePlaces: string[]` because it tells the model *why* a place is or isn't reachable right now:

```ts
function formatAccessiblePlacesForValidation(state: StoryState): string {
  const current = state.places[/* currentPlaceId from currentPage */];
  const reachable = current?.knownConnections
    ?.filter(c => c.accessibility !== 'blocked' && c.accessibility !== 'destroyed')
    .map(c => `  · ${state.places[c.targetId]?.knownName ?? c.targetId} (${c.accessibility ?? 'unknown'}${c.obstacles.length ? `, obstacles: ${c.obstacles.join(', ')}` : ''})`)
    .join('\n') ?? '  None known.';

  return `- Current location: ${current?.knownName ?? 'unknown'} (${current?.type ?? 'unknown'})\n- Known reachable places:\n${reachable}`;
}
```

Notice what's missing from this list versus the draft: `genre`, `worldRules: string[]`, `availableTechnology`, `availableMagicSystems`. None of them map to anything you track, and inventing them would mean maintaining a second, parallel, hand-authored "world bible" that's guaranteed to drift from `factsHistory`/`places`/`characters` over time. Drop them.

### 5.2 Output schema & types

```ts
// types/custom-action.ts
export type CustomActionRejectionCategory =
  | 'content_policy'      // Layer "Safety" from the draft
  | 'implausible'         // physical/character/resource implausibility
  | 'world_inconsistent'  // violates established facts/places
  | 'bypasses_thread'     // skips a mystery/conflict instead of engaging it
  | 'bypasses_ending';    // jumps straight to/around the planned ending

export interface CustomActionValidationResult {
  allowed: boolean;
  rejectionCategory?: CustomActionRejectionCategory;
  /** Internal-only reasoning, never shown verbatim to the reader. */
  reasons: string[];

  /** 0–1, how plausible attempting this is given current state. */
  plausibilityScore: number;
  /** 0–1, how much this preserves rather than skips story progression. */
  progressionScore: number;

  /** 3–8 word canonical intent, replaces the draft's separate "canonicalization" prompt. */
  interpretedIntent: string;

  /** Best-fit classification — reuses your existing unions, see §6 for why this matters. */
  actionType: ActionType;
  hintType: ActionHintType;
}
```

One AI call now does what the draft split across three (`SafetyValidationResult`, `StoryCompatibilityResult`, `EndingAlignmentResult`) plus the separate canonicalization prompt. Cheaper, lower latency, and — importantly for narrative consistency — a single model pass judging plausibility *and* ending-bypass *and* classification together is less likely to produce contradictory verdicts (e.g. "plausible" from one call but "bypasses ending" from another, with no shared reasoning) than three independent calls would be.

### 5.3 Model selection

You already distinguish `AI_CHAT_MODELS_WRITING` (the expensive, quality-tuned prose model) from `AI_CHAT_MODELS_THEME` (a lighter tier used for the book-creation-prompt generator). This call belongs firmly in the **light tier**, not the writing tier — it's classification + short-text generation, not prose:

```ts
// services/custom-actions.ts
async function validateCustomAction(
  text: string,
  state: StoryState,
  currentPage: ActionedStoryPage | UserStoryPage,
): Promise<CustomActionValidationResult> {
  const userPrompt = buildCustomActionValidationPrompt(text, state, currentPage); // see Appendix

  const options = createAIOptionsWithSchema<CustomActionValidationResult>({
    schemaDefinition: CUSTOM_ACTION_VALIDATION_SCHEMA_DEFINITION,
    requiredFields: CUSTOM_ACTION_VALIDATION_REQUIRED_FIELDS,
  });

  const response = await aiPrompt<CustomActionValidationResult>(userPrompt, {
    ...options,
    modelSelection: AI_CHAT_MODELS_THEME,   // not AI_CHAT_MODELS_WRITING
    context: 'custom-action-validation',     // distinct context tag for rpmo quota tracking
    config: { ...AI_CHAT_CONFIG_DEFAULT, maxOutputToken: 400 },
  });

  return response.result;
}
```

This also means the existing `ai-parser.ts` nine-stage repair pipeline and your monthly `rpmo` tracking pick this call up for free — no new JSON-repair or quota code needed, you just feed it through the same `aiPrompt` you already trust.

Given that this call sits in the critical path of a button press (the reader is waiting), it's also the strongest candidate in your whole waterfall for routing to your **lowest-latency** providers first (Groq/Cerebras) rather than strict cost-floor ordering — worth a dedicated waterfall priority list distinct from the one `AI_CHAT_MODELS_WRITING` uses, since writing-quality tier-ordering optimizes for prose quality first, and this call needs to optimize for time-to-first-token first.

### 5.4 Graceful degradation when there's no ending yet

The draft's `EndingAlignmentContext.viableEndings` assumes an ending always exists. In Twistloom, `state.viableEnding` is frequently `undefined` in the early phase (`formatEndingPrompt` already returns `"No ending plan yet."` for this case). The validation prompt must instruct the model explicitly: **if no ending plan exists yet, skip the `bypasses_ending` check entirely** — don't let the model invent an ending to check against, and don't let it default to either always-pass or always-fail on a check that's structurally inapplicable.

---

## 6. Canonical Action construction — and a decision point

Mapping `CustomActionValidationResult` → `Action` raises a real design fork worth deciding deliberately rather than defaulting into.

**Option A — set `Action.type = 'custom'` directly.** Simplest. Flags the action's provenance inline, but every downstream consumer that branches on `ActionType` for signal (most notably whatever powers `RULES_ROUTE_MEMORY`'s "psychological profile built from decision patterns" and any `calculatePsychologicalDeltas` logic keyed off action category) loses resolution for every custom action a reader submits. Given the JSDoc on `actionTypes` literally says *"these categorize player actions to determine psychological impact"*, this is a real loss of signal — and your highest-engagement, highest-LTV readers (the ones paying credits for custom actions) are exactly the ones whose profile data you'd be flattening.

**Option B — classify into the real `ActionType` (`explore`/`escape`/`social`/`risk`/etc.) and track provenance separately.** Gate 2 already classifies `actionType` as part of its structured output (§5.2) — that classification *is* the real category, not a fallback. Add one small additive field to track source instead of overloading `type`:

```ts
// types/story.ts — additive, non-breaking
export type Action = {
  text: string;
  type: ActionType;
  hint: ActionHint;
  destinationPageIds?: string[];
  /** NEW — provenance for analytics/UI, independent of narrative category. */
  source?: 'ai' | 'custom' | 'community';
};
```

**Recommendation: Option B.** It costs one optional field, preserves every existing psychological-profile and route-memory signal, and still gives you the "show a different icon for reader-submitted choices" UI hook the draft wanted from `type: 'custom'` in the first place — just via `source` instead of overloading the category field.

`hint.type`, by contrast, should be classified properly regardless of which option you pick for `Action.type` — `getHintGuidanceForAI('custom')`'s generic fallback text ("Honor their creative intent…") is noticeably less specific than what `truth_revelation`, `betrayal`, `confrontation` etc. give the writer model. Gate 2 should almost always be able to pick a better-fitting hint type than the generic fallback; reserve `'custom'`/`'none'` for genuine edge cases.

```ts
function buildCanonicalAction(
  originalText: string,
  result: CustomActionValidationResult,
): Action {
  return {
    text: originalText.trim().slice(0, MAX_CUSTOM_ACTION_CHARS),
    type: result.actionType,           // Option B: real category, not 'custom'
    hint: { text: result.interpretedIntent, type: result.hintType },
    destinationPageIds: [],            // no pre-generated candidates for custom actions, see §7
    source: 'custom',
  };
}
```

---

## 7. Hooking into page generation — and why most of it needs zero changes

Once `buildCanonicalAction` produces a conforming `Action`, it becomes `actionedPage.action` exactly as if the reader had clicked an AI-generated choice. Every function downstream — `buildNextPageFieldInstructions`, `formatPreviousPageEntry`, `formatSelectedAction`, `formatActionChoices` (for the *next* page's choices, not this one), `appendActionsHistory`, momentum calculation — consumes `Action`/`SelectedAction` shapes that are unaware of provenance. **No changes needed there.**

The one real interplay to flag: your **candidate-generation system** (`ensureCandidatesForPageWithStrategy`, `triggerCandidateGenerationWorkflow`) pre-generates next pages for the AI-curated choices so they load instantly. Custom actions can't be pre-generated — their content doesn't exist until the reader submits it — so a custom-action page generation is **always** a synchronous/on-demand `buildNextPagePrompt` call with real latency, never a cache hit.

You've already built the exact UX primitive this needs: the `ReaderPageClient.tsx` polling pattern for AI-generated candidate pages (TanStack Query polling + the backend `writeChain` serialization + `waitUntil`/`maxDuration=800` architecture). **Reuse that polling path for custom-action-triggered generation rather than building a second one** — the frontend doesn't need to know or care whether it's waiting on a pre-queued candidate or a freshly-triggered custom generation; the polling contract is identical.

---

## 8. Reality-distortion interplay (a genuine Twistloom-specific opportunity)

The draft treats plausibility as a flat pass/fail. Twistloom's narrative engine already has a mechanism for *intentionally* breaking physical plausibility — `HiddenState.realityStability` (`stable → slipping → broken`) and `PsychologicalProfile.stability` (`stable → cracking → unstable`) exist precisely to let the world stop obeying normal rules as the MC's grip loosens.

Worth wiring the plausibility threshold to this rather than using one fixed bar for the whole story:

- `stable` reality + `stable` psychological stability → strict plausibility threshold (close to the draft's "teleporting home" rejection).
- `slipping`/`cracking` → moderate relaxation — "impossible" actions can be *allowed* but the resulting page should lean into ambiguity (is this really happening, or is the MC's perception failing?) rather than treating it as objectively true.
- `broken`/`unstable` → an action like "I teleport home" stops being a plausibility violation and becomes legitimate material for the horror itself — the system is already built to write dream-logic, hallucination, and impossible geometry at this stability level (`stabilityLevels.unstable` description).

Concretely: pass `state.hiddenState.realityStability` and `state.psychologicalProfile.stability` into the Gate 2 context, and instruct the model to scale `plausibilityScore`'s pass threshold accordingly rather than applying one constant. This turns your unique psychological-horror mechanic into a unique custom-actions mechanic too — readers who've pushed the MC toward instability earn *more* narrative freedom, not less, which is a nice thematic payoff most generic IF custom-action systems can't offer.

---

## 9. Reframing "community action storage" for a per-book narrative

The draft's `SharedAction` pool assumes actions generalize across stories via `genre`/`storyType`. They mostly don't in Twistloom — "examine the locked door" only means something relative to *this* book's places, characters, and threads. Treat reuse in two tiers:

**Tier 1 — per-book reuse (do this first).** Within a single book, the same canonical intent ("attempt immediate escape", "search for hidden compartment") recurs naturally across pages. Store every validated submission keyed by book, and when a new submission's `interpretedIntent` is near-duplicate to a prior one *in the same book*, skip re-running Gate 2 and reuse the cached classification — pure cost optimization, no exposure risk since it never leaves the book it came from.

**Tier 2 — cross-book templates (later, optional, Phase 5).** For genuinely portable patterns ("attempt immediate escape" really is generic across nearly every thriller scene), mine a separate curated table offline rather than live-pooling reader submissions. You already have the right tool for this: the **Jaccard-similarity, single-pass `UNION ALL + GROUP BY` CTE** you built for book recommendations is a better fit for canonical-intent deduplication than introducing a pgvector/embeddings dependency into Twistloom — it's lighter-weight, matches infrastructure you already trust, and intent strings are short enough that token-overlap similarity works well. Reserve pgvector-style embedding clustering (your Muslim Digest experience) only if Jaccard similarity proves too coarse once you have real data.

```ts
// types/custom-action.ts
export interface CustomActionTemplate {
  id: string;
  canonicalIntent: string;
  sceneType?: SceneType;
  momentum?: StoryMomentum;
  actionType: ActionType;
  usageCount: number;
  approvalScore: number;   // 0-1, derived from downstream page evaluator scores, not raw popularity
}
```

Note `approvalScore` is deliberately *not* just a popularity counter — feed it from the existing page-quality evaluator (`buildNextPageEvaluatorPrompt`'s `scoreAfter.total`) of the pages these actions actually produced. A custom action that's popular but consistently produces low-scoring pages shouldn't get promoted into a cross-book template.

---

## 10. Credit pricing & frontend integration checklist

The draft's pricing table is a reasonable starting point — keep it as a **configurable constant**, not a hardcoded UI string, since you'll want to tune it:

```ts
// config/custom-actions.ts
export const CUSTOM_ACTION_CREDIT_COST = 3;       // draft's recommendation; A/B-testable
export const EXPANDED_COMMUNITY_ACTION_COST = 1;  // Tier 1 reuse, §9
```

**Charge timing — recommend charging only after Gate 2 passes, not on submission.** A rejected attempt costs you one cheap light-tier AI call; charging a reader credits for an action you then refuse feels punitive and is the fastest way to make this feature feel adversarial rather than empowering. This matches the original doc's own framing ("AI Validation Cost: Included") — keep validation cost absorbed as a platform cost, charge only for the actual page generation that follows a passing validation.

**Free retries.** Pair this with `CUSTOM_ACTION_MAX_ATTEMPTS_PER_PAGE` (§4) — a few free re-attempts per page after rejection, since rejection is often the reader not knowing the world's constraints yet rather than abuse. Cap it so it doesn't become an unlimited free-validation oracle for probing your filters.

**Frontend touchpoints**, mapped to the files you're already mid-review on (I don't have these files' current contents in this session, so treat this as an integration checklist to align against your existing patterns, not literal new code):

- **`StoryActionButton.tsx`** — add a distinct "Write your own" entry point alongside the generated choices, visually marked (icon/credit badge) so it doesn't read as just another generated option.
- **`ConfirmationDialog.tsx`** — natural fit for a two-step flow: (1) lightweight "preview" call returns the canonical intent + cost without charging, (2) confirm → charge → trigger generation. This reuses the exact confirm-then-commit pattern you're already building for credit purchases, just with a different payload.
- **`useUser.ts`** — credit-balance gate before even showing the custom-action entry point (don't invite a submission you'll immediately block on Gate 0).
- **`credit-purchase-store.ts`** — wire the post-validation debit through whatever spend action this store already exposes for other credit-consuming actions; this doc shouldn't be the source of truth for that API shape since I haven't seen the file.
- **`books-api.ts`** — new endpoint call for the validate/submit flow (see §12), but the *generation* call after a custom action passes should be the same action-selection call path used for normal actions, just with the canonical custom `Action` substituted in — don't fork the generation call itself.

---

## 11. Rejection UX — never leak hidden state

The most Twistloom-specific rule in this whole document: your prompt system goes to real lengths to keep `HiddenState`, `viableEnding`, and thread `truth` away from the reader (`RULES_CHARACTER`: *"NEVER reveal hidden character data unless explicitly discovered"*; the whole `HiddenState` type is explicitly *"not directly visible to users"*). A naive rejection message can undo that instantly — e.g. rejecting "I read Lisa's mind" with *"this would bypass the mystery of Lisa's true identity"* just told the reader Lisa's identity **is** the mystery.

Map internal `rejectionCategory` to bland, non-specific reader-facing copy:

| Internal category | Reader-facing message (illustrative tone, not final copy) |
|---|---|
| `content_policy` | "That's not something this story can do." |
| `implausible` | "That doesn't quite fit what's possible right now — try something your character could actually attempt." |
| `world_inconsistent` | "That doesn't match what's true in this story so far." |
| `bypasses_thread` | "That feels like it's skipping ahead — try engaging with what's in front of you." |
| `bypasses_ending` | same copy as `bypasses_thread` — **never differentiate this one in the UI**, since a distinct message for "this would end the story" is itself a tell. |

Same logic from Gate 1: never surface which regex/keyword fired. One generic message for all security-filter rejections.

---

## 12. API surface proposal

Two endpoints, matching the confirm-then-commit UX from §10:

```text
POST /api/books/:bookId/pages/:pageId/custom-actions/preview
  body: { text: string }
  → runs Gate 0 (minus credit charge) + Gate 1 + Gate 2
  → 200: { allowed: true, preview: { canonicalIntent, cost } }
  → 200: { allowed: false, category, message }   // friendly message per §11

POST /api/books/:bookId/pages/:pageId/custom-actions/submit
  body: { text: string, confirmationToken }   // token ties submit to the preview result, prevents re-validation drift
  → re-runs Gate 0 fully (including charge) — do NOT trust the client-held preview result for charging
  → constructs canonical Action, triggers existing page-generation path
  → 202: { nextPageId, polling info }   // same shape your candidate-generation polling already expects
```

The `confirmationToken` matters: between preview and submit, story state could have changed (another branch, a thread closing) — re-validating on submit (cheap, same Gate 2 call) rather than trusting a stale preview avoids a stale-plausibility-check bug class.

---

## 13. Database schema (Drizzle / Neon Postgres)

Illustrative — adapt field/relation names to your existing `schema.ts` conventions; I haven't seen that file's current shape.

```ts
// db/schema/custom-actions.ts
import { pgTable, uuid, text, varchar, real, boolean, integer, timestamp, index } from "drizzle-orm/pg-core";

export const customActions = pgTable("custom_actions", {
  id: uuid("id").defaultRandom().primaryKey(),
  bookId: uuid("book_id").notNull(),
  pageId: uuid("page_id").notNull(),
  userId: uuid("user_id").notNull(),

  originalText: text("original_text").notNull(),
  canonicalIntent: text("canonical_intent"),
  actionType: varchar("action_type", { length: 32 }),
  hintType: varchar("hint_type", { length: 32 }),

  allowed: boolean("allowed").notNull(),
  rejectionCategory: varchar("rejection_category", { length: 32 }),
  plausibilityScore: real("plausibility_score"),
  progressionScore: real("progression_score"),

  creditsCharged: integer("credits_charged").default(0).notNull(),
  nextPageId: uuid("next_page_id"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  bookIdx: index("custom_actions_book_idx").on(table.bookId),
  userIdx: index("custom_actions_user_idx").on(table.userId),
}));

// Tier 2 only — see §9, build after Phase 4 has real usage data
export const customActionTemplates = pgTable("custom_action_templates", {
  id: uuid("id").defaultRandom().primaryKey(),
  canonicalIntent: text("canonical_intent").notNull(),
  sceneType: varchar("scene_type", { length: 32 }),
  momentum: varchar("momentum", { length: 16 }),
  actionType: varchar("action_type", { length: 32 }),
  usageCount: integer("usage_count").default(1).notNull(),
  approvalScore: real("approval_score").default(0.5).notNull(),
  lastUsedAt: timestamp("last_used_at").defaultNow().notNull(),
}, (table) => ({
  sceneMomentumIdx: index("custom_action_templates_scene_momentum_idx").on(table.sceneType, table.momentum),
}));
```

`customActions` doubles as your audit log — store **rejected** attempts too (`allowed: false`), not just successes. This is what threshold-tuning in Phase 4 (§14) will run against.

One logging-hygiene note matching the care you put into this on the auth-debugging work: `originalText` is reader-submitted free text that may occasionally include attempted jailbreak strings or worse. Keep this table access-restricted (not piped into general analytics/BI tooling that has wider read access), and consider whether `originalText` needs to exist at all in your **application logs** (vs. just this restricted table) — the same instinct that led you to fix logging hygiene in the auth flow applies here.

---

## 14. Telemetry & threshold tuning

`plausibilityScore` and `progressionScore` are continuous, not boolean — log them on every attempt (allowed *and* rejected) so you can tune the pass threshold empirically instead of guessing. Suggested v1 thresholds, treat as a starting point:

```ts
export const CUSTOM_ACTION_PLAUSIBILITY_THRESHOLD = 0.5;
export const CUSTOM_ACTION_PROGRESSION_THRESHOLD = 0.5;
```

Watch two failure modes once this ships: false-rejects (annoyed paying readers, visible in support/feedback) and false-allows (a custom action that produces a low `scoreAfter` from your existing page evaluator — this is a free signal you already generate downstream, join it back to the `custom_actions` row that produced the page).

---

## 15. New/modified types — summary diff

```ts
// types/story.ts — additive only, non-breaking
export type Action = {
  text: string;
  type: ActionType;
  hint: ActionHint;
  destinationPageIds?: string[];
  source?: 'ai' | 'custom' | 'community';   // NEW
};
```

```ts
// types/custom-action.ts — new file
export type CustomActionRejectionCategory =
  | 'content_policy' | 'implausible' | 'world_inconsistent'
  | 'bypasses_thread' | 'bypasses_ending';

export interface CustomActionSecurityResult {
  passed: boolean;
  category?: 'injection_attempt' | 'denylist' | 'length' | 'empty';
}

export interface CustomActionValidationResult {
  allowed: boolean;
  rejectionCategory?: CustomActionRejectionCategory;
  reasons: string[];
  plausibilityScore: number;
  progressionScore: number;
  interpretedIntent: string;
  actionType: ActionType;
  hintType: ActionHintType;
}

export interface CustomActionTemplate {
  id: string;
  canonicalIntent: string;
  sceneType?: SceneType;
  momentum?: StoryMomentum;
  actionType: ActionType;
  usageCount: number;
  approvalScore: number;
}
```

```ts
// config/custom-actions.ts — new file
export const MIN_CUSTOM_ACTION_CHARS = 3;
export const MAX_CUSTOM_ACTION_CHARS = 200;
export const CUSTOM_ACTION_CREDIT_COST = 3;
export const EXPANDED_COMMUNITY_ACTION_COST = 1;
export const CUSTOM_ACTION_MAX_ATTEMPTS_PER_PAGE = 3;
export const CUSTOM_ACTION_RATE_LIMIT_PER_HOUR = 10;
export const CUSTOM_ACTION_DISABLED_PHASES: StoryPhase[] = ['FINALE'];
export const CUSTOM_ACTION_PLAUSIBILITY_THRESHOLD = 0.5;
export const CUSTOM_ACTION_PROGRESSION_THRESHOLD = 0.5;
export const CUSTOM_ACTION_SECURITY_PATTERNS = [/* §4 */];
export const CUSTOM_ACTION_DENYLIST_KEYWORDS: string[] = [/* §4 */];
```

```ts
// schema/custom-action.ts — new file, follows STORY_GENERATION_SCHEMA_DEFINITION convention
export const CUSTOM_ACTION_VALIDATION_SCHEMA_DEFINITION = { /* mirrors CustomActionValidationResult */ };
export const CUSTOM_ACTION_VALIDATION_REQUIRED_FIELDS = [
  'allowed', 'plausibilityScore', 'progressionScore', 'interpretedIntent', 'actionType', 'hintType',
];
```

---

## 16. Implementation roadmap

**Phase 0 — Foundations** (types, config constants, DB migration). No runtime behavior change. Exit criteria: `custom_actions` table exists, types compile, feature flag exists and defaults off.

**Phase 1 — Gates 0 + 1, shadow mode.** Wire eligibility + security filter behind the API endpoints, but stop before Gate 2 — log what *would* pass to Gate 2 without calling it. Validates rate-limit/credit-gate plumbing and security regex coverage against real input with zero AI cost. Exit criteria: a week of shadow data, false-positive rate on the security filter reviewed manually.

**Phase 2 — Gate 2 + canonical Action construction, internal-only.** Wire the consolidated validator, feed its output into the existing page-generation pipeline, but gate the whole feature to internal/test accounts. This is where you validate the single-call consolidation actually produces coherent verdicts (§5.2's stated goal) and tune thresholds (§14) before any reader sees it. Exit criteria: manual review of a batch of allowed/rejected pages for narrative coherence and hidden-state leakage (§11).

**Phase 3 — Frontend + credits, limited rollout.** `StoryActionButton.tsx` entry point, `ConfirmationDialog.tsx` confirm flow, credit debit wired to `credit-purchase-store.ts`, polling reuse from `ReaderPageClient.tsx` (§7). Ship to a small reader cohort or a subset of books. Exit criteria: completion rate (preview → submit) and rejection-rate-driven support volume both healthy.

**Phase 4 — General availability + tuning.** Full rollout, dashboards on `plausibilityScore`/`progressionScore` distributions and downstream page-evaluator scores joined back to custom-action rows (§14). Exit criteria: stable thresholds, abuse rate within tolerance.

**Phase 5 — Template reuse (optional, only if Phase 4 data supports it).** Tier 1 per-book reuse first (cheap, low-risk), then Tier 2 cross-book templates via the Jaccard-similarity approach (§9) only once you have enough validated intents to mine patterns from.

---

## 17. Open decisions needing your input

1. **Action.type: Option A vs B (§6).** This doc recommends B (classify into real `ActionType` + new `source` field). Confirm this doesn't conflict with how `calculatePsychologicalDeltas`/momentum actually consume `Action.type` internally — I don't have that implementation in this session, only the type signatures, so it's worth a direct check before committing.
2. **Charge-before-or-after validation (§10).** This doc recommends after. Confirm against your actual existing credit-spend semantics elsewhere in the app (does anything else in Twistloom charge speculatively?).
3. **Finale disablement (§4).** Recommend disabled v1. If you'd rather allow it with extra constraint instead of an outright block, that's a Gate 2 prompt change (tighter progression threshold during `isFinale`), not an architecture change — low cost to revisit later.
4. **Free retry count** (`CUSTOM_ACTION_MAX_ATTEMPTS_PER_PAGE`) — 3 is a guess, tune against Phase 1 shadow data on how often legitimate attempts need a second try.
5. **Preview/submit split (§12)** vs. a single combined endpoint — the two-call version costs one extra round trip but buys you the "show cost before charging" UX and a re-validation safety net against stale state. Worth confirming this matches how `ConfirmationDialog.tsx` is already shaped for the credit-purchase flow, since reusing that exact pattern was the main reason to split it.

---

## Appendix — Gate 2 validator prompt draft

Written in your existing prompt-file voice (ALL CAPS section headers, terse imperative bullets, `formatKeyValueList` for enums) so it can drop into `prompt.ts` alongside the next-page prompts with minimal style drift.

```text
TASK: Evaluate a reader-submitted custom action for a branching psychological thriller.
Determine whether attempting it is reasonable given the current story state, then
convert it into a concise character intent.

${buildCustomActionValidationContext(state, currentPage)}

READER'S SUBMITTED ACTION:
"${text}"

---
EVALUATION CRITERIA:

1. CONTENT SAFETY
   Reject if sexual, hateful, self-harm-promoting, or illegal-activity content.

2. PHYSICAL & CHARACTER PLAUSIBILITY
   Can the MC reasonably attempt this given their current location, inventory,
   injuries, and established abilities? Do NOT consider whether it would succeed —
   only whether attempting it is reasonable.
${realityStability !== 'stable' ? `   NOTE: Reality stability is currently "${realityStability}" — impossible or
   dreamlike actions may be narratively legitimate rather than implausible. Scale
   judgment accordingly; do not apply a "stable reality" standard here.` : ''}

3. WORLD CONSISTENCY
   Does it contradict established facts, places, or character knowledge above?

4. PROGRESSION INTEGRITY
   Does it bypass an active thread instead of engaging with it (reveals an
   answer instantly, eliminates a conflict outright)?
${state.viableEnding ? `   Does it jump directly to or trivialize the planned ending?` : `   No ending plan exists yet — skip ending-bypass evaluation entirely.`}

---
OUTPUT (strict JSON, no extra text):
{
  "allowed": <boolean>,
  "rejectionCategory": <"content_policy"|"implausible"|"world_inconsistent"|"bypasses_thread"|"bypasses_ending"|null>,
  "reasons": [<string>, ...],
  "plausibilityScore": <0.0-1.0>,
  "progressionScore": <0.0-1.0>,
  "interpretedIntent": <3-8 word character intent, present tense, no outcome assumed>,
  "actionType": <one of: ${formatOneOf(Object.keys(actionTypes).filter(k => k !== 'custom'))}>,
  "hintType": <one of: ${formatOneOf(actionHintTypes)}>
}
```

This mirrors `buildNextPageEvaluatorPrompt`'s shape closely enough that the same `createAIOptionsWithSchema` + `aiPrompt` + `ai-parser.ts` repair pipeline handles it without modification — the consolidation point from §3 made concrete.
