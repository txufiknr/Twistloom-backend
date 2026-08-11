# Next-Page Generation Architecture

**Status:** Current, implementation-accurate (as of `cc0a174` working tree).
**Supersedes:** [`PRE_GENERATION_FLOW.md`](./PRE_GENERATION_FLOW.md) and [`ASYNC_CANDIDATE_GENERATION_ARCHITECTURE.md`](./ASYNC_CANDIDATE_GENERATION_ARCHITECTURE.md) — those documents describe the system as it was designed and are now stale. Read this document for the current flow.

## Overview

Twistloom generates the next page of a story **in two complementary ways**:

1. **Synchronous direct generation** — one specific destination page for one action, produced on demand (custom actions, first-page flow, Pen engine continue).
2. **Asynchronous candidate pre-generation** — a whole page's worth of branches pre-built in the background (via a GitHub Actions workflow or a cron job) so that when a reader picks an action, its destination page already exists.

Both paths converge on the **same core AI pipeline**: `generateNextPage` / `generateNextPages` in `src/utils/prompt.ts:4618/4756`, which build a prompt, call an AI provider waterfall with structured-output guarantees, run an optional evaluator pass, determine a branch, and persist the page with its story-state delta.

The system deliberately keeps **state as data, not as prose history**: every generated page carries a `stateDelta` (engine-owned + AI-authored) that produces the next `StoryState`. Branches are first-class rows, and candidate/alternate fates share the parent's branch unless they legitimately fork.

---

## Core Concepts

| Concept | Description | Key location |
|---|---|---|
| `StoryState` | Full serializable snapshot of the story: page number, flags, characters, places, threads, psychological profile, composure, memory integrity. | `src/types/story.ts` (interface ~`StoryState`) |
| `StateDelta` | The delta produced by one page: flag updates, trauma tags, future notes, characters, relationships, places, threads, endings, psychological layer snapshots. | `src/types/story.ts:1221` |
| Branch | A distinct narrative timeline. A page belongs to one branch; actions point at destination pages via `destinationPageIds`. | `src/db/schema.ts` |
| Action | A reader choice on a page. Each action carries `destinationPageIds[]` which may be empty until candidate generation fills them. | `src/types/story.ts` (~`Action`, `destinationPageIds` at :1447) |
| Book mode | Controls branching contract: `novel` = 1 action / 1 destination; `interactive` = 2–3 actions, 1 destination each; `multiverse` = 2–3 actions, up to `MAX_CANDIDATE_PAGE_PER_ACTION` destinations. | `src/utils/book-mode.ts` |

### The delta→state loop

```
page (stateDelta)  →  advanceStoryState  →  next StoryState
     ▲                                            │
     │                                            ▼
persistPageWithState                     build prompt context
     ▲                                            │
     └───────  AI output + engine deltas  ←───────┘
```

- `advanceStoryState` (`src/utils/story.ts:749`) applies the user action + previous AI turn to produce the next state.
- `prepareNextPageGenerationContext` (`src/utils/prompt.ts:4263`) reconstructs the baseline state if not provided and verifies page-number continuity.
- `extractStateDelta` (`src/utils/story.ts:284`) pulls AI-authored delta fields; `calculatePsychologicalDeltas` (`:391`) computes the engine-owned psychological layer; `applyStateDelta` (`:498`) merges everything onto the state.

---

## Mermaid Flow Diagram

