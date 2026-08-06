/**
 * Pen (AI Co-Writing) service — Phase 1.a session lifecycle, Phase 1.b `/continue`.
 *
 * Model C (draft-then-finalize): one active Pen session per (user, book). The
 * session owns a private span buffer (`draftBuffer`) over one book; `/finalize`
 * is the only way a draft becomes a published page; `/discard` throws it away.
 *
 * @see docs/roadmap/AI_CO_WRITING_PEN_ROADMAP.md §5.3, Phase 1.a, Phase 1.b
 */

import { eq, and } from "drizzle-orm";
import { penSessions, penEdits } from "../db/schema.js";
import { dbRead, dbWrite } from "../db/client.js";
import { getBookFromDB } from "./book.js";
import type { DBBook, DBPenSession } from "../types/schema.js";
import type { AuthoringMode, AuthoringPov, DraftSpan, PenSessionStatus, FinalizeViolation, CanonAmendment, PenEditType } from "../types/pen.js";
import type { BookMode } from "../types/book.js";
import type { StoryState, Action, StoryGeneration, PersistedStoryPage } from "../types/story.js";
import type { CandidateGenerationPage } from "../types/candidate-generation.js";
import type { AIResponseProvider } from "../types/ai-chat.js";
import { getBranchPath } from "../utils/branch-traversal.js";
import { getStoryStateWithBranch } from "./story-branch.js";
import { buildPenContinuePrompt, PEN_CONTINUE_SCHEMA, PEN_CONTINUE_REQUIRED_FIELDS } from "../utils/pen-prompt.js";
import type { PenContinueResult as PenContinueAIOutput } from "../utils/pen-prompt.js";
import { aiPrompt, createAIOptionsWithSchema } from "../utils/ai-chat.js";
import type { AIPromptForJson } from "../types/ai-chat.js";
import { AI_CHAT_MODELS_WRITING } from "../config/ai-clients.js";
import { AI_CHAT_CONFIG_DEFAULT } from "../config/ai-chat.js";
import { generateId } from "../utils/uuid.js";
import { executeWithCredits } from "./credits.js";
import { persistPageWithState, insertStoryPage, getPageFromDB, mapToPersistedStoryPage } from "./book.js";
import { insertStoryState } from "./story.js";
import { advanceStoryState, createEmptyStoryState, createInitialHiddenState } from "../utils/story.js";
import { resolvePageDelta, determineBranchIdForPage } from "../utils/prompt.js";
import { sanitizeActionsForMode, validatePageActionsForMode } from "../utils/book-mode.js";
import { validateGeneratedPage } from "../utils/page-validation.js";

/**
 * The API-facing session payload. Extends the stored session with the book's
 * branching contract (`bookMode`) so the editor knows how many actions it can
 * offer and how Continue/finalize behave (§1.a).
 */
export type PenSessionPayload = DBPenSession & {
  /** `books.mode` — the branching contract the editor must respect. */
  bookMode: BookMode;
};

/**
 * Converts a stored session row into the API payload by attaching the book's
 * mode. Throws if the book no longer exists (session rows cascade on book delete,
 * but a stale FK is still defensively handled).
 */
async function toPenSessionPayload(session: DBPenSession): Promise<PenSessionPayload> {
  const book = await getBookFromDB(session.bookId);
  if (!book) throw new Error(`Book not found for pen session: ${session.bookId}`);
  return { ...session, bookMode: book.mode };
}

/** Error thrown when the requested pen session does not exist or is not owned. */
export class PenSessionNotFoundError extends Error {
  constructor(message = "Pen session not found") {
    super(message);
    this.name = "PenSessionNotFoundError";
  }
}

/** Error thrown when a pen session already exists for the (user, book) pair. */
export class PenSessionConflictError extends Error {
  constructor(message = "An active pen session already exists for this book") {
    super(message);
    this.name = "PenSessionConflictError";
  }
}

/** Error thrown when the authenticated user does not own the target book. */
export class PenBookOwnershipError extends Error {
  constructor(message = "You do not own this book") {
    super(message);
    this.name = "PenBookOwnershipError";
  }
}

