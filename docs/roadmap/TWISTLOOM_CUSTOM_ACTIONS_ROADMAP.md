# Twistloom Custom Actions System — Implementation Roadmap

**Status:** Design doc v2, ready for phased implementation
**Supersedes:** `TWISTLOOM_CUSTOM_ACTIONS_SYSTEM.md` (ChatGPT draft)
**v2 changes:** incorporates `story_utils.ts` (resolves the Action.type open decision with hard evidence) and a second Gemini review (`TWISTLOOM_CUSTOM_ACTIONS_GEMINI.md`) — see §0.1 for what changed and why.
**Grounded against:** `types/story.ts`, `types/character.ts`, `types/places.ts`, `prompt.ts`, `story_utils.ts` (current next-page generation + state-update pipeline)

> **Backend implementation status (Jun 22, 2026):** ✅ = done, 🚧 = partial/needs wiring, 📝 = todo/frontend, ⏳ = not started
>
> **Still needed before deploy:**
> 1. 🚧 Generate DB migration (`pnpm db:generate`)
> 2. 🚧 Add `Action.source?: 'ai' | 'custom' | 'community'` to `types/story.ts:Action` (§15)
> 3. 🚧 Wire rate limiting (per-user, per-page) to Redis/middleware
> 4. 🚧 Add feature flag (default off) for phased rollout
> 5. 📝 Frontend: `StoryActionButton.tsx`, `ConfirmationDialog.tsx`, credit-store integration (§10)
> 6. ⏳ Telemetry dashboard + threshold tuning (§14)

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

## 0.1 v2 revision — confirmed evidence, Gemini review, compliance check

### Open Decision #1 is now resolved, not recommended

v1 of this doc recommended Option B (classify custom actions into the real `ActionType` instead of overloading `type: 'custom'`) but flagged it as unconfirmed because `calculatePsychologicalDeltas`'s implementation wasn't available. It's now visible in `story_utils.ts`, and the answer is unambiguous — **three separate functions key off `Action.type`**, not one:

```ts
// story_utils.ts:90-91 — calculateDangerLevel(), feeds momentum's dangerLevel factor
if (DANGEROUS_ACTIONS.includes(action.type)) actionScore += weight;
else if (SAFE_ACTIONS.includes(action.type)) actionScore -= weight * 0.5;

// story_utils.ts:1170-1172 — updateHiddenState(), feeds realityStability/memoryIntegrity
const stressfulActionCount = state.actionsHistory.filter(
  a => a.type === 'attack' || a.type === 'ignore' || a.type === 'escape'
).length;

// story_utils.ts:1354-1361 — derivePsychologicalProfile(), feeds archetype + dominantTraits
if (recentActions.some(d => d.type === 'escape')) traitSet.add("fearful");
if (recentActions.some(d => d.type === 'social')) traitSet.add("social");
if (recentActions.some(d => d.type === 'explore')) traitSet.add("curious");
if (recentActions.some(d => d.type === 'attack')) traitSet.add("aggressive");
// ...protect/deceive/risk/heal follow the same pattern
```

`calculatePsychologicalDeltas` itself turns out to be a plain before/after diff of `StoryState` (psychological profile, hidden state, memory integrity, difficulty) — it doesn't read `Action.type` directly. But the three functions above do, and they're exactly what feeds `derivePsychologicalProfile`'s archetype detection (`the_paranoid`, `the_risk_taker`, etc.) and `determineOptimalEnding`'s archetype-driven ending selection. If `Action.type` were `'custom'` for every reader-submitted action, none of `DANGEROUS_ACTIONS`/`SAFE_ACTIONS`/the `escape`/`social`/`explore`/`attack`/`protect`/`deceive`/`risk`/`heal` checks above would ever match a custom action — a reader who submits ten custom "attack" actions in a row would never accumulate the `"aggressive"` trait or push toward `the_risk_taker`. That's exactly the system Gemini's *80 Days* writeup correctly praised as Twistloom's edge (§ companion doc) — Option A would have quietly broken it for every paying custom-action user, who are by definition your most engaged readers.

**§6 and §15 below are updated accordingly: this is now stated as confirmed, not "recommended pending verification."**

### Gemini's custom-actions review (`TWISTLOOM_CUSTOM_ACTIONS_GEMINI.md`) — what's accurate, what's already covered, what's new