```mermaid
flowchart TD
    subgraph Entry["Entry points"]
        A1["POST /:identifier/:pageId/generate (custom action)"] --> C[generatePageForCustomAction<br/>src/services/custom-actions.ts:546]
        A2["GET /:identifier/:pageId/candidates"] --> B{isGenerating?}
        A3["GET /:identifier/:pageId/candidates/status"] --> B
        A4["Cron: retry-pending-generations"] --> DA[ensureCandidatesForPageWithStrategy<br/>src/utils/candidate-generation.ts:870]
        A5["GitHub workflow (workflow_dispatch)"] --> DA
    end

    B -- "no" --> T[triggerCandidateGenerationWorkflow<br/>src/utils/candidate-generation.ts:1344]
    B -- "yes" --> SSE[pollForCandidateGeneration<br/>src/utils/sse.ts:558 → progress events]
    T --> DA

    A1 --> C
    C --> E[executePromptForJSON<br/>src/utils/prompt.ts:4936]

    DA --> STRAT{strategy}
    STRAT --> |vercel / cron| PAR[generateCandidatesInParallel<br/>src/utils/candidate-generation.ts:572]
    STRAT --> |github-action| SEQ["sequential per-action loop"]
    PAR & SEQ --> GNP[generateNextPages<br/>src/utils/prompt.ts:4756]
    GNP --> E

    E --> WFN[aiPrompt<br/>src/utils/ai-chat.ts:916]
    WFN --> WF{"provider waterfall<br/>AI_CHAT_MODELS_WRITING"}
    WF --> |mistral→gemini→openrouter→…| LLM[AI provider]
    LLM --> RET{"JSON valid?"}
    RET -- "no / repair needed" --> VALIDATE[structured-output repair<br/>schema validation + JSON repair]
    VALIDATE --> EVA{requeue / retry<br/>retryWithBackoffOrNull}<br/>src/utils/retry.ts:255]
    RET -- "yes" --> EV2[Evaluator pass<br/>AI_CHAT_MODELS_EVALUATION]
    EV2 --> EVA2{"pass ≥ threshold?<br/>or hard-fail?"}
    EVA2 -- "fail" --> RETRY2[regenerate / fall back to raw output]
    EVA2 -- "pass" --> OK[generated StoryGeneration]

    OK --> ST["advanceStoryState → prepareNextPageGenerationSetup<br/>src/utils/prompt.ts:4396"]
    ST --> BR[determineBranchIdForPage<br/>src/utils/prompt.ts:4336]
    BR --> PERSIST[persistPageWithState<br/>src/services/book.ts:505]
    PERSIST --> SIDE["post-persist side effects<br/>canon audit + pgvector embedding"]

    subgraph Persistence["Persistence & side effects"]
        SIDE --> DB[pages / story_states / story_branch rows]
        SIDE --> CANON[insertCanonValidationAudit<br/>fire-and-forget]
        SIDE --> VEC[embedPersistedPage → pgvector semantic memory]
    end

    GNP --> DEPTH{"deeper-level<br/>pre-generation?"}
    DEPTH -- "yes (depth < MAX_BRANCHING_PREGENERATION_DEPTH)" --> DA2[recurse ensureCandidatesForPageWithStrategy]
    DA2 --> DB2[advance isGeneratingStartedAt / pendingGenerationCount]
    DB2 --> DONE[clearActionProgressEvents]
```

---

## Synchronous pipeline (the shared core)

### 1. Entry
- **Custom actions:** `generatePageForCustomAction` (`src/services/custom-actions.ts:547`) validates the custom action (Gate 0/Gate 1), then calls the shared single-page generation path. Wrapped in a per-`(bookId, pageId, user, customActionId)` distributed lock.
- **First-page (book creation):** `initializeBook` (`src/utils/prompt.ts:3852`) → `executePromptForJSON<BookCreationResponse>` with `BOOK_CREATION_SCHEMA_DEFINITION` and `AI_CHAT_MODELS_WRITING`. This produces the first page + first set of actions.
- **Pen engine:** `src/services/pen.ts` reuses `advanceStoryState → resolvePageDelta → determineBranchIdForPage` (documented at `pen.ts:976`) for continuation pages.

### 2. Setup & context
`prepareNextPageGenerationSetup` (`prompt.ts:4396`) does:
- Reconstruct/verify base state (`prepareNextPageGenerationContext`, `:4263`) — warns and corrects page-number mismatches.
- Fetch future-note semantic ranking (pgvector) to surface distant callbacks.
- Build the prompt via `buildNextPagePrompt` (`:871`), which assembles:
  - TASK block (`formatNextPageTaskPrompt`, `:2612`)
  - Story context (previous page entries, story bible, semantic memory, current scene anchor)
  - Narrative style
  - Planned characters
  - Branching actions
  - `fieldInstructions` (`buildNextPageFieldInstructions`, `:885`)
  - Review checklist (`buildNextPageReviewChecklist`, `:1160`) — the mandatory "REVIEW & FIX" self-check gate
  - Evaluator prompt (`buildNextPageEvaluatorPrompt`, `:1259`)

### 3. AI call
`executePromptForJSON` (`prompt.ts:4936`) → `aiPrompt` (`src/utils/ai-chat.ts:916`):
- Provider **waterfall** over `AI_CHAT_MODELS_WRITING` (`src/config/ai-clients.ts:373`), trying providers in order on failure.
- Structured-output JSON schema definition per call type; JSON repair + validation on malformed output.
- Retry/backoff via `retryWithBackoffOrNull` (`src/utils/retry.ts:255`) and timeout handling.
- **Evaluator pass** with `AI_CHAT_MODELS_EVALUATION` (`src/config/ai-clients.ts:646`): scores dimension breakdowns; `useStringEvaluatorOutput` decides string-vs-object eval output. If the evaluator fails, `aiPrompt` silently falls back to raw generation output (evaluator is best-effort, non-authoritative).

### 4. Branch determination
`determineBranchIdForPage` (`prompt.ts:4336`):
- Exactly **one** candidate may inherit the parent's `branchId` (the "continuation" fate).
- All other candidates get **fresh** branch ids, guarded against collisions via `usedBranchIds`.
- Re-reads the fresh parent page on the first alternative to avoid stale data.