/**
 * Creates a Pen session for a book the user owns.
 *
 * @param userId - The authenticated user's id
 * @param params - `bookId`, `authoringMode`, optional `assistanceLevel` (0..1)
 * @throws PenBookOwnershipError if the user is not the book's owner
 * @throws PenSessionConflictError if an active session already exists for the book
 */
export async function createPenSession(
  userId: string,
  params: { bookId: string; authoringMode: AuthoringMode; assistanceLevel?: number; authoringPov?: AuthoringPov | null }
): Promise<PenSessionPayload> {
  const book: DBBook | null = await getBookFromDB(params.bookId);
  if (!book) throw new PenSessionNotFoundError("Book not found");
  if (book.userId !== userId) throw new PenBookOwnershipError();

  const assistanceLevel =
    params.assistanceLevel !== undefined
      ? Math.min(1, Math.max(0, params.assistanceLevel))
      : 0.5;

  const created = await dbWrite.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(penSessions)
      .where(and(eq(penSessions.userId, userId), eq(penSessions.bookId, params.bookId)))
      .limit(1);

    if (existing) throw new PenSessionConflictError();

    const [session] = await tx
      .insert(penSessions)
      .values({
        userId,
        bookId: params.bookId,
        authoringMode: params.authoringMode,
        assistanceLevel,
        authoringPov: params.authoringPov ?? null,
        status: "active",
        draftBuffer: [],
      })
      .returning();

    return session;
  });

  return toPenSessionPayload(created);
}

/**
 * Returns the active (or most recent) Pen session for a book, or null if none.
 *
 * @param userId - The authenticated user's id (ownership guard)
 * @param bookId - The book to look up
 */
export async function getPenSessionForBook(userId: string, bookId: string): Promise<PenSessionPayload | null> {
  const [session] = await dbRead
    .select()
    .from(penSessions)
    .where(and(eq(penSessions.userId, userId), eq(penSessions.bookId, bookId)))
    .orderBy(penSessions.updatedAt)
    .limit(1);

  if (!session) return null;
  return toPenSessionPayload(session);
}

/**
 * Returns a Pen session by id, verifying ownership.
 *
 * @param userId - The authenticated user's id (ownership guard)
 * @param sessionId - The session to load
 * @throws PenSessionNotFoundError if missing or owned by another user
 */
export async function getPenSessionById(userId: string, sessionId: string): Promise<PenSessionPayload> {
  const [session] = await dbRead
    .select()
    .from(penSessions)
    .where(and(eq(penSessions.id, sessionId), eq(penSessions.userId, userId)))
    .limit(1);

  if (!session) throw new PenSessionNotFoundError();
  return toPenSessionPayload(session);
}

/** Allowed PATCH fields on a pen session. */
export type PenSessionUpdates = {
  assistanceLevel?: number;
  status?: PenSessionStatus;
  currentPageId?: string | null;
  authoringPov?: AuthoringPov | null;
};

/**
 * Applies allowed PATCH updates to a session the user owns.
 *
 * @param userId - The authenticated user's id (ownership guard)
 * @param sessionId - The session to update
 * @param updates - `assistanceLevel`, `status`, or `currentPageId`
 * @throws PenSessionNotFoundError if missing or owned by another user
 */
export async function updatePenSession(
  userId: string,
  sessionId: string,
  updates: PenSessionUpdates
): Promise<PenSessionPayload> {
  const values: typeof updates = {};

  if (updates.assistanceLevel !== undefined) {
    values.assistanceLevel = Math.min(1, Math.max(0, updates.assistanceLevel));
  }
  if (updates.status !== undefined) {
    values.status = updates.status;
  }
  if (updates.currentPageId !== undefined) {
    values.currentPageId = updates.currentPageId;
  }
  if (updates.authoringPov !== undefined) {
    values.authoringPov = updates.authoringPov;
  }

  const [updated] = await dbWrite
    .update(penSessions)
    .set(values)
    .where(and(eq(penSessions.id, sessionId), eq(penSessions.userId, userId)))
    .returning();

  if (!updated) throw new PenSessionNotFoundError();
  return toPenSessionPayload(updated);
}

/**
 * Marks a session `closed` (end of the current editing pass; the draft is
 * preserved for resume). Ownership is verified.
 */
