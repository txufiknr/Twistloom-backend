# Twistloom — Pen Branch Ending ("The End") & Dynamic StoryState.maxPage Roadmap

**Date:** August 19, 2026  
**Date:** August 19, 2026  
**Status:** Complete (Implemented & Verified)  
**Scope:** Architecture and execution roadmap for enabling writers to mark any story page ($\ge \text{PEN\_MIN\_ENDING\_PAGE}$) as a terminal conclusion ("The End"), decoupling reader completion from the book-level `book.totalPages` estimate in favor of the authoritative, path-local `story_states.maxPage`, and wiring seamless support across the Pen Editor, Outline Tree, and Story Reader.

---

## Implementation Status (at a glance)

| Status | Phase | Scope | Key Deliverables & Files |
|---|---|---|---|
| ✅ **DONE** | **Phase 1: Config & Contract Alignment** | Minimum ending page threshold & API types | `config/story.ts`, `config/pen.ts`, `types/pen.ts`, `types/story.ts`, `messages/*.json` |
| ✅ **DONE** | **Phase 2: Backend Finalize Service** | Terminal page publishing & state capping | `finalizePenDraft` in `services/pen.ts`, `POST /api/pen/sessions/:id/finalize` in `routes/pen.ts` |
| ✅ **DONE** | **Phase 3: Pen Editor UX & Controls** | "Mark as The End" toggle & publish flow | `PenDrawer.tsx`, `PenEditorClient.tsx`, action-text bar suppression |
| ✅ **DONE** | **Phase 4: Reader Decoupling** | Switch ending trigger from `book.totalPages` to `state.maxPage` | `ReaderActionFooter.tsx`, `TheEndButton.tsx`, `PageNavigationButtons.tsx`, `mapToEnrichedPage` |
| ✅ **DONE** | **Phase 5: Outline & Peek Badging** | Ending leaf node visualization & modal controls | `OutlinePanel.tsx` (🏁 pill), `PageViewerModal.tsx` ("Ending Page" badge) |

---

## 1. Executive Summary & Narrative Philosophy

In interactive, branching, and multiverse fiction, **different storylines conclude at different depths**. A high-stakes risk branch might meet a tragic, thrilling demise at Page 6, while an epic investigative spine unfolds across 16 pages.

### The Problem with Static `book.totalPages`
1. **`book.totalPages` is a single book-wide scalar:** It represents an initial author estimate or aggregate average across all pages. It cannot represent the narrative truth of an individual branch.
2. **Reader Completion Bug:** Currently, `ReaderActionFooter.tsx` and `StorySegment.tsx` conditionally render `<TheEndButton>` only when `page.page >= book.totalPages`. If an author ends a branch at Page 6 in a 10-page book:
   - The reader sees no choices (because none were generated).
   - The reader is denied `<TheEndButton>` (because $6 < 10$).
   - **Result:** The UI hangs in a perpetual generating skeleton or dead end.
3. **The Invariant Source of Truth:** `story_states.maxPage` is already the path-local denominator that travels down each ancestor chain. When a writer concludes a branch at Page $N$, `story_states.maxPage` for that terminal page must equal $N$, authoritatively signaling to the reader engine that the branch is complete.

---

## 2. Technical Architecture & Invariants

```mermaid
flowchart TD
    A[Writer drafting Page >= PEN_MIN_ENDING_PAGE] --> B{Toggle: 'Mark as The End'?}
    
    B -- Unchecked (Continuation) --> C[Requires Choice Text / Next Actions]
    C --> D[Finalize Page N: actions populated, maxPage >= N+1]
    D --> E[Outline shows standard leaf / missing action alert]
    D --> F[Reader renders Action Buttons / Next Page Nav]
    
    B -- Checked (Terminal Ending) --> G[Choice Text Hidden & Validation Bypassed]
    G --> H[Finalize Ending: actions = [], StoryState.maxPage = N]
    H --> I[Outline shows 🏁 'The End' badge]
    H --> J[Reader detects page >= state.maxPage -> renders TheEndButton]
    J --> K[Reader clicks 'Close Case / The End' -> /ending Debrief Page]
```

### 2.1 Configurable Threshold (`PEN_MIN_ENDING_PAGE`)
To prevent accidental premature endings before a narrative foundation is built, ending affordances are gated by a shared constant:
- **Backend:** `PEN_MIN_ENDING_PAGE = 5` in `Twistloom-backend/src/config/story.ts`.
- **Frontend:** `PEN_MIN_ENDING_PAGE = 5` in `Twistloom-web/src/lib/config/pen.ts`.

---

### 2.2 Finalize State Machine (`finalizePenDraft`)

When `POST /api/pen/sessions/:id/finalize` is invoked with `isEnding: true`:
1. **Action Generation:** `actions` is set to `[]` (empty array). No outgoing choices or placeholder continue actions are created on the terminal page.
2. **Dynamic `maxPage` Resolution:** Instead of monotonic growth against `book.totalPages`, the branch ceiling is authoritatively capped:
   ```ts
   if (input.isEnding) {
     newState.maxPage = pageNumber;
   } else {
     newState.maxPage = Math.max(currentState.maxPage, book.totalPages ?? pageNumber, pageNumber);
   }
   ```
3. **Ending Classification:** `generatedStoryPage.isDeadEnd = true`. The AI state proposal optionally classifies a canonical ending archetype into `story_states.viableEnding` (e.g. `triumph`, `pyrrhic_victory`, `cosmic_cycle`).

---

### 2.3 Reader Engine Decoupling

In `ReaderActionFooter.tsx`, `StorySegment.tsx`, and `PageNavigationButtons.tsx`, the terminal check is corrected:

```tsx
// BEFORE (Buggy static check):
const isTerminalPage = page.page >= book.totalPages;

// AFTER (Authoritative dynamic state check):
const branchMaxPage = page.context?.maxPage ?? page.storyState?.maxPage ?? book.totalPages;
const isTerminalPage = page.page >= branchMaxPage || (page.actions && page.actions.length === 0);
```

When `isTerminalPage` is true:
- The reader renders `<TheEndButton page={page} bookSlug={bookSlug} />`.
- Clicking the button routes the reader to `/books/${bookSlug}/${page.id}/ending` for the comprehensive ending debrief card, narrative stats, and replay options.

---

### 2.4 Editor Workspace & Drawer Experience

1. **Publish Card (`PenDrawer.tsx`)**:
   - When `currentPageNumber >= PEN_MIN_ENDING_PAGE`, an elegant switch appears above the publish button:
     > 🏁 **Mark as Story / Branch Ending**  
     > *Conclude this timeline. Readers reaching this page will see "The End" and transition to the ending debrief.*
2. **Choice Text Input Bar (`PenEditorClient.tsx`)**:
   - When active, the choice-text input above `ProseEditor` transforms into a clean, informative state:
     > 🏁 *Story / Branch Ending — No outgoing reader choices needed.*
   - `draftMissingActionText` validation is automatically satisfied (0 choices required).
3. **Publish Action**:
   - The primary button dynamically updates its label: **"Publish Ending 🏁"**.

---

### 2.5 Outline & Modal Badging

1. **`OutlinePanel.tsx`**:
   - Nodes where `page.actions.length === 0` or `page.isEnding` render a distinctive 🏁 **"The End"** badge/pill instead of a warning.
2. **`PageViewerModal.tsx`**:
   - Header badge displays **"Ending Page"**.
   - Footer removes **"Continue from here"** (since the timeline is concluded), while preserving **"Branch from here"** (allowing authors to fork alternative timelines from this page).

---

## 3. Phased Implementation Plan

### Phase 1: Config & Contract Alignment (Backend + Frontend)
- Add `PEN_MIN_ENDING_PAGE = 5` to `Twistloom-backend/src/config/story.ts` and `Twistloom-web/src/lib/config/pen.ts`.
- Add `isEnding?: boolean` to `PenFinalizeInput` in backend and frontend types.
- Add localized strings to `messages/en.json` and `messages/id.json`:
  - `editor.markAsEnding`, `editor.markAsEndingHint`, `editor.publishEnding`, `editor.endingNoActionNeeded`, `outline.endingBadge`.

### Phase 2: Backend Finalize Service & Route (Backend)
- Update `finalizePenDraft` in `Twistloom-backend/src/services/pen.ts`:
  - Support `input.isEnding`.
  - Set `actions: []` on ending pages.
  - Pin `newState.maxPage = pageNumber`.
- Update `POST /api/pen/sessions/:id/finalize` route validation in `Twistloom-backend/src/routes/pen.ts`.

### Phase 3: Pen Editor UX & Controls (Frontend)
- Update `PenDrawer.tsx` to host the ending switch when `currentPageNumber >= PEN_MIN_ENDING_PAGE`.
- Update `PenEditorClient.tsx`:
  - Track `isEndingDraft` state.
  - Suppress choice-text requirements when `isEndingDraft === true`.
  - Pass `isEnding: true` into `penApi.finalizeDraft`.

### Phase 4: Reader Decoupling & Ending Debrief Fix (Frontend)
- Update `ReaderActionFooter.tsx`, `StorySegment.tsx`, and `PageNavigationButtons.tsx`:
  - Replace `page.page >= book.totalPages` with `page.page >= (page.context?.maxPage ?? book.totalPages) || page.actions?.length === 0`.
  - Ensure `<TheEndButton>` renders accurately on any branch ending.

### Phase 5: Outline Panel & Page Peek Visualization (Frontend)
- In `OutlinePanel.tsx`, badge terminal nodes with a 🏁 **End** pill.
- In `PageViewerModal.tsx`, display the ending indicator and hide the forward continue button.

---

## 4. Open Questions & Recommended Decisions

### Question 1: Can an author still "Branch from here" from a page marked as "The End"?
> **Recommendation: YES (Fully Allowed)**  
> **Rationale:** In interactive multiverse fiction, an author may establish Page 6 as a tragic ending (Ending A), but later decide to fork an alternative timeline from Page 6 (or Page 5) where the protagonist survives (Ending B). Allowing **"Branch from here"** from an ending page creates a sibling continuation under the same parent without altering the validity of Ending A.

---

### Question 2: How should `book.totalPages` behave when multiple branches have different lengths?
> **Recommendation: Keep `book.totalPages` as a dynamic book-level aggregate, while `StoryState.maxPage` governs the branch.**  
> **Rationale:** `book.totalPages` displayed on book cards and discovery carousels should reflect the average or maximum depth across published pages. However, the reader engine must *strictly* evaluate `StoryState.maxPage` and `page.actions.length === 0` to decide if the reader has reached a conclusion.

---

### Question 3: Should concluding a story prompt the author to select/confirm an ending archetype?
> **Recommendation: Auto-classify via AI proposal with optional author override in StateAdoptDialog.**  
> **Rationale:** When `proposeFinalizeState` runs on an ending page, the AI can classify the ending archetype (`viableEnding`: e.g. `triumph`, `bittersweet`, `tragedy`, `open_ended`). The author can review it in the publish dialog, and the reader's `/ending` debrief page will display the matching thematic badge.