### 5. Persistence
`persistPageWithState` (`src/services/book.ts:505`):
- **Mode-branching gate:** `sanitizeActionsForMode` truncates to `novel` = 1 action; `interactive`/`multiverse` = 1..MAX. Per-action destination limits are enforced later by `enforceModeOnActionDestinations` during candidate generation.
- Re-validates the generated page (`validateGeneratedPage` — text length, JSON leaks, actions).
- Computes story momentum + per-action tendency scores against the fresh state.
- Writes: `pages` row (with `stateDelta`), `story_states` row, `story_branch` row as needed.
- **Fire-and-forget side effects:** canon audit insert (`insertCanonValidationAudit`) and pgvector semantic-memory embedding of the page + entities.

### 6. Raw generation primitives
- `generateNextPage` (`prompt.ts:4618`) — single candidate; used for custom-action destinations and single-fate paths.
- `generateNextPages` (`prompt.ts:4756`) — N candidates for one action; the workhorse of candidate pre-generation.

---

## Asynchronous candidate pre-generation

### Trigger points
- `GET /:identifier/:pageId/candidates` (`src/routes/books.ts:4352`) — always SSE; if not already generating, fires `triggerCandidateGenerationWorkflow` (maxDepth = `MAX_BRANCHING_PREGENERATION_DEPTH`) then `pollForCandidateGeneration`.
- `GET /:identifier/:pageId/candidates/status` (`books.ts:4492`) — plain JSON three-state machine: generating / done / not-started (triggers workflow on the latter).
- Cron `retryPendingGenerations` (`src/cron/retry-pending-generations.ts`) — batch-processes pages with `pendingGenerationCount > 0`; supports manual trigger via `TRIGGERED_BOOK_ID`/`TRIGGERED_PAGE_ID`/`TRIGGERED_BY_USER` env vars.
- **Note:** a plain page *visit* (`visitBookPage`, `src/services/book-controller.ts:937`) does **not** trigger candidate generation — it only marks visited + records progress. Generation starts only from the candidate endpoints, cron, or custom-action submission.

### Orchestration: `ensureCandidatesForPageWithStrategy` (`src/utils/candidate-generation.ts:870`)
1. **Validation** — skip if last page, depth limit reached, no pending actions, or page is stale.
2. **Strategy select** via `getGenerationStrategy` (`:344`):

| Strategy | `useParallel` | Timeout | Used by |
|---|---|---|---|
| `vercel` | ✅ | ≤ 240s (remaining Vercel budget) | API/SSE requests |
| `cron` | ✅ | 13 min (`MAX_GENERATION_PARALLEL_DURATION_MS`) | cron batch |
| `github-action` | ❌ sequential | 30 min (`MAX_GENERATION_DURATION_MS`) | GitHub workflow |

3. **Distributed locking** — `withLock` / `acquireLock` (`src/utils/distributed-lock.ts`) keyed on the page. If the lock is held, return fresh page state without doing work.
4. **Parallel generation** — `generateCandidatesInParallel` (`:572`): one `generateNextPages` call per pending action, with per-action `timeoutMs`, retry, and progress callbacks.
5. **Progress tracking** — `storeActionProgressEvent` (`src/utils/progress-tracking.ts`) persists per-action progress to the DB; SSE polling reads them via `getActionProgressEvents` with synthetic fallback.
6. **Write-chain serialization** — `onActionProgress` uses a shared promise chain so concurrent AI completions don't overwrite the `actions` JSONB column (parallel-mode hazard).
7. **Mode enforcement** — after generation, `enforceModeOnActionDestinations` caps destination count; novel mode forces exactly 1 action per page before generation.
8. **Deeper-level recursion** — for successfully generated candidate pages, if depth < `MAX_BRANCHING_PREGENERATION_DEPTH` and `ALLOW_DEEPER_LEVEL_UNTIL_PAGE` allows, recurse to pre-generate the next level of branches.
9. **Cleanup** — clears `isGeneratingStartedAt` and completed progress events when all actions resolve.

### Failure & stuck handling
- Per-action failures are retried with backoff, and invalid actions are removed (with a "continue" fallback action if all are invalid — `candidate-generation.ts:1246`).
- `isGeneratingStartedAt` staleness detection: if the start timestamp exceeds `MAX_GENERATION_DURATION_MS` (30 min), the workflow is considered dead and gets reset by the cron.
- Timeout logic (`calculateGenerationTimeout`, `:373`) bails early (§`MIN_AI_TIMEOUT_MS`) rather than wasting an AI call.

---

## Custom actions (on-demand destinations)