export async function closePenSession(userId: string, sessionId: string): Promise<PenSessionPayload> {
  return updatePenSession(userId, sessionId, { status: "closed" });
}

/**
 * Clears the draft buffer without charging credits (`/discard`). Ownership is
 * verified. Returns the cleared session.
 */
export async function discardPenDraft(userId: string, sessionId: string): Promise<PenSessionPayload> {
  const [updated] = await dbWrite
    .update(penSessions)
    .set({ draftBuffer: [] })
    .where(and(eq(penSessions.id, sessionId), eq(penSessions.userId, userId)))
    .returning();

  if (!updated) throw new PenSessionNotFoundError();
  return toPenSessionPayload(updated);
}

/** Errors thrown while running a `/continue` request. */
export class PenContinueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PenContinueError";
  }
}

/** Body of `POST /api/pen/sessions/:id/continue`. Discriminated by `type`. */
export type PenContinueInput =
  | { type: "storyteller"; prose: string; directionHint?: string; authoringPov?: AuthoringPov }
  | { type: "text_adventure"; command: string; authoringPov?: AuthoringPov };

/** Result of a `/continue` request. */
export type PenContinueOutput = {
  /** The appended span record (validated vs dirty). */
  span: DraftSpan;
  /** The audit row for this interaction. */
  edit: {
    id: string;
    editType: "ai_continued";
    authorInput: string | null;
    aiOutput: string;
    contextPageId: string | null;
  };
  /** The full draft buffer after appending. */
  draft: DraftSpan[];
};

/**
 * Credit key per authoring mode + assistance level (§8).
 * Text-adventure commands are a richer generation than a prose assist.
 * Storyteller cost scales with how much of the writing the AI does:
 *   > 0.9 auto-continue · ≤ 0.9 assisted prose · < 0.3 free suggestion.
 */
function continueCreditKey(session: { authoringMode: AuthoringMode; assistanceLevel: number }): "PEN_ASSIST" | "PEN_COMMAND" | "PEN_AUTO_CONTINUE" | "PEN_SUGGEST" {
  if (session.authoringMode === "text_adventure") return "PEN_COMMAND";
  if (session.assistanceLevel > 0.9) return "PEN_AUTO_CONTINUE";
  if (session.assistanceLevel < 0.3) return "PEN_SUGGEST";
  return "PEN_ASSIST";
}

/**
 * Runs the `/continue` generation for an owned pen session (Phase 1.b).
 *
 * Single-request validate-and-generate contract: one AI call returns
 * `{ text, issues }` where `issues` is the model's own canon self-report.
 * A clean result marks the span `validated` against the current
 * `books.canonVersion`; self-reported issues mark it `dirty` so the finalize
 * delta-gate re-checks it. Never auto-regenerates.
 *
 * @param userId - The authenticated user's id (ownership guard)
 * @param sessionId - The session to continue
 * @param input - Discriminated body: storyteller prose or text-adventure command
 * @throws PenSessionNotFoundError / PenBookOwnershipError if not owned
 * @throws PenContinueError if the AI returns no usable text
 */