| Gemini claim | Assessment |
|---|---|
| "Piggyback Method" — single-pass JSON parses intent + updates state | The underlying mechanism is real (one `StoryGeneration` response carries narrative + all state deltas), but "Piggyback Method" isn't a term from your codebase — it's Gemini's own label. Already the basis of this whole doc's §2/§5. |
| State-aware parsing against `inventory`/`injuries`/`connected_areas` | Already in v1's Gate 2 context, but v1 was missing one thing Gemini's framing exposed: it never checked the *current place's* `keyObjects`. Fixed below — see "scene search," new. |
| Reject God-moding / reality-breaking / meta-prompting | Already covered by Gate 1 + Gate 2's `content_policy`/`implausible`/`world_inconsistent` categories. No change needed. |
| **"Fail gracefully" instead of hard-rejecting implausible attempts** (Gemini's Consequence 1 & 2: an unarmed "I shoot the lock" should become a fumbling failure in-story, not a bounced submission; a nap mid-chase should get punished by the story, not refused at the gate) | **Genuinely missing from v1.** v1 was a binary allow/reject gate. This is a real improvement — see "Three outcomes, not two" below, the most substantial change in this revision. |
| Tone/genre enforcement ("the game should respond with horror, not laughter") | Partially implicit in v1's `content_policy` category, but not explicit as a *steering* instruction. Folded into the new "allow as a failed/punished attempt" path below rather than treated as a rejection reason. |
| "Narrative Wrapper" — nonsensical input makes the character freeze in confusion rather than breaking the fourth wall | Good fallback behavior, not in v1. Added to the Gate 2 prompt (Appendix). |

### Compliance check against your four explicit requirements

| Requirement | v1 status | v2 status |
|---|---|---|
| Check inventory **or scene** before allowing object use; never invent items | Partial — inventory mentioned as a soft plausibility input, scene objects (`PlaceMemory.keyObjects`) never referenced, no hard rule | **Fixed** — explicit hard rule in §5.1/§5.2, `keyObjects` added to context builder |
| Keep the story moving toward `viableEnding`; don't let it wander/deviate too far | Partial — only covered outright *bypass* (`bypasses_ending`/`bypasses_thread`), not gradual drift from allowed-but-off-track actions | **Fixed** — `progressionScore` redefined to penalize drift, not just bypass; hint guidance now explicitly steers off-track-but-allowed actions back toward active threads |
| Max 60 chars, frontend + backend | v1 set `MAX_CUSTOM_ACTION_CHARS = 200`, backend-only | **Fixed** — lowered to 60, explicit frontend `maxLength` requirement added |
| Block emojis / broken / non-standard text, frontend + backend | v1's NFKC normalization handled unicode *evasion* tricks but not emoji/control-character *content quality* | **Fixed** — new `CUSTOM_ACTION_VALID_TEXT_PATTERN`, explicit frontend input filtering |

The rest of this section folds those fixes into the relevant gates below rather than repeating them — look for **"(v2)"** markers.

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
        │ outcome ≠ reject
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

## 3. Gate 0 — Eligibility, rate limiting, credits ✅

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

## 4. Gate 1 — Deterministic security filter ✅

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
export const MAX_CUSTOM_ACTION_CHARS = 60;   // (v2) was 200 — tightened per explicit requirement

// (v2) new — content-quality filter, distinct from the security patterns above.
// Rejects emoji, control characters, and most non-Latin-script noise. Adjust the
// script ranges if/when you support non-English custom actions; keep it explicit
// rather than "anything goes" so junk never reaches Gate 2.
export const CUSTOM_ACTION_VALID_TEXT_PATTERN = /^[\p{L}\p{N}\s.,!?'"-]+$/u;
```

Three additions worth making over the draft's version:

- **Normalize before matching.** Run `text.normalize('NFKC')` and strip zero-width characters (`\u200B-\u200D\uFEFF`) before testing patterns — trivial unicode tricks otherwise bypass every regex here.
- **Don't return the matched pattern to the client.** The draft's `SecurityValidationResult.reasons` includes `Matched ${pattern}` — fine server-side for logs, never surface that string to the UI. It teaches people exactly how to route around your filter. Map internally to a generic category (`'injection_attempt' | 'length' | 'denylist'`) and show the user one bland message regardless of which rule fired (see §11).
- **This is also where length validation lives** (`MIN/MAX_CUSTOM_ACTION_CHARS`), so you never pay an AI call for a 1-character or 2,000-character submission.

**(v2) Emoji/non-standard text must be blocked on both ends, not just the backend.** `\p{L}` (Unicode letter) and `\p{N}` (Unicode number) in `CUSTOM_ACTION_VALID_TEXT_PATTERN` exclude emoji (which are `\p{So}`/symbol category, not letters) and control characters automatically — that's the backend half. The frontend half is a separate requirement because relying on the backend alone means a reader can type 40 emoji, watch the counter say "40/60," and only find out it's rejected after submitting:

```tsx
// StoryActionButton.tsx custom-action textarea — illustrative
<textarea
  maxLength={MAX_CUSTOM_ACTION_CHARS}
  onChange={(e) => {
    const cleaned = e.target.value.replace(/[^\p{L}\p{N}\s.,!?'"-]/gu, '');
    setValue(cleaned.slice(0, MAX_CUSTOM_ACTION_CHARS));
  }}
/>
```

`maxLength` alone isn't enough — it counts UTF-16 code units, so a single 4-byte emoji can eat 2 of the 60 while *looking* like one character to the reader, and it doesn't strip disallowed characters as they're typed. Strip-on-change with the same pattern as the backend keeps the two in lockstep and gives the reader instant feedback instead of a post-submit rejection.

```ts
export interface CustomActionSecurityResult {
  passed: boolean;
  category?: 'injection_attempt' | 'denylist' | 'length' | 'invalid_characters' | 'empty';
}
```

---

## 5. Gate 2 — Consolidated AI interpreter ✅

This is the one new AI call, and it's deliberately built to mirror your existing `buildNextPageEvaluatorPrompt` / `executePromptForJSON` pattern rather than introduce a new calling convention.

### 5.1 Context builder — reuse, don't reinvent

Every input field the draft's `ActionValidationContext`/`EndingAlignmentContext` wants already has a formatter in `prompt.ts`. Build a **slimmed-down** version of the same context you already assemble for `formatNextPageStoryContextPrompt`, dropping anything write-oriented (field-instructions, scoring rubric) since this call only judges, never writes prose.

```ts
// services/custom-actions.ts
function buildCustomActionValidationContext(state: StoryState, currentPage: ActionedStoryPage | UserStoryPage): string {
  const stateInfo = getStoryStateInfo(state);

  return `CURRENT SCENE:
${formatCurrentSituationForPrompt(currentPage, state)}

CURRENT INVENTORY:
${formatInventoryForValidation(state.inventory)}   // (v2) new, thin wrapper — see below

ACCESSIBLE PLACES, CONNECTIONS & OBJECTS:
${formatAccessiblePlacesForValidation(state)}   // new, thin wrapper — see below

CURRENT FACTS:
${formatCurrentFacts(state.factsHistory)}

${formatThreadsPrompt(state.threads, stateInfo)}   // reused as-is, read-only context here

${formatEndingPrompt(state)}   // reused as-is — single viableEnding, may be "No ending plan yet."

STORY PHASE:
${stateInfo.phase} — ${stateInfo.phaseGoal}`;
}
```

`(v2)` `formatInventoryForValidation` is a one-line addition that was missing entirely from v1 — the original context builder leaned on `formatCurrentSituationForPrompt` to implicitly carry inventory, but Gate 2 needs it impossible to miss given how central the "don't invent items" rule is (see §5.2):

```ts
function formatInventoryForValidation(inventory: InventoryItem[]): string {
  if (!inventory.length) return '  (empty — MC is carrying nothing)';
  return inventory.map(i => `  · ${i.name}${i.amount && i.amount > 1 ? ` (x${i.amount})` : ''}${i.where ? ` — ${i.where}` : ''}`).join('\n');
}
```

`formatAccessiblePlacesForValidation` is the other genuinely new formatter, and it's small — it projects `state.places` + each place's `knownConnections[].accessibility/obstacles` into a compact list (strictly more useful than the draft's flat `accessiblePlaces: string[]`), and **(v2)** also surfaces the *current* place's `keyObjects` — this is the "or search around the scene" half of your inventory requirement. An item doesn't have to be in the MC's pocket to be a legitimate target for a custom action; it just has to be established as present *somewhere reachable*:

```ts
function formatAccessiblePlacesForValidation(state: StoryState): string {
  const current = state.places[/* currentPlaceId from currentPage */];
  const reachable = current?.knownConnections
    ?.filter(c => c.accessibility !== 'blocked' && c.accessibility !== 'destroyed')
    .map(c => `  · ${state.places[c.targetId]?.knownName ?? c.targetId} (${c.accessibility ?? 'unknown'}${c.obstacles.length ? `, obstacles: ${c.obstacles.join(', ')}` : ''})`)
    .join('\n') ?? '  None known.';

  // (v2) — objects present in the current scene, not just the MC's inventory
  const sceneObjects = current?.keyObjects?.length
    ? current.keyObjects.map(o => `  · ${o.name}${o.where ? ` (${o.where})` : ''}`).join('\n')
    : '  None noted.';

  return `- Current location: ${current?.knownName ?? 'unknown'} (${current?.type ?? 'unknown'})
- Objects visible/known in this scene:
${sceneObjects}
- Known reachable places:
${reachable}`;
}
```

Notice what's missing from this list versus the draft: `genre`, `worldRules: string[]`, `availableTechnology`, `availableMagicSystems`. None of them map to anything you track, and inventing them would mean maintaining a second, parallel, hand-authored "world bible" that's guaranteed to drift from `factsHistory`/`places`/`characters` over time. Drop them.

### 5.2 Output schema & types

**(v2) Three outcomes, not two.** v1 modeled this as binary `allowed: boolean`. Gemini's review surfaced a real gap: a hard reject is the right response to a jailbreak attempt or genuinely policy-violating content, but it's the *wrong* response to "I shoot the lock with my gun" when the MC has no gun — that's not abuse, it's a reasonable attempt that should *narratively fail* (the MC fumbles, realizes they're unarmed, the threat closes in) rather than bouncing the reader's submission back at them. The same logic applies to a passive/tonally-wrong action mid-crisis ("I sit down and take a nap" during a `critical`-momentum chase) — punish it in-story, don't refuse it at the gate. Reserve a hard reject for things a *failure scene* can't safely contain: content policy, security/injection, and the two ending/thread-bypass categories (those can't "fail gracefully" without either contradicting established facts or accidentally revealing what the bypass would have skipped).

```ts
// types/custom-action.ts
export type CustomActionOutcome =
  | 'reject'           // hard block — no generation, no charge, free retry
  | 'allow_as_attempt' // proceeds to generation, but hint forces a failed/punished consequence
  | 'allow';           // proceeds normally, plausible as attempted

export type CustomActionRejectionCategory =
  | 'content_policy'      // Layer "Safety" from the draft — always 'reject'
  | 'implausible'         // missing item/ability — 'allow_as_attempt' in most cases, see below
  | 'world_inconsistent'  // contradicts established facts — usually 'reject'
  | 'tonally_wrong'       // (v2) passive/comedic/nonsensical mid-tension — 'allow_as_attempt'
  | 'bypasses_thread'     // skips a mystery/conflict instead of engaging it — always 'reject'
  | 'bypasses_ending';    // jumps straight to/around the planned ending — always 'reject'

export interface CustomActionValidationResult {
  outcome: CustomActionOutcome;
  rejectionCategory?: CustomActionRejectionCategory;
  /** Internal-only reasoning, never shown verbatim to the reader. */
  reasons: string[];

  /** 0–1, how plausible attempting this is given current state — informs outcome, not a hard gate by itself. */
  plausibilityScore: number;
  /**
   * 0–1, how much this preserves story progression. (v2) Redefined from v1: this is no
   * longer just an outright-bypass check — it also scores gradual drift, so a string of
   * technically-plausible but aimless custom actions trends this score down even when
   * none of them individually trips `bypasses_thread`. See §5.5.
   */
  progressionScore: number;

  /** 3–8 word canonical intent, replaces the draft's separate "canonicalization" prompt. */
  interpretedIntent: string;

  /** Best-fit classification — reuses your existing unions, see §6 for why this matters. */
  actionType: ActionType;
  hintType: ActionHintType;
}
```

`implausible` and `tonally_wrong` are deliberately **not** auto-mapped to `reject` — Gate 2's prompt (Appendix) instructs the model to default to `allow_as_attempt` for these two categories specifically, and only fall through to `reject` when the attempt is so far outside the world that even a failure beat can't make sense of it (e.g. not "I shoot the lock with my pipe" — allow as attempt, the pipe fails — but "I summon a SWAT team" with zero established connection to any authority — reject).

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

### 5.5 (v2) Keeping the story on-track — drift, not just bypass

Your second explicit requirement ("keep story continue towards the `viableEnding`, don't wander/deviate too far") is broader than the `bypasses_ending`/`bypasses_thread` reject categories already cover. Those catch the dramatic case — an action that would *skip straight to* or *eliminate* the ending/a thread outright. They don't catch the quieter failure mode: a reader who submits a string of individually-harmless, individually-plausible custom actions that just wander away from every active thread ("I go check out the gift shop," "I make small talk about the weather," repeated) — none of which trips a reject category, but which collectively stall the story.

Two changes handle this without adding a new gate:

1. **`progressionScore` is redefined** (§5.2) to also reflect *relevance* to active threads/the viable ending, not just absence-of-bypass. A fully plausible but thematically irrelevant action scores lower here even when `outcome: 'allow'`.
2. **The hint guidance steers, it doesn't block.** For an `allow`/`allow_as_attempt` outcome with a low `progressionScore`, `interpretedIntent` and `hintType` should be chosen so the *page generator* organically pulls a relevant thread/clue/character back into the scene — e.g. the gift shop the reader wandered into turns out to have a connection to an open thread. This costs nothing extra: it's an instruction added to the same Gate 2 prompt, consumed by the same `getHintGuidanceForAI` call your page generator already runs (§1). You're not blocking the reader's creative choice, you're using your existing "the AI weaves in relevant context" capability to make sure their choice still serves the story.

This is also a more honest fit for "intent proposals, not commands" than a hard wander-limit would be — a hard cap on how far a reader can explore would feel exactly like the punitive system the rest of this doc is trying to avoid.

---

## 6. Canonical Action construction ✅ (backlog: `Action.source` field not yet added to `types/story.ts` — see §15) — resolved, not a decision point

v1 framed this as an open fork between two options. It's now settled — see §0.1 for the evidence.

**Option A — set `Action.type = 'custom'` directly.** Simplest, but confirmed wrong: `calculateDangerLevel`, `updateHiddenState`, and `derivePsychologicalProfile` all branch on `action.type` against specific real categories (`'attack'`, `'escape'`, `'risk'`, `'social'`, `'explore'`, `'protect'`, `'deceive'`, `'heal'`, `'ignore'`). A custom action typed `'custom'` matches none of these checks and silently contributes zero signal to danger level, reality stability, memory integrity, *and* archetype/trait detection — exactly the systems Gemini's *80 Days* writeup singled out as Twistloom's structural advantage.

**Option B — classify into the real `ActionType` and track provenance separately.** Confirmed correct. Gate 2 already classifies `actionType` as part of its structured output (§5.2) — that classification *is* the real category, not a fallback. Add one small additive field to track source instead of overloading `type`:

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

**Confirmed: Option B.** It costs one optional field, and it's the only option that keeps a reader's custom "I attack him with the pipe" registering as `attack` for danger/momentum/archetype purposes the same way an AI-curated "attack" choice would. `source` gives you the "show a different icon for reader-submitted choices" UI hook without sacrificing that.

`hint.type`, by contrast, should be classified properly regardless of which option you pick for `Action.type` — `getHintGuidanceForAI('custom')`'s generic fallback text ("Honor their creative intent…") is noticeably less specific than what `truth_revelation`, `betrayal`, `confrontation` etc. give the writer model. Gate 2 should almost always be able to pick a better-fitting hint type than the generic fallback; reserve `'custom'`/`'none'` for genuine edge cases.

```ts
function buildCanonicalAction(
  originalText: string,
  result: CustomActionValidationResult,
): Action {
  return {
    text: originalText.trim().slice(0, MAX_CUSTOM_ACTION_CHARS),
    type: result.actionType,           // confirmed correct: real category, not 'custom' — see §0.1
    hint: { text: result.interpretedIntent, type: result.hintType },
    destinationPageIds: [],            // no pre-generated candidates for custom actions, see §7
    source: 'custom',
  };
}
```

Note this function runs identically for `outcome: 'allow'` and `outcome: 'allow_as_attempt'` (§5.2) — only `'reject'` skips it entirely. The difference between a clean success and a forced narrative failure lives entirely in `hint.text`/`hint.type`, not in whether an `Action` gets constructed at all.

---

## 7. Hooking into page generation — and why most of it needs zero changes ✅

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

## 9. Reframing "community action storage" for a per-book narrative ⏳ (table exists, logic not implemented)

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

## 10. Credit pricing & frontend integration checklist ✅ (backend pricing done, frontend 📝)

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

## 11. Rejection & forced-failure UX — never leak hidden state ✅

The most Twistloom-specific rule in this whole document: your prompt system goes to real lengths to keep `HiddenState`, `viableEnding`, and thread `truth` away from the reader (`RULES_CHARACTER`: *"NEVER reveal hidden character data unless explicitly discovered"*; the whole `HiddenState` type is explicitly *"not directly visible to users"*). A naive rejection message can undo that instantly — e.g. rejecting "I read Lisa's mind" with *"this would bypass the mystery of Lisa's true identity"* just told the reader Lisa's identity **is** the mystery.

**(v2) This only applies to `outcome: 'reject'`.** `allow_as_attempt` doesn't need a bland rejection message at all — it's not rejected. The reader's submission succeeds (generation proceeds, credits charge normally), and the "punishment" is delivered as actual prose on the next page (the MC fumbles, the threat closes in), not as UI copy. That's a strictly better experience than a bounced submission, and it's the main reason the three-outcome model (§5.2) is worth the added complexity.

Map internal `rejectionCategory` to bland, non-specific reader-facing copy — this table now only covers categories that can actually produce `outcome: 'reject'`:

| Internal category | Typical outcome | Reader-facing message (illustrative tone, not final copy) |
|---|---|---|
| `content_policy` | always `reject` | "That's not something this story can do." |
| `implausible` | usually `allow_as_attempt` (no message — narrated as failure); `reject` only if no failure scene makes sense | n/a in the common case; same generic copy as below if it does reject |
| `tonally_wrong` | usually `allow_as_attempt` (narrated as a punished beat) | n/a — handled entirely in-story |
| `world_inconsistent` | usually `reject` | "That doesn't match what's true in this story so far." |
| `bypasses_thread` | always `reject` | "That feels like it's skipping ahead — try engaging with what's in front of you." |
| `bypasses_ending` | always `reject` | same copy as `bypasses_thread` — **never differentiate this one in the UI**, since a distinct message for "this would end the story" is itself a tell. |

Same logic from Gate 1: never surface which regex/keyword fired. One generic message for all security-filter rejections, and **(v2)** one generic "let's keep that to standard text" message for `invalid_characters` failures (emoji/non-standard-text) — no need to explain Unicode categories to a reader.

---

## 12. API surface — frontend integration reference ✅ (both endpoints implemented)

Two endpoints, matching the confirm-then-commit UX from §10. The frontend should call `preview` first (shows cost + canonical intent without charging), then `submit` to confirm and trigger generation.

### `POST /api/books/:identifier/:pageId/custom-actions/preview`

**Purpose:** Preview a custom action. Runs Gates 0 + 1 + 2. No credits charged.
**Auth:** Required (`requireAuth`)
**Body:**
```json
{
  "text": "I try to pick the lock with my hairpin"
}
```

**Response (200) — action allowed (allow / allow_as_attempt):**
```json
{
  "outcome": "allow",
  "preview": {
    "canonicalIntent": "attempt lockpicking escape",
    "cost": 3
  }
}
```
- `outcome`: `"allow"` (succeeds) or `"allow_as_attempt"` (fails in-story, still narratively valid)
- `preview.canonicalIntent`: 3–8 word summary the AI interpreted
- `preview.cost`: credits to charge on confirm (constant: `CUSTOM_ACTION_CREDIT_COST = 3`)

**Response (200) — rejected:**
```json
{
  "outcome": "reject",
  "rejectionCategory": "world_inconsistent",
  "message": "That doesn't match what's true in this story so far."
}
```
- `rejectionCategory`: one of `content_policy`, `implausible`, `world_inconsistent`, `tonally_wrong`, `bypasses_thread`, `bypasses_ending`
- `message`: reader-safe string (never leaks hidden state or matched regex)

**Response (400) — Gate 0/1 failure:**
```json
{
  "outcome": "reject",
  "message": "Custom actions are not available during the finale."
}
```
- Same shape as rejection — `message` is reader-safe.

**Frontend integration:**
1. Call on textarea blur or when user taps a "preview" button
2. Show `preview.canonicalIntent` so the reader sees what the AI understood
3. Show `preview.cost` in the confirm button ("Spend 3 credits?")
4. Disable submit if `outcome === 'reject'`, show `message` inline

---

### `POST /api/books/:identifier/:pageId/custom-actions/submit`

**Purpose:** Confirm and submit a custom action. Re-runs all gates (do NOT trust the preview result — state may have changed). Charges credits.
**Auth:** Required (`requireAuth`)
**Body:**
```json
{
  "text": "I try to pick the lock with my hairpin"
}
```
> No `confirmationToken` needed — the endpoint re-validates from scratch on submit. This is intentional: between preview and submit the story state could have changed (another branch, a thread closing).

**Response (202) — accepted (allow / allow_as_attempt):**
```json
{
  "message": "Custom action submitted successfully. Page generation in progress.",
  "pollingInfo": {
    "pollingUrl": "/api/books/the-haunting/page-abc-123/candidates/status",
    "pollingIntervalMs": 2000,
    "maxPollingTimeMs": 80000
  }
}
```
- `pollingInfo.pollingUrl`: poll this endpoint to check when the generated page is ready
- `pollingInfo.pollingIntervalMs`: suggested interval between polls (2s)
- `pollingInfo.maxPollingTimeMs`: fallback timeout (80s), show error if exceeded

**Response (400) — rejected (no charge):**
```json
{
  "message": "That action could not be processed."
}
```
- Credits are **never charged** for a rejection — `reject` outcomes cost the reader nothing
- The reader can retry (up to `CUSTOM_ACTION_MAX_ATTEMPTS_PER_PAGE = 3`)

**Response (402) — insufficient credits:**
```json
{
  "error": "Insufficient credits",
  "message": "You need at least 3 credits to submit a custom action"
}
```
- The frontend should check `useUser` credit balance before showing the custom-action entry point

**Frontend integration:**
1. Show a confirmation dialog with the cost and the canonical intent from preview
2. On confirm, call submit (re-runs validation server-side as a safety net)
3. On 202, start polling `pollingInfo.pollingUrl` with the provided interval
4. On 400 (reject), show the message and allow retry (track per-page retry count)
5. On 402, redirect to credit-purchase flow

**Polling behavior** reuses the exact existing `ReaderPageClient.tsx` pattern — the same `candidates/status` endpoint that tracks AI-curated candidate generation also surfaces the custom-action-generated page once it's ready. No new polling code needed.

---

## 13. Database schema (Drizzle / Neon Postgres) ✅ (both tables defined in schema.ts)

Illustrative — adapt field/relation names to your existing `schema.ts` conventions; I haven't seen that file's current shape.

```ts
// db/schema/custom-actions.ts
import { pgTable, uuid, text, varchar, real, integer, timestamp, index } from "drizzle-orm/pg-core";

export const customActions = pgTable("custom_actions", {
  id: uuid("id").defaultRandom().primaryKey(),
  bookId: uuid("book_id").notNull(),
  pageId: uuid("page_id").notNull(),
  userId: uuid("user_id").notNull(),

  originalText: text("original_text").notNull(),
  canonicalIntent: text("canonical_intent"),
  actionType: varchar("action_type", { length: 32 }),
  hintType: varchar("hint_type", { length: 32 }),

  outcome: varchar("outcome", { length: 20 }).notNull(),   // (v2) 'reject' | 'allow_as_attempt' | 'allow'
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

`customActions` doubles as your audit log — store **rejected and forced-failure** attempts too (`outcome: 'reject'` and `'allow_as_attempt'`), not just clean successes. This is what threshold-tuning in Phase 4 (§14) will run against.

One logging-hygiene note matching the care you put into this on the auth-debugging work: `originalText` is reader-submitted free text that may occasionally include attempted jailbreak strings or worse. Keep this table access-restricted (not piped into general analytics/BI tooling that has wider read access), and consider whether `originalText` needs to exist at all in your **application logs** (vs. just this restricted table) — the same instinct that led you to fix logging hygiene in the auth flow applies here.

---

## 14. Telemetry & threshold tuning 🚧 (thresholds set at 0.5, no dashboards yet)

`plausibilityScore` and `progressionScore` are continuous, not boolean — log them on every attempt (all three outcomes) so you can tune the pass threshold empirically instead of guessing. Suggested v1 thresholds, treat as a starting point:

```ts
export const CUSTOM_ACTION_PLAUSIBILITY_THRESHOLD = 0.5;
export const CUSTOM_ACTION_PROGRESSION_THRESHOLD = 0.5;
```

Watch two failure modes once this ships: false-rejects (annoyed paying readers, visible in support/feedback) and false-allows (a custom action that produces a low `scoreAfter` from your existing page evaluator — this is a free signal you already generate downstream, join it back to the `custom_actions` row that produced the page).

---

## 15. New/modified types — summary diff ✅ (backlog: `Action.source` in `types/story.ts` not added; `language` field added Jun 22)

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
export type CustomActionOutcome = 'reject' | 'allow_as_attempt' | 'allow';   // (v2)

export type CustomActionRejectionCategory =
  | 'content_policy' | 'implausible' | 'world_inconsistent'
  | 'tonally_wrong'                                            // (v2) new
  | 'bypasses_thread' | 'bypasses_ending';

export interface CustomActionSecurityResult {
  passed: boolean;
  category?: 'injection_attempt' | 'denylist' | 'length' | 'invalid_characters' | 'empty';   // (v2) +invalid_characters
}

export interface CustomActionValidationResult {
  outcome: CustomActionOutcome;        // (v2) was `allowed: boolean`
  rejectionCategory?: CustomActionRejectionCategory;
  reasons: string[];
  plausibilityScore: number;
  progressionScore: number;            // (v2) redefined — also penalizes drift, see §5.5
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
export const MAX_CUSTOM_ACTION_CHARS = 60;   // (v2) was 200
export const CUSTOM_ACTION_VALID_TEXT_PATTERN = /^[\p{L}\p{N}\s.,!?'"-]+$/u;   // (v2) new — blocks emoji/control chars
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
  'outcome', 'plausibilityScore', 'progressionScore', 'interpretedIntent', 'actionType', 'hintType',   // (v2) outcome, not allowed
];
```

---

## 16. Implementation roadmap

> Legend: ✅ done | 🚧 partial | 📝 todo (frontend) | ⏳ not started | ⏩ skipped

**Phase 0 — Foundations** (types, config constants, DB migration). 🚧
- ✅ `types/custom-action.ts` — all types defined
- ✅ `config/custom-actions.ts` — all config constants
- ✅ `db/schema.ts` — `customActions` and `customActionTemplates` tables defined
- 🚧 No DB migration generated yet (need `pnpm db:generate` before deploy)
- 🚧 No feature flag to gate the system off by default

**Phase 1 — Gates 0 + 1**. ✅ (both active, not shadow mode)
- ✅ Gate 0 — story phase gate (FINALE disabled), credit check (delegated to caller), all deterministic checks
- ✅ Gate 1 — security patterns, denylist, length validation (3–60), valid-text pattern (no emoji/control chars), NFKC normalization, zero-width strip
- 🚧 Rate limiting (per-user per-hour, per-page cooldown) referenced in code but not wired to middleware/Redis

**Phase 2 — Gate 2 + canonical Action construction**. ✅
- ✅ Single consolidated AI call using `AI_CHAT_MODELS_THEME` (light tier)
- ✅ Context builder (inventory, accessible places + `keyObjects`, threads, ending, facts, reality distortion)
- ✅ Three-outcome model (reject / allow_as_attempt / allow)
- ✅ `buildCanonicalAction()` with real `ActionType` classification (not `'custom'`)
- 🚧 `Action.source` field not yet added to `types/story.ts` (code constructs it, but compile-time type is missing)

**Phase 3 — Backend integration + credit charging**. ✅ (backend side)
- ✅ `POST .../custom-actions/preview` — runs Gates 0+1+2, returns outcome + cost, no charge
- ✅ `POST .../custom-actions/submit` — re-runs validation, charges credits via `executeWithCredits`, persists audit row, logs activity, returns polling info
- ✅ Credits charged only after validation passes (`allow` / `allow_as_attempt`), never for `reject`
- ✅ Rejection messages use bland categories (§11), never leak hidden state or matched regex
- ✅ `communityActions` field in `EnrichedStoryPage` — top 5 custom actions from other readers on the same page, same language, sorted by `plausibilityScore` DESC. Frontend can show these as one-click action suggestions.
- 📝 Frontend: `StoryActionButton.tsx`, `ConfirmationDialog.tsx`, `credit-purchase-store.ts` wiring — not started

**Phase 4 — General availability + tuning**. ⏳
- ⏳ Threshold tuning (`plausibilityScore`/`progressionScore` at 0.5, not yet empirically validated)
- ⏳ Distribution dashboards / monitoring

**Phase 5 — Template reuse (optional)**. ⏩
- ⏩ `customActionTemplates` DB table dropped
- ⏩ Tier 1 per-book reuse (Jaccard-similarity intent dedup within book)
- ⏩ Tier 2 cross-book templates (only after Phase 4 data supports it)

---

## 17. Open decisions needing your input

~~1. Action.type: Option A vs B~~ — **Resolved in v2, see §0.1/§6.** `story_utils.ts` confirms Option B (classify into real `ActionType` + `source` field) is required; Option A would silently break danger-level, reality-stability, and archetype detection for every custom action.

1. **Charge-before-or-after validation (§10).** This doc recommends after. Confirm against your actual existing credit-spend semantics elsewhere in the app (does anything else in Twistloom charge speculatively?).
2. **`allow_as_attempt` charging (v2, new).** This doc assumes `allow_as_attempt` charges the same as `allow` — the reader's submission *did* proceed to generation, it just narrates a failure. Worth confirming that reads as fair rather than "I paid 3 credits to watch myself fail" — possible mitigation: a reduced rate for `allow_as_attempt`, or framing the cost as "narrative cost" rather than "success cost" in the UI copy.
3. **Finale disablement (§4).** Recommend disabled v1. If you'd rather allow it with extra constraint instead of an outright block, that's a Gate 2 prompt change (tighter progression threshold during `isFinale`), not an architecture change — low cost to revisit later.
4. **Free retry count** (`CUSTOM_ACTION_MAX_ATTEMPTS_PER_PAGE`) — 3 is a guess, tune against Phase 1 shadow data on how often legitimate attempts need a second try. Note this now only applies to `reject` outcomes — `allow_as_attempt` isn't a "failed attempt" in the retry-budget sense, it's a completed (if unlucky) turn.
5. **Preview/submit split (§12)** vs. a single combined endpoint — the two-call version costs one extra round trip but buys you the "show cost before charging" UX and a re-validation safety net against stale state. Worth confirming this matches how `ConfirmationDialog.tsx` is already shaped for the credit-purchase flow, since reusing that exact pattern was the main reason to split it.

---

## Appendix — Gate 2 validator prompt draft (v2)

Written in your existing prompt-file voice (ALL CAPS section headers, terse imperative bullets, `formatKeyValueList` for enums) so it can drop into `prompt.ts` alongside the next-page prompts with minimal style drift.

```text
TASK: Evaluate a reader-submitted custom action for a branching psychological thriller.
Determine the outcome given the current story state, then convert it into a concise
character intent. The reader's input is an INTENT PROPOSAL, not a command — you decide
how the story responds to it, including letting it fail in-character.

${buildCustomActionValidationContext(state, currentPage)}

READER'S SUBMITTED ACTION:
"${text}"

---
EVALUATION CRITERIA:

1. CONTENT SAFETY
   outcome="reject" if sexual, hateful, self-harm-promoting, or illegal-activity content.

2. OBJECT & RESOURCE CHECK (hard rule — do not invent items)
   If the action requires an object, check it against CURRENT INVENTORY and the
   current scene's "Objects visible/known in this scene" list above ONLY.
   - Item is in inventory or the current scene: treat as available, evaluate normally.
   - Item is NOT in either list: the action does NOT succeed as described. Do not
     invent the item's existence. Set outcome="allow_as_attempt" — the MC attempts
     the action, realizes/fumbles for the missing item, and the scene escalates
     against them. Only use outcome="reject" here if no failure beat makes sense at
     all (e.g. the request assumes an entire absent person/faction, not just an item).

3. PHYSICAL & CHARACTER PLAUSIBILITY
   Can the MC reasonably ATTEMPT this given their current location, injuries, and
   established abilities? Do NOT consider whether it would succeed.
${realityStability !== 'stable' ? `   NOTE: Reality stability is currently "${realityStability}" — impossible or
   dreamlike actions may be narratively legitimate rather than implausible. Scale
   judgment accordingly; do not apply a "stable reality" standard here.` : ''}

4. WORLD CONSISTENCY
   Does it contradict established facts, places, or character knowledge above?
   outcome="reject" if so — a fabricated fact can't be narrated around safely.

5. TONE DISCIPLINE (hard rule)
   This is a psychological thriller. If the action is comedic, flippant, passive,
   or anticlimactic relative to the current momentum/sceneType — especially during
   a tense or critical scene — do NOT play along or write it as succeeding lightly.
   Set outcome="allow_as_attempt" and choose hintType/interpretedIntent so the page
   generator punishes the tonal mismatch in-story (the threat closes in, the moment
   of relief is cut short). Never reject purely for tone — subvert it instead.

6. NONSENSE / INDECIPHERABLE INPUT
   If the text doesn't parse as any coherent in-universe action, do NOT ask for
   clarification or acknowledge it's unclear. outcome="allow_as_attempt" with
   interpretedIntent like "hesitates, uncertain what to do" — the character freezes
   in confusion for a beat while tension continues to build around them.

7. PROGRESSION INTEGRITY — bypass AND drift
   Reject (outcome="reject") if this skips an active thread instead of engaging with
   it, or reveals/eliminates it instantly.
${state.viableEnding ? `   Reject if it jumps directly to or trivializes the planned ending.` : `   No ending plan exists yet — skip ending-bypass evaluation entirely.`}
   Separately, score progressionScore on RELEVANCE: even a fully permitted action
   that has nothing to do with any active thread or the viable ending should score
   low here (this does not change outcome, but the page generator will use it to
   organically pull a relevant thread back into the scene — see your hint guidance).

---
OUTPUT (strict JSON, no extra text):
{
  "outcome": <"reject"|"allow_as_attempt"|"allow">,
  "rejectionCategory": <"content_policy"|"implausible"|"world_inconsistent"|"tonally_wrong"|"bypasses_thread"|"bypasses_ending"|null>,
  "reasons": [<string>, ...],
  "plausibilityScore": <0.0-1.0>,
  "progressionScore": <0.0-1.0, see criterion 7>,
  "interpretedIntent": <3-8 word character intent, present tense, no outcome assumed — for allow_as_attempt, phrase the ATTEMPT, not the failure, e.g. "attempt to force the lock", not "fails to force the lock">,
  "actionType": <one of: ${formatOneOf(Object.keys(actionTypes).filter(k => k !== 'custom'))}>,
  "hintType": <one of: ${formatOneOf(actionHintTypes)}>
}
```

This mirrors `buildNextPageEvaluatorPrompt`'s shape closely enough that the same `createAIOptionsWithSchema` + `aiPrompt` + `ai-parser.ts` repair pipeline handles it without modification — the consolidation point from §3 made concrete.