Flow (`src/routes/books.ts` + `src/services/custom-actions.ts`):
1. `POST /:identifier/:pageId/custom-actions/preview` (books.ts:5521) — Gate 0/Gate 1 validation prompting + action preview.
2. `POST /:identifier/:pageId/custom-actions/submit` (books.ts:5677) — persist the resolved custom action row.
3. `GET /:identifier/:pageId/custom-actions` reads rows; generation is triggered via `generatePageForCustomAction` (custom-actions.ts:547) using the shared single-candidate `generateNextPage` path, then the action's `destinationPageIds` is populated pointing at the new page.

Notes:
- Display text uses `canonicalIntent` (`buildCanonicalAction` in `custom-actions.ts` / `mapCustomActionRowToAction` in `book.ts`); when the reader's literal `originalText` differs from `text`, `formatSelectedAction` (`src/utils/prompt.ts`) injects the literal request into the prompt.
- Custom-action generation is stale-guarded (`CUSTOM_ACTION_GENERATION_STALE_MS`).

---

## Current-state file reference

| Concern | File | Lines |
|---|---|---|
| Single-page generation | `src/utils/prompt.ts` `generateNextPage` | 4618 |
| Multi-candidate generation | `src/utils/prompt.ts` `generateNextPages` | 4756 |
| Generation setup (context + prompt) | `src/utils/prompt.ts` `prepareNextPageGenerationSetup` | 4396 |
| Context reconstruction | `src/utils/prompt.ts` `prepareNextPageGenerationContext` | 4263 |
| Prompt builders | `src/utils/prompt.ts` (`buildNextPagePrompt` 871, field instructions 885, review checklist 1160, evaluator 1259, task 2612, book-creation 3624) | — |
| AI invocation + evaluator | `src/utils/ai-chat.ts` `aiPrompt` | 916 |
| Provider models (writing) | `src/config/ai-clients.ts` `AI_CHAT_MODELS_WRITING` | 373 |
| Provider models (evaluation) | `src/config/ai-clients.ts` `AI_CHAT_MODELS_EVALUATION` | 646 |
| Story-state advance | `src/utils/story.ts` (`advanceStoryState` 749, `extractStateDelta` 284, `calculatePsychologicalDeltas` 391, `applyStateDelta` 498) | — |
| Branch id resolution | `src/utils/prompt.ts` `determineBranchIdForPage` | 4336 |
| Persistence | `src/services/book.ts` `persistPageWithState` | 505 |
| Visit (does NOT pre-generate) | `src/services/book-controller.ts` `visitBookPage` | 937 |
| Candidate orchestration | `src/utils/candidate-generation.ts` `ensureCandidatesForPageWithStrategy` | 870 |
| Parallel generation | `src/utils/candidate-generation.ts` `generateCandidatesInParallel` | 572 |
| Strategy select | `src/utils/candidate-generation.ts` `getGenerationStrategy` | 344 |
| Workflow trigger | `src/utils/candidate-generation.ts` `triggerCandidateGenerationWorkflow` | 1344 |
| SSE polling | `src/utils/sse.ts` `pollForCandidateGeneration` | 558 |
| Progress events | `src/utils/progress-tracking.ts` (`getActionProgressEvents` 99, `storeActionProgressEvent`) | — |
| Distributed lock | `src/utils/distributed-lock.ts` `withLock` / `acquireLock` | — |
| Retry/backoff | `src/utils/retry.ts` `retryWithBackoffOrNull` | 255 |
| Retry cron | `src/cron/retry-pending-generations.ts` | 1–437 |
| Strategy/time budgets | `src/config/candidate-generation.ts` | 1–24 |
| Mode branching contract | `src/utils/book-mode.ts` | — |
| Custom-action generation | `src/services/custom-actions.ts` `generatePageForCustomAction` | 547 |
| Candidates routes | `src/routes/books.ts` (candidates 4352, status 4492, custom-actions preview 5521, submit 5677) | — |

---

## Divergences from the superseded docs

- **`PRE_GENERATION_FLOW.md`** described a full "automatic pre-generation on page visit" flow. That is **no longer true** — `visitBookPage` only marks visited/records progress. Pre-generation is now explicitly triggered (candidates endpoints, cron, custom actions).
- **`ASYNC_CANDIDATE_GENERATION_ARCHITECTURE.md`** described progress via an **LRU in-memory cache (5-min TTL)** and Express/Next.js framing. Progress is now **DB-backed** (`actionProgress` table) via `progress-tracking.ts`, and the deployment is Hono on Bun/Vercel with three strategies (vercel / cron / github-action).
- Both old docs lacked the **book-mode branching contract** (`novel`/`interactive`/`multiverse`), the **write-chain serialization** hazard, and the **custom-action on-demand path** now implemented.