export async function continuePenDraft(
  userId: string,
  sessionId: string,
  input: PenContinueInput
): Promise<PenContinueOutput> {
  const session = await getPenSessionById(userId, sessionId);
  const book: DBBook | null = await getBookFromDB(session.bookId);
  if (!book) throw new PenContinueError("Book not found for this session");

  if (session.status !== "active") {
    throw new PenContinueError("Session is not active; reopen it before continuing");
  }

  // Story state + recent prose from the last published page, when one exists.
  let state: StoryState | null = null;
  let pageTexts: string[] = [];
  let momentum: string | null = null;
  let sceneType: string | null = null;

  if (session.currentPageId) {
    state = await getStoryStateWithBranch(book.id, session.currentPageId);
    const branch = await getBranchPath(session.currentPageId);
    pageTexts = branch.pages.map((p) => p.text).filter(Boolean);
    const last = branch.pages[branch.pages.length - 1];
    momentum = last?.momentum ?? null;
    sceneType = last?.sceneType ?? null;
  }

  const mcName = book.mc?.knownName || book.mc?.name || "";
  const language = book.language || "en";

  // §10 E: per-interaction authoringPov overrides the session default.
  const authoringPov = input.authoringPov ?? session.authoringPov ?? undefined;

  const shared = {
    state,
    authoringMode: session.authoringMode,
    pageTexts,
    mcName,
    language,
    storyStartDate: book.storyStartDate ?? null,
    momentum,
    sceneType,
  };

  const { systemPrompt, userPrompt } =
    input.type === "text_adventure"
      ? buildPenContinuePrompt({ ...shared, command: input.command, authoringPov })
      : buildPenContinuePrompt({ ...shared, prose: input.prose, directionHint: input.directionHint, authoringPov });

  const promptConfig: AIPromptForJson<PenContinueAIOutput> = {
    schema: PEN_CONTINUE_SCHEMA,
    requiredFields: PEN_CONTINUE_REQUIRED_FIELDS,
    fallbackField: "text",
    baseOptions: {
      modelSelection: AI_CHAT_MODELS_WRITING,
      context: "pen-continue",
      systemPrompt,
      config: { ...AI_CHAT_CONFIG_DEFAULT, maxOutputToken: 1000 },
    },
  };

  const aiResponse = await aiPrompt<PenContinueAIOutput>(userPrompt, createAIOptionsWithSchema(promptConfig));
  const output = aiResponse.result;

  if (!output || typeof output.text !== "string" || output.text.trim().length === 0) {
    throw new PenContinueError("AI returned no continuation text");
  }

  const issues = Array.isArray(output.issues) && output.issues.length > 0
    ? output.issues.filter((i) => i && typeof i.expected === "string" && typeof i.found === "string")
    : [];

  // Clean AI output is considered validated against the current canon version;
  // self-reported issues (or any flagged output) leave the span dirty.
  const clean = issues.length === 0;
  const span: DraftSpan = {
    id: generateId(),
    text: output.text.trim(),
    origin: "ai",
    validationState: clean ? "validated" : "dirty",
    validatedAgainst: clean ? book.canonVersion : undefined,
  };

  const authorInput = input.type === "text_adventure" ? input.command : input.prose;

  const { result } = await executeWithCredits(
    userId,
    continueCreditKey(session),
    async (tx) => {
      const [current] = await tx
        .select()
        .from(penSessions)
        .where(and(eq(penSessions.id, sessionId), eq(penSessions.userId, userId)))
        .limit(1);
      if (!current) throw new PenSessionNotFoundError();

      const nextBuffer = [...(current.draftBuffer ?? []), span];

      const [updated] = await tx
        .update(penSessions)
        .set({ draftBuffer: nextBuffer, status: "active", updatedAt: new Date() })
        .where(and(eq(penSessions.id, sessionId), eq(penSessions.userId, userId)))
        .returning();

      if (!updated) throw new PenSessionNotFoundError();

      const editId = generateId();
      await tx.insert(penEdits).values({
        id: editId,
        sessionId,
        userId,
        bookId: book.id,
        pageId: null,
        editType: "ai_continued",
        authorInput: authorInput || null,
        aiOutput: span.text,
        finalText: span.text,
        contextPageId: session.currentPageId,
        authoringMode: session.authoringMode,
        authoringPov: authoringPov ?? null,
        createdAt: new Date(),
      });

      return updated;
    },
    { context: "pen_continue", metadata: { sessionId, bookId: book.id } }
  );

  return {
    span,
    edit: {
      id: result.id,
      editType: "ai_continued",
      authorInput: authorInput || null,
      aiOutput: span.text,
      contextPageId: session.currentPageId,
    },
    draft: result.draftBuffer,
  };
}

/** Errors thrown while running a `/finalize` request. */
export class PenFinalizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PenFinalizeError";
  }
}

/**
 * Body of `POST /api/pen/sessions/:id/finalize` (§6.7).
 *
 * `force` publishes even when the delta gate found high-severity findings
 * (the confirm sheet's "Proceed anyway"). `amendments` are optional
 * "adopt this override as the new canon" requests processed atomically with
 * the publish. `actions` supplies the author-defined next choices for the
 * new page in interactive/multiverse mode (novel always uses the single
 * default); clamped to the book's mode branching contract.
 */
export type PenFinalizeInput = {
  force?: boolean;
  amendments?: CanonAmendment[];
  actions?: { text: string; type: string; hint?: { text?: string; type?: string } }[];
};

/** Result of a `/finalize` request. */
export type PenFinalizeOutput =
  | {
      status: "needs_review";
      /** Non-empty when the gate found high-severity findings without `force`. */
      violations: FinalizeViolation[];
      pageNumber: number;
      draft: DraftSpan[];
    }
  | {
      status: "published";
      page: PersistedStoryPage;
      pageNumber: number;
      violations: FinalizeViolation[];
      spans: DraftSpan[];
      draft: DraftSpan[];
    };

/** Synthetic AI-response provider for pen-authored pages (no AI call at finalize). */
const PEN_AI_RESPONSE_PROVIDER: AIResponseProvider = {
  model: "pen-finalize",
  provider: "none",
  evalModel: "pen-finalize",
  evalProvider: "none",
  scoreBefore: undefined,
  scoreAfter: undefined,
};

/** Default single action for a linear (novel) continuation page. */
const DEFAULT_CONTINUE_ACTION: Action = {
  text: "Continue",
  type: "explore",
  hint: { text: "Continue the story", type: "none" },
};

/** Maps a draft span's origin to its `pen_edits.editType` (§0.b). */
const SPAN_ORIGIN_TO_EDIT_TYPE: Record<DraftSpan["origin"], PenEditType> = {
  human: "human_wrote",
  ai: "ai_continued",
  revised: "human_revised",
};

/**
 * Joins the draft spans into the final page text and computes each span's
 * character offsets within it (written to `pen_edits` at finalize, §0.b).
 * Spans are joined with a single space; offsets are accumulated over the
 * exact joined string so they always slice back to the original span text.
 */
function assembleDraft(spans: DraftSpan[]): { text: string; spans: DraftSpan[] } {
  let offset = 0;
  const positioned = spans.map((span) => {
    const start = offset;
    const text = span.text ?? "";
    const end = start + text.length;
    offset = end + 1; // reserve the joining space
    return { ...span, charOffsetStart: start, charOffsetEnd: end };
  });
  return { text: positioned.map((s) => s.text).join(" "), spans: positioned };
}

/**
 * Normalizes the author-provided next-action list (interactive/multiverse) or
 * falls back to the single default Continue action (novel), then enforces the
 * book's branching contract. Throws `PenFinalizeError` if the count violates
 * the mode's action-count rule.
 */
function buildNewPageActions(book: DBBook, rawActions?: PenFinalizeInput["actions"]): Action[] {
  const mode: BookMode = book.mode;
  const provided: Action[] = Array.isArray(rawActions) && rawActions.length > 0
    ? rawActions.map((a) => ({
        text: typeof a.text === "string" && a.text.trim() ? a.text.trim() : "Continue",
        type: (a.type && ["explore", "escape", "social", "risk", "ignore", "attack", "deceive", "protect", "create", "heal", "dialogue", "custom", "other"].includes(a.type) ? a.type : "explore") as Action["type"],
        hint: { text: a.hint?.text ?? a.text ?? "Continue", type: (a.hint?.type ?? "none") as Action["hint"]["type"] },
      }))
    : [DEFAULT_CONTINUE_ACTION];

  const actions = sanitizeActionsForMode(mode, provided);
  try {
    validatePageActionsForMode(mode, actions);
  } catch (error) {
    throw new PenFinalizeError(error instanceof Error ? error.message : `Invalid actions for mode "${mode}"`);
  }
  return actions;
}

/**
 * Phase A of `/finalize` — the delta gate (§6.7).
 *
 * The eligible set is `dirty` ∪ stale spans (`validatedAgainst !==
 * books.canonVersion`). Clean, current AI spans are skipped entirely — this is
 * the usage-saving contract (§1.b). For the launcher (Phase 1.c) there is no
 * lore bible yet, so the v1 gate only flags the eligible set itself; a real
 * rule-based/LLM pass slots in when Phase 5 lands. No finding is ever a hard
 * block: the author is the final authority.
 *
 * @returns Findings, grouped high-first. Empty when every span is clean+current.
 */
function runFinalizeDeltaGate(session: { draftBuffer: DraftSpan[] }, canonVersion: number): FinalizeViolation[] {
  const eligible = session.draftBuffer.filter((span) =>
    span.validationState === "dirty" ||
    (span.validatedAgainst !== undefined && span.validatedAgainst !== canonVersion)
  );

  if (eligible.length === 0) return [];

  // Launcher v1: flag the unverified text as a low-severity informational
  // finding so the confirm sheet can show "N unverified spans". Phase 5 adds
  // per-entity lore/fact/character-memory checks here.
  return [{
    severity: "low",
    source: "fact",
    entryName: "Unverified draft text",
    field: "canonConsistency",
    expected: `All ${eligible.length} span${eligible.length === 1 ? "" : "s"} verified against canon v${canonVersion}`,
    found: `${eligible.length} unverified span${eligible.length === 1 ? "" : "s"}`,
    excerpt: eligible[0].text.slice(0, 140),
    suggestion: "Review the highlighted text before publishing.",
  }];
}

/**
 * Publishes the session's draft as the next story page (Phase 1.c, Decision M).
 *
 * The pen adapter shapes the author's draft into a real `StoryGeneration` and
 * then publishes through the engine's single-page path — the exact sequence
 * `generateNextPage` uses, minus the AI call:
 *
 *   advanceStoryState → resolvePageDelta → determineBranchIdForPage →
 *   persistPageWithState.
 *
 * For the author's very first page (no `currentPageId`) it follows the
 * `initializeBook` page-1 path (`insertStoryPage` + `insertStoryState`).
 *
 * @param userId - The authenticated user's id (ownership guard)
 * @param sessionId - The session to finalize
 * @param input - `force`, `amendments`, and optional next-page `actions`
 * @throws PenSessionNotFoundError if missing or owned by another user
 * @throws PenFinalizeError if the draft is empty, the session isn't active, or
 *   the engine rejects the shaped page
 */
export async function finalizePenDraft(
  userId: string,
  sessionId: string,
  input: PenFinalizeInput = {}
): Promise<PenFinalizeOutput> {
  const session = await getPenSessionById(userId, sessionId);
  const book: DBBook | null = await getBookFromDB(session.bookId);
  if (!book) throw new PenFinalizeError("Book not found for this session");

  if (session.status !== "active") {
    throw new PenFinalizeError("Session is not active; reopen it before finalizing");
  }

  const spans = session.draftBuffer ?? [];
  if (spans.length === 0 || !spans.some((s) => (s.text ?? "").trim().length > 0)) {
    throw new PenFinalizeError("Draft is empty; nothing to finalize");
  }

  const { text: draftText, spans: positionedSpans } = assembleDraft(spans);
  const pageNumber = session.currentPageId
    ? ((await getPageFromDB(session.currentPageId))?.page ?? 0) + 1
    : 1;

  // ── Phase A: delta gate (advisory, never blocks) ─────────────────────────
  const violations = runFinalizeDeltaGate(session, book.canonVersion);
  const highFindings = violations.filter((v) => v.severity === "high");
  if (highFindings.length > 0 && !input.force) {
    return { status: "needs_review", violations, pageNumber, draft: session.draftBuffer };
  }

  // ── Phase B: publish through the engine ───────────────────────────────────
  const actions = buildNewPageActions(book, input.actions);

  let newPage: PersistedStoryPage;

  try {
    if (session.currentPageId) {
      // Continuation: single-page engine path (mirrors generateNextPage).
      const dbCurrentPage = await getPageFromDB(session.currentPageId);
      if (!dbCurrentPage) throw new PenFinalizeError("Current page not found; cannot continue");
      const currentPage = mapToPersistedStoryPage(dbCurrentPage);

      const currentState = await getStoryStateWithBranch(book.id, session.currentPageId);
      if (!currentState) throw new PenFinalizeError("Story state unavailable; cannot finalize continuation");

      const action: Action = currentPage.actions?.[0] ?? DEFAULT_CONTINUE_ACTION;
      const actionedPage: CandidateGenerationPage = { ...currentPage, action };

      const generatedStoryPage: StoryGeneration = {
        text: draftText,
        actions,
        mood: currentPage.mood,
        placeId: currentPage.placeId,
        weather: currentPage.weather,
        calendarDate: currentPage.calendarDate,
        timeOfDay: currentPage.timeOfDay,
        sceneType: currentPage.sceneType,
        charactersPresent: currentPage.charactersPresent,
      };

      const advancedState = await advanceStoryState(currentState, actionedPage);

      const { newState, fullStateDelta } = resolvePageDelta({
        generatedStoryPage,
        advancedState,
        currentState,
        expectedPageNumber: pageNumber,
        context: "pen-finalize",
      });

      const parentBranchId = currentPage.branchId ?? "main";
      const usedBranchIds = new Set<string>();
      const branchId = await determineBranchIdForPage({
        generateNewBranchId: false,
        isFirstAlternative: true,
        parentBranchId,
        usedBranchIds,
        actionedPage,
        action,
      });
      usedBranchIds.add(branchId);

      newPage = await persistPageWithState({
        userId,
        expectedPageNumber: pageNumber,
        generatedStoryPage,
        fullStateDelta,
        newState,
        aiResponseProvider: PEN_AI_RESPONSE_PROVIDER,
        actionedPage,
        action,
        branchId,
        usedBranchIds,
        context: "pen-finalize",
        book: { id: book.id, storyStartDate: book.storyStartDate ?? undefined, mode: book.mode, visibility: book.visibility, status: book.status },
      });
    } else {
      // First page of the book (mirrors initializeBook's page-1 path).
      const pageToInsert = {
        ...generatedFirstPage(draftText, actions),
        stateDelta: {},
      };
      validateGeneratedPage(pageToInsert, book.mode, "pen-finalize");
      validatePageActionsForMode(book.mode, pageToInsert.actions);

      newPage = await insertStoryPage(userId, 1, pageToInsert, {
        bookId: book.id,
        branchId: "main",
        aiResponseProvider: PEN_AI_RESPONSE_PROVIDER,
        storyStartDate: book.storyStartDate ?? undefined,
      });

      const initialState: StoryState = {
        ...createEmptyStoryState(newPage.id, 1, book.totalPages ?? newPage.page),
        hiddenState: createInitialHiddenState(),
      };
      await insertStoryState(book.id, newPage.id, initialState, "original");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown engine error during publish";
    throw new PenFinalizeError(`Publish rejected by the story engine: ${message}`);
  }

  // ── Phase C: roll up pen_edits spans + offsets, clear the draft ───────────
  const editRows = positionedSpans.map((span) => ({
    editId: generateId(),
    span,
  }));

  await dbWrite.transaction(async (tx) => {
    for (const { editId, span } of editRows) {
      await tx.insert(penEdits).values({
        id: editId,
        sessionId,
        userId,
        bookId: book.id,
        pageId: newPage.id,
        editType: SPAN_ORIGIN_TO_EDIT_TYPE[span.origin] ?? "human_wrote",
        authorInput: null,
        aiOutput: span.origin === "ai" ? span.text : null,
        finalText: span.text,
        contextPageId: session.currentPageId,
        charOffsetStart: span.charOffsetStart ?? null,
        charOffsetEnd: span.charOffsetEnd ?? null,
        authoringMode: session.authoringMode,
        authoringPov: session.authoringPov ?? null,
        createdAt: new Date(),
      });
    }

    await tx
      .update(penSessions)
      .set({ draftBuffer: [], currentPageId: newPage.id, status: "active", updatedAt: new Date() })
      .where(and(eq(penSessions.id, sessionId), eq(penSessions.userId, userId)));
  });

  return {
    status: "published",
    page: newPage,
    pageNumber: newPage.page,
    violations,
    spans: editRows.map((r) => r.span),
    draft: [],
  };
}

/**
 * Builds the minimal first-page `StoryGeneration` for a pen-authored page-1
 * publish. Scene context defaults to neutral until the author's first page
 * establishes it.
 */
function generatedFirstPage(text: string, actions: Action[]): StoryGeneration {
  return {
    text,
    actions,
    sceneType: "transition",
  };
}
