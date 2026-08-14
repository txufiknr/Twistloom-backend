/**
 * Pen (AI Co-Writing) service — Phase 1.a session lifecycle, Phase 1.b `/continue`.
 *
 * Model C (draft-then-finalize): one active Pen session per (user, book). The
 * session owns a private span buffer (`draftBuffer`) over one book; `/finalize`
 * is the only way a draft becomes a published page; `/discard` throws it away.
 *
 * @see docs/roadmap/AI_CO_WRITING_PEN_ROADMAP.md §5.3, Phase 1.a, Phase 1.b
 */

import { eq, and, desc } from "drizzle-orm";
import { penSessions, penEdits, branches, pages } from "../db/schema.js";
import { dbRead, dbWrite } from "../db/client.js";
import { getBookFromDB, getBookPages } from "./book.js";
import { getTriggeredLoreEntries, listLoreEntries } from "./lore.js";
import type { DBBook, DBPenSession } from "../types/schema.js";
import type { AuthoringMode, AuthoringPov, DraftSpan, PenDraftCharacter, PenDraftSceneEssentials, PenEdit, PenSessionStatus, FinalizeViolation, CanonAmendment, PenEditType, PenOutlineData, PenOutlinePage, PenAuthorPage, AuthorshipOrigin } from "../types/pen.js";
import type { BookMode } from "../types/book.js";
import type { StoryState, Action, StoryGeneration, PersistedStoryPage, SceneCharacter, CharacterSceneRole, Mood } from "../types/story.js";
import { moods } from "../types/story.js";
import type { PlaceWeather } from "../types/places.js";
import { placeWeathers } from "../types/places.js";
import type { CandidateGenerationPage } from "../types/candidate-generation.js";
import type { AIResponseProvider } from "../types/ai-chat.js";
import type { CharacterMemory, NewCharacter, StoryMC, Injury, InventoryItem } from "../types/character.js";
import { injuryCategories } from "../types/character.js";
import type { Gender } from "../types/user.js";
import { getBranchPath } from "../utils/branch-traversal.js";
import { processCharacterUpdates, isMainCharacterValid } from "../utils/characters.js";
import { getStoryStateWithBranch } from "./story-branch.js";
import { buildPenContinuePrompt, PEN_CONTINUE_SCHEMA, PEN_CONTINUE_REQUIRED_FIELDS, buildPenEssentialsAutofillPrompt, PEN_ESSENTIALS_SCHEMA, PEN_ESSENTIALS_REQUIRED_FIELDS, PEN_ESSENTIALS_REVIEW_SCHEMA, buildPenStateProposalPrompt, PEN_STATE_PROPOSAL_SCHEMA, PEN_STATE_PROPOSAL_REQUIRED_FIELDS } from "../utils/pen-prompt.js";
import type { PenContinueResult as PenContinueAIOutput, PenEssentialsAutofillResult as PenEssentialsAIOutput, PenStateProposalResult as PenStateProposalAIOutput } from "../utils/pen-prompt.js";
import { aiPrompt, createAIOptionsWithSchema } from "../utils/ai-chat.js";
import type { AIPromptForJson } from "../types/ai-chat.js";
import { AI_CHAT_MODELS_WRITING } from "../config/ai-clients.js";
import { AI_CHAT_CONFIG_DEFAULT } from "../config/ai-chat.js";
import { PEN_DRAFT_CAST_LIMIT, PEN_CONTINUE_MAX_TOKENS, penContinueLengthForAssistance, PEN_ESSENTIALS_MAX_TOKENS, PEN_ESSENTIALS_MAX_LIST_ITEMS, PEN_ESSENTIALS_MAX_ITEM_LENGTH, PEN_ESSENTIALS_MAX_FIELD_LENGTH, PEN_FINALIZE_PROPOSE_MAX_TOKENS, PEN_FINALIZE_PROPOSE_MAX_INVENTORY_ITEMS, PEN_FINALIZE_PROPOSE_MAX_INJURIES, PEN_FINALIZE_PROPOSE_MAX_ITEM_LENGTH, PEN_FINALIZE_PROPOSE_MAX_TRAITS } from "../config/story.js";
import { generateId } from "../utils/uuid.js";
import { executeWithCredits } from "./credits.js";
import { persistPageWithState, insertStoryPage, getPageFromDB, mapToPersistedStoryPage } from "./book.js";
import { insertStoryState } from "./story.js";
import { advanceStoryState, createEmptyStoryState, createInitialHiddenState } from "../utils/story.js";
import { resolvePageDelta, determineBranchIdForPage } from "../utils/prompt.js";
import { sanitizeActionsForMode, validatePageActionsForMode, maxDestinationsPerActionForMode } from "../utils/book-mode.js";
import { validateGeneratedPage } from "../utils/page-validation.js";
import { runGate1 } from "./custom-actions.js";
import { calculateHealthStatus } from "../utils/characters.js";

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
  // Read replica can lag a just-created book (see createPenSession) — fall back
  // to the write client before concluding the book is gone.
  const book =
    (await getBookFromDB(session.bookId)) ??
    (await getBookFromDB(session.bookId, { client: dbWrite }));
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
  // The book is usually created milliseconds before this runs (POST /books/pen
  // writes via dbWrite). The read replica may not have it yet, so fall back to
  // the write client before declaring it missing — otherwise a fresh Pen book
  // is reported as "not found" and the client misreads it as a non-owner error.
  const book: DBBook | null =
    (await getBookFromDB(params.bookId)) ??
    (await getBookFromDB(params.bookId, { client: dbWrite }));
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
    .orderBy(desc(penSessions.updatedAt))
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

/** Result of `GET /sessions/:id/state` (§1.e). */
export type PenSessionStateOutput = {
  /**
   * Story state for the session's current published page — the same
   * StoryState shape the reader companion consumes (characters, places,
   * threads, flags, psychologicalProfile, memoryIntegrity, contextHistory,
   * futureNotes). `null` before page 1 finalizes.
   */
  state: StoryState | null;
  /** The published page this state belongs to (null pre-page-1). */
  currentPageId: string | null;
  /** Page number of the state (0 pre-page-1). */
  pageNumber: number;
  /**
   * Scene essentials of the session's current published page (placeId, mood,
   * weather, calendarDate, timeOfDay, keyEvents, keyObjects) — prefills the
   * drawer's Page Essentials panel for the next draft. `null` pre-page-1.
   */
  pageEssentials: PenDraftSceneEssentials | null;
};

/**
 * Returns the story state for a session's current published page (§1.e).
 *
 * Reuses `getStoryStateWithBranch` so the Pen drawer sees exactly what the
 * reader companion consumes; no new response type. Before page 1 finalizes
 * there is no state yet — `state` is `null`.
 *
 * @throws PenSessionNotFoundError if missing or owned by another user
 */
export async function getPenSessionState(userId: string, sessionId: string): Promise<PenSessionStateOutput> {
  const session = await getPenSessionById(userId, sessionId);
  const book: DBBook | null = await getBookFromDB(session.bookId);
  if (!book) throw new PenSessionNotFoundError("Book not found for this session");

  if (!session.currentPageId) {
    return { state: null, currentPageId: null, pageNumber: 0, pageEssentials: null };
  }

  const state = await getStoryStateWithBranch(book.id, session.currentPageId);
  const dbPage = await getPageFromDB(session.currentPageId);
  const pageEssentials: PenDraftSceneEssentials | null = dbPage
    ? {
        placeId: dbPage.placeId ?? undefined,
        mood: dbPage.mood ?? undefined,
        weather: dbPage.weather ?? undefined,
        calendarDate: dbPage.calendarDate ?? undefined,
        timeOfDay: dbPage.timeOfDay ?? undefined,
        keyEvents: dbPage.keyEvents?.length ? dbPage.keyEvents : undefined,
        keyObjects: dbPage.keyObjects?.length ? dbPage.keyObjects : undefined,
      }
    : null;
  return { state, currentPageId: session.currentPageId, pageNumber: state?.page ?? 0, pageEssentials };
}

/** Allowed PATCH fields on a pen session. */
export type PenSessionUpdates = {
  assistanceLevel?: number;
  status?: PenSessionStatus;
  currentPageId?: string | null;
  authoringPov?: AuthoringPov | null;
  draftCharactersPresent?: PenDraftCharacter[];
  draftSceneEssentials?: PenDraftSceneEssentials | null;
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
  if (updates.draftCharactersPresent !== undefined) {
    values.draftCharactersPresent = updates.draftCharactersPresent;
  }
  if (updates.draftSceneEssentials !== undefined) {
    values.draftSceneEssentials = updates.draftSceneEssentials;
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
    .set({ draftBuffer: [], draftCharactersPresent: [], draftSceneEssentials: null })
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
  | { type: "storyteller"; prose: string; directionHint?: string; authoringPov?: AuthoringPov; assistanceLevel?: number }
  | { type: "text_adventure"; command: string; authoringPov?: AuthoringPov; assistanceLevel?: number };

/** Result of a `/continue` request. */
export type PenContinueOutput = {
  /** The appended span record (validated vs dirty). */
  span: DraftSpan;
  /** The audit row for this interaction (full `PenEdit`, id = the persisted row id). */
  edit: PenEdit;
  /** The full draft buffer after appending. */
  draft: DraftSpan[];
};

/**
 * Credit key per continuation-length tier (§8).
 * The tiers are renamed from the old Suggest/Assist/Auto-continue names because
 * all three are the SAME "finish my thought" continuation — they differ only in
 * output length (and therefore cost). Text adventure applies the same tiers.
 *   > 0.9 long · ≤ 0.9 medium · < 0.3 short.
 */
function continueCreditKey(session: { assistanceLevel: number }): "PEN_CONTINUE_LONG" | "PEN_CONTINUE_MEDIUM" | "PEN_CONTINUE_SHORT" {
  if (session.assistanceLevel > 0.9) return "PEN_CONTINUE_LONG";
  if (session.assistanceLevel < 0.3) return "PEN_CONTINUE_SHORT";
  return "PEN_CONTINUE_MEDIUM";
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

  // §3: text-adventure commands reuse the custom-actions Gate 1 — the
  // deterministic injection/denylist security filter — so a jailbreak/denylisted
  // command is rejected for the author to rephrase BEFORE any AI call or credit
  // charge. Plausibility/phase gates (Gate 1's AI judge, Gate 0 eligibility) are
  // intentionally NOT carried over: an author may legitimately redirect any
  // scene at any phase, so only the security component of the pipeline applies.
  if (input.type === "text_adventure") {
    const gate1 = runGate1(input.command);
    if (gate1.category === "injection_attempt" || gate1.category === "denylist") {
      throw new PenContinueError("Command failed the safety gate — please rephrase it.");
    }
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

  // §6.3: author-curated bible entries whose trigger keywords surface in the
  // assembled continuation context (contextHistory + recent prose + the author's
  // own fragment/command) are injected as the authoritative CANONICAL LORE block.
  // Deterministic + author-controlled; semantic memory stays the fallback.
  const authorInput = input.type === "text_adventure" ? input.command : input.prose;
  const loreHaystack = [
    state?.contextHistory ?? "",
    ...pageTexts,
    authorInput,
  ].join("\n");
  const lore = await getTriggeredLoreEntries(book.id, loreHaystack);

  // §10 E: per-interaction authoringPov overrides the session default.
  const authoringPov = input.authoringPov ?? session.authoringPov ?? undefined;

  // The assistance level snaps to a continuation-length tier (§8): short/medium/
  // long. It is priced per request so the charge always matches what the author
  // saw in the editor, closing the debounce race between the local toggle and the
  // persisted session value. Clamped to [0, 1]; when absent the session default
  // applies. The request value is also persisted (see the transaction below) so
  // the persisted default stays convergent with the last tier used.
  const assistanceLevel =
    typeof input.assistanceLevel === "number"
      ? Math.min(1, Math.max(0, input.assistanceLevel))
      : session.assistanceLevel;
  const continueLength = penContinueLengthForAssistance(assistanceLevel);

  const shared = {
    state,
    authoringMode: session.authoringMode,
    pageTexts,
    mcName,
    language,
    lore,
    storyStartDate: book.storyStartDate ?? null,
    momentum,
    sceneType,
    bookSummary: book.summary ?? null,
    essentials: session.draftSceneEssentials ?? null,
  };

  const { systemPrompt, userPrompt } =
    input.type === "text_adventure"
      ? buildPenContinuePrompt({ ...shared, command: input.command, authoringPov, length: continueLength })
      : buildPenContinuePrompt({ ...shared, prose: input.prose, directionHint: input.directionHint, authoringPov, length: continueLength });

  const promptConfig: AIPromptForJson<PenContinueAIOutput> = {
    schema: PEN_CONTINUE_SCHEMA,
    requiredFields: PEN_CONTINUE_REQUIRED_FIELDS,
    fallbackField: "text",
    baseOptions: {
      modelSelection: AI_CHAT_MODELS_WRITING,
      context: "pen-continue",
      systemPrompt,
      config: { ...AI_CHAT_CONFIG_DEFAULT, maxOutputToken: PEN_CONTINUE_MAX_TOKENS[continueLength] },
    },
  };

  const { result } = await executeWithCredits(
    userId,
    continueCreditKey({ assistanceLevel }),
    async (tx) => {
      const [current] = await tx
        .select()
        .from(penSessions)
        .where(and(eq(penSessions.id, sessionId), eq(penSessions.userId, userId)))
        .limit(1);
      if (!current) throw new PenSessionNotFoundError();

      // Credit enforcement precedes generation: executeWithCredits deducts
      // (and throws INSUFFICIENT_CREDITS) before this callback runs, so a
      // zero-balance user never spends provider tokens on a rejected request
      // (roadmap §13 sketch: generate inside the credits transaction).
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
        authoringPov: authoringPov ?? null,
      };

      const nextBuffer = [...(current.draftBuffer ?? []), span];

      const [updated] = await tx
        .update(penSessions)
        .set({
          draftBuffer: nextBuffer,
          status: "active",
          ...(typeof input.assistanceLevel === "number" ? { assistanceLevel } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(penSessions.id, sessionId), eq(penSessions.userId, userId)))
        .returning();

      if (!updated) throw new PenSessionNotFoundError();

      const edit: PenEdit = {
        id: generateId(),
        sessionId,
        userId,
        bookId: book.id,
        pageId: null,
        editType: "ai_continued",
        authorInput: authorInput || null,
        aiOutput: span.text,
        finalText: span.text,
        contextPageId: session.currentPageId,
        charOffsetStart: null,
        charOffsetEnd: null,
        authoringMode: session.authoringMode,
        authoringPov: authoringPov ?? null,
        createdAt: new Date(),
      };

      await tx.insert(penEdits).values({
        id: edit.id,
        sessionId: edit.sessionId,
        userId: edit.userId,
        bookId: edit.bookId,
        pageId: null,
        editType: edit.editType,
        authorInput: edit.authorInput,
        aiOutput: edit.aiOutput,
        finalText: edit.finalText,
        contextPageId: edit.contextPageId,
        authoringMode: edit.authoringMode,
        authoringPov: edit.authoringPov,
        createdAt: edit.createdAt,
      });

      return { updated, span, edit };
    },
    { context: "pen_continue", metadata: { sessionId, bookId: book.id } }
  );

  return {
    span: result.span,
    edit: result.edit,
    draft: result.updated.draftBuffer,
  };
}

/** Errors thrown while running an essentials auto-fill request. */
export class PenEssentialsAutofillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PenEssentialsAutofillError";
  }
}

/** Body of `POST /api/pen/sessions/:id/essentials/autofill`. */
export type PenEssentialsAutofillInput = {
  /**
   * The current in-progress draft prose (plain text).
   *
   * The server's `session.draftBuffer` only updates on `/continue`/`/finalize`,
   * so live keystrokes live client-side — the freshest story signal must travel
   * with the request, exactly like `/continue`'s `prose`.
   */
  draftText?: string;
  /**
   * Autofill mode:
   * - `fill_empty` (default): propose values ONLY for fields the author left
   *   blank; already-filled fields are never second-guessed.
   * - `review_all`: propose the most fitting value for EVERY field, revising
   *   the author's existing values only when the draft/canon clearly supports
   *   a better fit. The frontend shows the diffs for per-field acceptance.
   */
  mode?: "fill_empty" | "review_all";
};

/** Valid `mode` values for an essentials auto-fill request. */
export type PenEssentialsAutofillMode = NonNullable<PenEssentialsAutofillInput["mode"]>;

/** Result of an essentials auto-fill request. */
export type PenEssentialsAutofillOutput = {
  /**
   * A COMPLETE scene-essentials proposal. The service never mutates the
   * session — the frontend applies only the currently-blank fields and persists
   * them through the existing debounced PATCH path.
   */
  essentials: PenDraftSceneEssentials;
};

/** Clamps a proposed `keyEvents`/`keyObjects` array (trim, dedupe, cap). */
function coerceEssentialsList(value: unknown, maxItems: number, maxItemLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim().slice(0, maxItemLength);
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    out.push(trimmed);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** Clamps a free-text proposal field (`calendarDate`/`timeOfDay`) to a string or undefined. */
function coerceEssentialsText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

/**
 * Coerces the raw auto-fill output into a validated `PenDraftSceneEssentials`
 * proposal. Every field is defensively validated so a malformed/hallucinated
 * AI response can never break `/finalize`:
 * - `mood`/`weather` must land in the canonical enums (`coerceMood`/`coerceWeather`).
 * - `placeName` is resolved back to a real bible place id by case-insensitive
 *   name (then value) match; unknown names are dropped entirely.
 * - List/text fields are trimmed, deduped, and length-capped.
 * Blank fields stay `undefined` so the frontend merge + `/finalize` inheritance
 * behave exactly like author-typed blanks.
 */
function coerceEssentialsProposal(
  output: PenEssentialsAIOutput,
  placeOptions: Array<{ value: string; name: string }>,
): PenDraftSceneEssentials {
  const essentials: PenDraftSceneEssentials = {};

  const mood = coerceMood(typeof output.mood === "string" ? output.mood : undefined, undefined);
  if (mood) essentials.mood = mood;

  const weather = coerceWeather(typeof output.weather === "string" ? output.weather : undefined, undefined);
  if (weather) essentials.weather = weather;

  const calendarDate = coerceEssentialsText(output.calendarDate, PEN_ESSENTIALS_MAX_FIELD_LENGTH);
  if (calendarDate) essentials.calendarDate = calendarDate;

  const timeOfDay = coerceEssentialsText(output.timeOfDay, PEN_ESSENTIALS_MAX_FIELD_LENGTH);
  if (timeOfDay) essentials.timeOfDay = timeOfDay;

  const placeName = typeof output.placeName === "string" ? output.placeName.trim() : "";
  if (placeName) {
    const lower = placeName.toLowerCase();
    const match =
      placeOptions.find((p) => p.name.toLowerCase() === lower) ??
      placeOptions.find((p) => p.value.toLowerCase() === lower);
    if (match) essentials.placeId = match.value;
  }

  const keyEvents = coerceEssentialsList(output.keyEvents, PEN_ESSENTIALS_MAX_LIST_ITEMS, PEN_ESSENTIALS_MAX_ITEM_LENGTH);
  if (keyEvents.length > 0) essentials.keyEvents = keyEvents;

  const keyObjects = coerceEssentialsList(output.keyObjects, PEN_ESSENTIALS_MAX_LIST_ITEMS, PEN_ESSENTIALS_MAX_ITEM_LENGTH);
  if (keyObjects.length > 0) essentials.keyObjects = keyObjects;

  return essentials;
}

/**
 * Runs the `/continue`-style auto-fill generation for an owned pen session
 * (§2.i / §10 Decision M): one structured-output AI call proposes the blank
 * scene essentials from the draft + canon, clamped server-side, and an audit
 * `PenEdit` row (`editType: 'plan'`) is written. The session is never mutated
 * here — persisting the accepted proposal stays the frontend's job via PATCH.
 *
 * @param userId - The authenticated user's id (ownership guard)
 * @param sessionId - The session to autofill
 * @param input - `{ draftText }` — the current in-progress draft prose (plain text)
 * @throws PenSessionNotFoundError / PenBookOwnershipError if not owned
 * @throws PenEssentialsAutofillError if the session is closed or the AI returns unusable output
 */
export async function autofillSceneEssentials(
  userId: string,
  sessionId: string,
  input: PenEssentialsAutofillInput
): Promise<PenEssentialsAutofillOutput> {
  const session = await getPenSessionById(userId, sessionId);
  const book: DBBook | null = await getBookFromDB(session.bookId);
  if (!book) throw new PenEssentialsAutofillError("Book not found for this session");

  if (session.status !== "active") {
    throw new PenEssentialsAutofillError("Session is not active; reopen it before autofilling");
  }

  // Story state + recent prose from the last published page, when one exists
  // (mirrors `/continue`).
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

  // Known bible places constrain the place proposal (ownership already
  // verified above). A place suggestion is only accepted when its name resolves
  // to one of these ids.
  const loreEntries = await listLoreEntries(userId, book.id);
  const placeOptions = loreEntries
    .filter((e) => e.entryType === "place")
    .map((e) => ({ value: e.linkedPlaceId ?? e.id, name: e.name }));

  // Trigger-keyword lore injection — same haystack contract as `/continue`.
  const loreHaystack = [state?.contextHistory ?? "", ...pageTexts, input.draftText ?? ""].join("\n");
  const lore = await getTriggeredLoreEntries(book.id, loreHaystack);

  const { systemPrompt, userPrompt } = buildPenEssentialsAutofillPrompt({
    state,
    lore,
    pageTexts,
    mcName,
    language,
    bookSummary: book.summary ?? null,
    storyStartDate: book.storyStartDate ?? null,
    momentum,
    sceneType,
    essentials: session.draftSceneEssentials ?? null,
    draftText: input.draftText?.trim() ?? "",
    placeOptions,
    mode: input.mode ?? "fill_empty",
  });

  const promptConfig: AIPromptForJson<PenEssentialsAIOutput> = {
    schema: (input.mode ?? "fill_empty") === "review_all" ? PEN_ESSENTIALS_REVIEW_SCHEMA : PEN_ESSENTIALS_SCHEMA,
    requiredFields: PEN_ESSENTIALS_REQUIRED_FIELDS,
    fallbackField: "keyEvents",
    baseOptions: {
      modelSelection: AI_CHAT_MODELS_WRITING,
      context: "pen-essentials-autofill",
      systemPrompt,
      config: { ...AI_CHAT_CONFIG_DEFAULT, maxOutputToken: PEN_ESSENTIALS_MAX_TOKENS },
    },
  };

  const { result } = await executeWithCredits(
    userId,
    "PEN_ESSENTIALS_AUTOFILL",
    async (tx) => {
      const [current] = await tx
        .select()
        .from(penSessions)
        .where(and(eq(penSessions.id, sessionId), eq(penSessions.userId, userId)))
        .limit(1);
      if (!current) throw new PenSessionNotFoundError();

      const aiResponse = await aiPrompt<PenEssentialsAIOutput>(userPrompt, createAIOptionsWithSchema(promptConfig));
      const output = aiResponse.result;

      if (!output || typeof output !== "object") {
        throw new PenEssentialsAutofillError("AI returned no scene essentials");
      }

      const essentials = coerceEssentialsProposal(output, placeOptions);

      // Audit trail — the `plan` edit type was reserved for exactly this kind
      // of author-facing AI suggestion (types/pen.ts). Nothing is persisted to
      // the session; the author accepts via the panel and the debounced PATCH.
      const edit: PenEdit = {
        id: generateId(),
        sessionId,
        userId,
        bookId: book.id,
        pageId: null,
        editType: "plan",
        authorInput: input.draftText?.trim() || null,
        aiOutput: JSON.stringify(essentials),
        finalText: null,
        contextPageId: session.currentPageId,
        charOffsetStart: null,
        charOffsetEnd: null,
        authoringMode: session.authoringMode,
        authoringPov: null,
        createdAt: new Date(),
      };

      await tx.insert(penEdits).values({
        id: edit.id,
        sessionId: edit.sessionId,
        userId: edit.userId,
        bookId: edit.bookId,
        pageId: null,
        editType: edit.editType,
        authorInput: edit.authorInput,
        aiOutput: edit.aiOutput,
        finalText: null,
        contextPageId: edit.contextPageId,
        authoringMode: edit.authoringMode,
        authoringPov: null,
        createdAt: edit.createdAt,
      });

      return essentials;
    },
    { context: "pen_essentials_autofill", metadata: { sessionId, bookId: book.id } }
  );

  return { essentials: result };
}

/**
 * Clamps a raw state-proposal inventory item into an `InventoryItem`.
 * Name is required; amount is clamped to a non-negative integer; `where` and
 * traits are trimmed/length-capped. Acquisition metadata is preserved when the
 * item already exists in the current state (matched by name) so carried-over
 * items keep their original `pageAcquired`/`placeId`; new items are stamped
 * with `expectedPageNumber` so the engine tags them as acquired this page.
 */
function coerceStateProposalInventoryItem(
  raw: unknown,
  currentState: StoryState | null,
  expectedPageNumber: number,
): InventoryItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string") return null;
  const name = r.name.trim();
  if (!name) return null;

  const existing = currentState?.inventory?.find(
    (item) => item.name.toLowerCase() === name.toLowerCase(),
  );

  const traits: string[] = [];
  if (Array.isArray(r.traits)) {
    for (const t of r.traits) {
      if (traits.length >= PEN_FINALIZE_PROPOSE_MAX_TRAITS) break;
      if (typeof t !== "string") continue;
      const trimmed = t.trim().slice(0, PEN_FINALIZE_PROPOSE_MAX_ITEM_LENGTH);
      if (!trimmed) continue;
      traits.push(trimmed);
    }
  }

  const amountRaw = r.amount;
  const amount =
    typeof amountRaw === "number" && Number.isFinite(amountRaw)
      ? Math.max(0, Math.floor(amountRaw))
      : existing?.amount;

  const where =
    typeof r.where === "string" && r.where.trim()
      ? r.where.trim().slice(0, PEN_FINALIZE_PROPOSE_MAX_ITEM_LENGTH)
      : existing?.where;

  return {
    name: name.slice(0, PEN_FINALIZE_PROPOSE_MAX_ITEM_LENGTH),
    ...(traits.length > 0 ? { traits } : {}),
    ...(amount !== undefined ? { amount } : {}),
    ...(where ? { where } : {}),
    ...(existing?.pageAcquired !== undefined ? { pageAcquired: existing.pageAcquired } : { pageAcquired: expectedPageNumber }),
    ...(existing?.placeId !== undefined ? { placeId: existing.placeId } : {}),
  };
}

/**
 * Clamps a raw state-proposal injury into an `Injury`. `bodyPart`/`description`
 * are required; severity is clamped to 0–1; category must land in the canonical
 * `injuryCategories` enum; consequences are trimmed/length-capped. Acquisition
 * metadata is carried over when the injury already exists in the current state
 * (matched by body part + description), else stamped `expectedPageNumber`.
 */
function coerceStateProposalInjury(
  raw: unknown,
  currentState: StoryState | null,
  expectedPageNumber: number,
): Injury | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.bodyPart !== "string" || typeof r.description !== "string") return null;
  const bodyPart = r.bodyPart.trim();
  const description = r.description.trim();
  if (!bodyPart || !description) return null;

  const existing = currentState?.injuries?.find(
    (injury) =>
      injury.bodyPart.toLowerCase() === bodyPart.toLowerCase() &&
      injury.description.toLowerCase() === description.toLowerCase(),
  );

  const severityRaw = r.severity;
  const severity =
    typeof severityRaw === "number" && Number.isFinite(severityRaw)
      ? Math.min(1, Math.max(0, severityRaw))
      : existing?.severity;

  const category =
    typeof r.category === "string" && (injuryCategories as readonly string[]).includes(r.category)
      ? (r.category as Injury["category"])
      : existing?.category;

  const consequences =
    typeof r.consequences === "string" && r.consequences.trim()
      ? r.consequences.trim().slice(0, PEN_FINALIZE_PROPOSE_MAX_ITEM_LENGTH)
      : existing?.consequences;

  return {
    bodyPart: bodyPart.slice(0, PEN_FINALIZE_PROPOSE_MAX_ITEM_LENGTH),
    description: description.slice(0, PEN_FINALIZE_PROPOSE_MAX_ITEM_LENGTH),
    ...(severity !== undefined ? { severity } : {}),
    ...(category ? { category } : {}),
    ...(consequences ? { consequences } : {}),
    ...(existing?.pageAcquired !== undefined ? { pageAcquired: existing.pageAcquired } : { pageAcquired: expectedPageNumber }),
    ...(existing?.placeId !== undefined ? { placeId: existing.placeId } : {}),
  };
}

/**
 * Coerces a raw state proposal (AI output OR author-adopted arrays) into
 * validated `InventoryItem[]` / `Injury[]` full replacements. Every field is
 * defensively validated so a malformed/hallucinated AI response or a hand-edited
 * adoption can never break `/finalize` (mirrors {@link coerceEssentialsProposal}).
 */
function coerceStateProposal(
  output: PenStateProposalAIOutput,
  currentState: StoryState | null,
  expectedPageNumber: number,
): { inventory: InventoryItem[]; injuries: Injury[] } {
  const inventory: InventoryItem[] = [];
  if (Array.isArray(output.inventory)) {
    for (const raw of output.inventory) {
      if (inventory.length >= PEN_FINALIZE_PROPOSE_MAX_INVENTORY_ITEMS) break;
      const item = coerceStateProposalInventoryItem(raw, currentState, expectedPageNumber);
      if (item) inventory.push(item);
    }
  }

  const injuries: Injury[] = [];
  if (Array.isArray(output.injuries)) {
    for (const raw of output.injuries) {
      if (injuries.length >= PEN_FINALIZE_PROPOSE_MAX_INJURIES) break;
      const injury = coerceStateProposalInjury(raw, currentState, expectedPageNumber);
      if (injury) injuries.push(injury);
    }
  }

  return { inventory, injuries };
}

/** Errors thrown while running a finalize state-proposal request. */
export class PenStateProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PenStateProposalError";
  }
}

/**
 * Runs the finalize state-proposal generation for an owned pen session (§2.i /
 * §10): one structured-output AI call computes the FULL next-page inventory and
 * injuries from the draft + canon, clamped server-side against the current
 * state, and an audit `PenEdit` row (`editType: 'plan'`) is written. Nothing
 * is persisted to the session — the author adopts/edits the proposal in the
 * publish dialog and `/finalize` merges the adopted arrays into the state delta.
 *
 * Page 1 (no `currentPageId`) has no prior state to propose against, so it
 * returns an empty proposal (`{ inventory: [], injuries: [] }`) without calling
 * the model — the frontend skips the adopt dialog entirely.
 *
 * @param userId - The authenticated user's id (ownership guard)
 * @param sessionId - The session to propose for
 * @param input - `{ draftText }` — the current in-progress draft prose (plain text)
 * @throws PenSessionNotFoundError / PenBookOwnershipError if not owned
 * @throws PenStateProposalError if the AI call returns unusable output
 */
export async function proposePenStateUpdates(
  userId: string,
  sessionId: string,
  input: PenStateProposalInput,
): Promise<PenStateProposalOutput> {
  const session = await getPenSessionById(userId, sessionId);
  const book: DBBook | null = await getBookFromDB(session.bookId);
  if (!book) throw new PenStateProposalError("Book not found for this session");

  if (session.status !== "active") {
    throw new PenStateProposalError("Session is not active; reopen it before proposing");
  }

  // Page 1: no prior state → nothing to propose (the frontend skips the dialog).
  if (!session.currentPageId) {
    return { inventory: [], injuries: [] };
  }

  const state = await getStoryStateWithBranch(book.id, session.currentPageId);
  const branch = await getBranchPath(session.currentPageId);
  const pageTexts = branch.pages.map((p) => p.text).filter(Boolean);
  const last = branch.pages[branch.pages.length - 1];
  const momentum = last?.momentum ?? null;
  const sceneType = last?.sceneType ?? null;
  const currentPage = await getPageFromDB(session.currentPageId);
  const expectedPageNumber = (currentPage?.page ?? 0) + 1;

  const mcName = book.mc?.knownName || book.mc?.name || "";
  const language = book.language || "en";

  const loreHaystack = [state?.contextHistory ?? "", ...pageTexts, input.draftText ?? ""].join("\n");
  const lore = await getTriggeredLoreEntries(book.id, loreHaystack);

  const { systemPrompt, userPrompt } = buildPenStateProposalPrompt({
    state,
    lore,
    pageTexts,
    mcName,
    language,
    bookSummary: book.summary ?? null,
    storyStartDate: book.storyStartDate ?? null,
    momentum,
    sceneType,
    draftText: input.draftText?.trim() ?? "",
  });

  const promptConfig: AIPromptForJson<PenStateProposalAIOutput> = {
    schema: PEN_STATE_PROPOSAL_SCHEMA,
    requiredFields: PEN_STATE_PROPOSAL_REQUIRED_FIELDS,
    fallbackField: "inventory",
    baseOptions: {
      modelSelection: AI_CHAT_MODELS_WRITING,
      context: "pen-finalize-propose",
      systemPrompt,
      config: { ...AI_CHAT_CONFIG_DEFAULT, maxOutputToken: PEN_FINALIZE_PROPOSE_MAX_TOKENS },
    },
  };

  const { result } = await executeWithCredits(
    userId,
    "PEN_FINALIZE_PROPOSE",
    async (tx) => {
      const [current] = await tx
        .select()
        .from(penSessions)
        .where(and(eq(penSessions.id, sessionId), eq(penSessions.userId, userId)))
        .limit(1);
      if (!current) throw new PenSessionNotFoundError();

      const aiResponse = await aiPrompt<PenStateProposalAIOutput>(userPrompt, createAIOptionsWithSchema(promptConfig));
      const output = aiResponse.result;

      if (!output || typeof output !== "object") {
        throw new PenStateProposalError("AI returned no state proposal");
      }

      const proposal = coerceStateProposal(output, state, expectedPageNumber);

      // Audit trail — the `plan` edit type was reserved for author-facing AI
      // suggestions (types/pen.ts). Nothing is persisted to the session; the
      // author accepts/edits via the publish dialog and `/finalize` merges the
      // adopted arrays into the state delta.
      const edit: PenEdit = {
        id: generateId(),
        sessionId,
        userId,
        bookId: book.id,
        pageId: null,
        editType: "plan",
        authorInput: input.draftText?.trim() || null,
        aiOutput: JSON.stringify(proposal),
        finalText: null,
        contextPageId: session.currentPageId,
        charOffsetStart: null,
        charOffsetEnd: null,
        authoringMode: session.authoringMode,
        authoringPov: null,
        createdAt: new Date(),
      };

      await tx.insert(penEdits).values({
        id: edit.id,
        sessionId: edit.sessionId,
        userId: edit.userId,
        bookId: edit.bookId,
        pageId: null,
        editType: edit.editType,
        authorInput: edit.authorInput,
        aiOutput: edit.aiOutput,
        finalText: null,
        contextPageId: edit.contextPageId,
        authoringMode: edit.authoringMode,
        authoringPov: null,
        createdAt: edit.createdAt,
      });

      return proposal;
    },
    { context: "pen_finalize_propose", metadata: { sessionId, bookId: book.id } }
  );

  return { inventory: result.inventory, injuries: result.injuries };
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
 * (the confirm sheet's "Proceed anyway"). `amendments` are reserved for
 * Phase 5 "adopt this override as the new canon" and are currently rejected
 * with a 422 if provided — never silently dropped. `actions` supplies the
 * author-defined next choices for the new page in interactive/multiverse
 * mode (novel always uses the single default); clamped to the book's mode
 * branching contract.
 */
export type PenFinalizeInput = {
  force?: boolean;
  amendments?: CanonAmendment[];
  actions?: { text: string; type: string; hint?: { text?: string; type?: string } }[];
  /**
   * Author-adopted next-page inventory (full replacement). Sent by the
   * frontend when the author confirms the AI state proposal ("adopt as
   * canon") in the publish dialog. Merged into the state delta exactly like
   * AI-generated inventory.
   */
  adoptInventory?: InventoryItem[];
  /** Author-adopted next-page injuries (full replacement). See {@link adoptInventory}. */
  adoptInjuries?: Injury[];
};

/** Body of `POST /api/pen/sessions/:id/finalize/propose`. */
export type PenStateProposalInput = {
  /** The current in-progress draft prose (plain text) — the freshest story signal. */
  draftText?: string;
};

/** Result of a finalize state-proposal request. */
export type PenStateProposalOutput = {
  /** Proposed next-page inventory (full replacement). */
  inventory: InventoryItem[];
  /** Proposed next-page injuries (full replacement). */
  injuries: Injury[];
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

  // Canon amendments require the lore bible (Phase 5) — `lore_entries` doesn't
  // exist yet. Fail loudly instead of silently dropping them.
  if (input.amendments !== undefined && input.amendments.length > 0) {
    throw new PenFinalizeError("Canon amendments are not supported until the lore bible lands (Phase 5)");
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

      // Author-curated on-scene cast (full cast incl. MC). New/unknown names
      // are registered into story state via stateDelta.newCharacters.
      const { charactersPresent: castPresent, newCharacters: castNewCharacters } = resolveDraftCharacters(
        session.draftCharactersPresent ?? [],
        currentState.characters,
        book.mc,
      );

      const sceneEssentials = applySceneEssentials(session.draftSceneEssentials, {
        mood: currentPage.mood,
        weather: currentPage.weather,
      });

      const generatedStoryPage: StoryGeneration = {
        text: draftText,
        actions,
        mood: sceneEssentials.mood,
        placeId: session.draftSceneEssentials?.placeId ?? currentPage.placeId,
        weather: sceneEssentials.weather,
        calendarDate: session.draftSceneEssentials?.calendarDate ?? currentPage.calendarDate,
        timeOfDay: session.draftSceneEssentials?.timeOfDay ?? currentPage.timeOfDay,
        sceneType: currentPage.sceneType,
        charactersPresent: castPresent,
        ...(session.draftSceneEssentials?.keyEvents?.length ? { keyEvents: session.draftSceneEssentials.keyEvents } : {}),
        ...(session.draftSceneEssentials?.keyObjects?.length ? { keyObjects: session.draftSceneEssentials.keyObjects } : {}),
        ...(castNewCharacters.length ? { newCharacters: castNewCharacters } : {}),
      };

      // Adopt-as-canon state proposal (§2.i / §10): when the author confirmed
      // the AI-computed next inventory/injuries in the publish dialog, inject
      // them as the generation's state so `extractStateDelta` maps them into
      // the delta exactly like AI-generated state (full-replacement semantics).
      const adopted = coerceStateProposal(
        {
          inventory: Array.isArray(input.adoptInventory) ? input.adoptInventory : [],
          injuries: Array.isArray(input.adoptInjuries) ? input.adoptInjuries : [],
        },
        currentState,
        pageNumber,
      );
      if (adopted.inventory.length > 0) generatedStoryPage.inventory = adopted.inventory;
      if (adopted.injuries.length > 0) generatedStoryPage.injuries = adopted.injuries;

      const advancedState = await advanceStoryState(currentState, actionedPage);

      const { newState, fullStateDelta } = resolvePageDelta({
        generatedStoryPage,
        advancedState,
        currentState,
        expectedPageNumber: pageNumber,
        context: "pen-finalize",
      });

      // Decision R (§10): soft target that never walls — and, for branched
      // stories, never lets a shallow branch "shrink" the phase denominator of
      // the branch chain it belongs to. maxPage = the best of three sources:
      //   - currentState.maxPage: the inherited, path-local ceiling from the
      //     branch chain (monotonic — advanceStoryState carries it forward), so
      //     a deep spine keeps its scale while a shallow side-branch reads
      //     "N of the same Y" instead of a suddenly-reset budget;
      //   - book.totalPages: the author's editable target estimate (soft);
      //   - pageNumber: the real page about to publish, so a book that runs
      //     past its target never walls ("Mark complete" stays authoritative).
      newState.maxPage = Math.max(
        currentState.maxPage,
        book.totalPages ?? pageNumber,
        pageNumber,
      );

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
      const { charactersPresent: castPresent, newCharacters: castNewCharacters } = resolveDraftCharacters(
        session.draftCharactersPresent ?? [],
        {},
        book.mc,
      );

      const firstPageEssentials = applySceneEssentials(session.draftSceneEssentials, {});

      const pageToInsert = {
        ...generatedFirstPage(draftText, actions, castPresent, castNewCharacters),
        ...(session.draftSceneEssentials?.placeId ? { placeId: session.draftSceneEssentials.placeId } : {}),
        ...(firstPageEssentials.mood ? { mood: firstPageEssentials.mood } : {}),
        ...(firstPageEssentials.weather ? { weather: firstPageEssentials.weather } : {}),
        ...(session.draftSceneEssentials?.calendarDate ? { calendarDate: session.draftSceneEssentials.calendarDate } : {}),
        ...(session.draftSceneEssentials?.timeOfDay ? { timeOfDay: session.draftSceneEssentials.timeOfDay } : {}),
        ...(session.draftSceneEssentials?.keyEvents?.length ? { keyEvents: session.draftSceneEssentials.keyEvents } : {}),
        ...(session.draftSceneEssentials?.keyObjects?.length ? { keyObjects: session.draftSceneEssentials.keyObjects } : {}),
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
      // The page-1 cast has no prior state, so newly-checked characters must be
      // registered into the initial story state directly (no stateDelta to apply).
      if (castNewCharacters.length) {
        processCharacterUpdates(initialState, castNewCharacters);
      }
      // Page-1 adopt (no stateDelta exists): apply the author-adopted state
      // proposal to the initial story state directly. `extractStateDelta`
      // returns `{}` for page 1, so there is no delta pipeline to ride.
      const pageOneAdopted = coerceStateProposal(
        {
          inventory: Array.isArray(input.adoptInventory) ? input.adoptInventory : [],
          injuries: Array.isArray(input.adoptInjuries) ? input.adoptInjuries : [],
        },
        null,
        1,
      );
      if (pageOneAdopted.inventory.length > 0) initialState.inventory = pageOneAdopted.inventory;
      if (pageOneAdopted.injuries.length > 0) {
        initialState.injuries = pageOneAdopted.injuries;
        initialState.healthStatus = calculateHealthStatus(pageOneAdopted.injuries, {
          traumaTagCount: initialState.traumaTags.length,
          memoryIntegrity: initialState.memoryIntegrity,
          fearLevel: initialState.flags.fear,
        });
      }
      await insertStoryState(book.id, newPage.id, initialState, "original");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown engine error during publish";
    throw new PenFinalizeError(`Publish rejected by the story engine: ${message}`);
  }

  // ── Phase C: roll up pen_edits spans + offsets, clear the draft ───────────
  //
  // TODO(orphan-window): the page + story-state INSERT above (Phase B,
  // persistPageWithState) commits OUTSIDE this transaction, so there is no
  // atomicity between "child page inserted" and "session advanced to it".
  //
  // ── The window ───────────────────────────────────────────────────────────
  // If the process dies — or the DB/network drops — between Phase B's commit
  // and Phase C's commit, the book is left half-published:
  //   1. the new `pages` row exists (`parentId` already set to the parent),
  //   2. the session still points at the OLD parent (`currentPageId`,
  //      `draftBuffer`, scene essentials all untouched),
  //   3. the B3 reverse-edge backfill below never ran, so the parent's
  //      `actions[0].destinationPageIds` does NOT include the child.
  // On client retry the draft is still loaded, so finalize publishes a SECOND
  // child from the same parent → duplicate sibling. The stranded first child
  // then lives forever in the outline (visible via `parentId`) but is
  // reader-unreachable (the reader surfaces only actions with a destination)
  // and renders outside its action folder.
  //
  // ── Why not simply wrap Phase B in one big transaction ───────────────────
  // persistPageWithState deliberately avoids a DB transaction: insertStoryPage
  // uses retryWithBranchConflict, which re-runs with a NEW branchId on
  // unique-constraint violation — a transaction aborts on the first constraint
  // error, defeating that retry (see the atomicity note on persistPageWithState
  // in book.ts). Re-threading a `tx` through insertStoryState/persistPageWithState
  // would couple finalize to every engine write path — high blast radius.
  //
  // ── Best proposed fix (Option A — favors the house "cleanup contract") ───
  // Mirror persistPageWithState's own orphan cleanup instead of a shared tx:
  //   try { await dbWrite.transaction(Phase C) }
  //   catch (err) {
  //     // Compensate: remove the child that never got "adopted" by the session,
  //     // so a retry is clean and idempotent. Reuses the existing
  //     // `deleteStoryPage(newPage.id)` helper (book.ts) already used for
  //     // page-insert/state-insert failures.
  //     try { await deleteStoryPage(newPage.id); } catch { /* reconciliation */ }
  //     throw err;
  //   }
  // This makes the whole user action all-or-nothing and keeps Phase B's retry
  // contract intact. Residual risk: if the compensation delete ALSO fails on a
  // network partition, the page becomes a classic orphan — detectable by the
  // periodic reconciliation job the engine already assumes ("no state, never
  // linked as a destination", book.ts). It must not be erased if the author
  // initiated another publish meanwhile (guard on session.status/currentPageId).
  //
  // ── Alternative B (strongest, more work) ─────────────────────────────────
  // Add an in-progress publish marker to penSessions (e.g. `pendingPublishId`
  // written before Phase B, cleared in Phase C). finalize is idempotent:
  // a dangling marker either resumes or sweeps the stranded page on the next
  // call / a reconciliation job. Requires a schema change + state machine
  // (rollback, expiry, cross-session safety).
  //
  // ── Alternative C (read-time self-heal, least invasive) ──────────────────
  // Repair missing reverse edges lazily in getPenOutline / reader page load:
  // a child linked by `parentId` but absent from every action's
  // `destinationPageIds` gets actions[0] updated to point at it. Heals legacy
  // AND orphaned data with no write-path change — but is ambiguous in
  // single-destination modes when a parent has several unlinked children
  // (which is "the" destination?), so it must pick deterministically
  // (e.g. highest pageNumber, as the latest continuation).

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
        authoringPov: span.authoringPov ?? session.authoringPov ?? null,
        createdAt: new Date(),
      });
    }

    await tx
      .update(penSessions)
      .set({ draftBuffer: [], draftCharactersPresent: [], draftSceneEssentials: null, currentPageId: newPage.id, status: "active", updatedAt: new Date() })
      .where(and(eq(penSessions.id, sessionId), eq(penSessions.userId, userId)));

    // §6.6 reverse-edge (B3/E3/E4): record this child as the destination of the
    // action the author continued from — always `parent.actions[0]`, the action
    // the pen navigates through (see the continuation path above). This is what
    // lets the outline tree's action folders and the peek's "leads to current
    // page" highlight resolve the path. It also makes pen books readable
    // (reader actions with a destination are the ones surfaced).
    //
    // Mode-aware write (deliberately NOT `enforceModeOnActionDestinations`,
    // which prefers existing destinations for candidate-generation idempotency):
    //   - novel / interactive (1 destination per action) → the latest
    //     continuation REPLACES the old destination, because the author
    //     re-authored that action's outcome. Keeping the old destination would
    //     orphan every 2nd+ child written from the same parent (unreachable to
    //     readers and rendered outside its action folder).
    //   - multiverse (unlimited) → append the child (parallel timelines).
    const parentPageId = session.currentPageId;
    if (parentPageId) {
      const [parentRow] = await tx
        .select({ actions: pages.actions })
        .from(pages)
        .where(eq(pages.id, parentPageId))
        .limit(1);
      const parentActions = parentRow?.actions ?? [];
      if (parentActions.length > 0) {
        await tx
          .update(pages)
          .set({
            actions: parentActions.map((a, index) => {
              if (index !== 0) return a;
              const max = maxDestinationsPerActionForMode(book.mode);
              const nextDestinations = Number.isFinite(max)
                ? [newPage.id]
                : Array.from(new Set([...(a.destinationPageIds ?? []), newPage.id]));
              return { ...a, destinationPageIds: nextDestinations };
            }),
            updatedAt: new Date(),
          })
          .where(eq(pages.id, parentPageId));
      }
    }
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
 * Coerces an author-curated scene essentials string into the engine's
 * canonical Mood union. Empty/invalid values return the inherited fallback so
 * the Pen never drops scene context the author didn't explicitly set.
 */
function coerceMood(value: string | undefined, fallback: Mood | undefined): Mood | undefined {
  if (value === undefined || value === "") return fallback;
  return moods.includes(value as Mood) ? (value as Mood) : fallback;
}

/**
 * Coerces an author-curated scene essentials string into the canonical
 * PlaceWeather union (same semantics as {@link coerceMood}).
 */
function coerceWeather(value: string | undefined, fallback: PlaceWeather | undefined): PlaceWeather | undefined {
  if (value === undefined || value === "") return fallback;
  return placeWeathers.includes(value as PlaceWeather) ? (value as PlaceWeather) : fallback;
}

/**
 * Applies the session's author-curated scene essentials (§10) over the page
 * being published. Every field falls back to the inherited page value when
 * blank, so the Pen never clears context the author didn't explicitly touch.
 */
function applySceneEssentials(
  essentials: PenDraftSceneEssentials | null | undefined,
  inherited: Pick<StoryGeneration, "mood" | "weather">,
): Pick<StoryGeneration, "mood" | "weather"> {
  return {
    mood: coerceMood(essentials?.mood, inherited.mood),
    weather: coerceWeather(essentials?.weather, inherited.weather),
  };
}

/**
 * Builds a minimal first-page `StoryGeneration` for a pen-authored page-1
 * publish. Scene context defaults to neutral until the author's first page
 * establishes it. `charactersPresent` is the author's curated on-scene cast
 * (full cast incl. MC); `newCharacters` registers any not-yet-known names.
 */
function generatedFirstPage(
  text: string,
  actions: Action[],
  charactersPresent?: SceneCharacter[],
  newCharacters?: NewCharacter[],
): StoryGeneration {
  return {
    text,
    actions,
    sceneType: "transition",
    charactersPresent,
    ...(newCharacters?.length ? { newCharacters } : {}),
  };
}

/**
 * Resolves the author's scene checklist into engine-valid `charactersPresent`
 * entries plus any `NewCharacter` registrations needed so every checked id
 * resolves to a real character in story state.
 *
 * - `characterId` (a known id or the reserved `"mc"`) → used as-is.
 * - Free-text `name` → slugged into an id and registered as a minimal character.
 * - `"mc"` → guaranteed registration into story state on first use.
 *
 * The main character is INCLUDED — Pen has no POV restriction, so `charactersPresent`
 * is the full on-scene cast, not a side-character-only subset.
 */
function resolveDraftCharacters(
  inputs: PenDraftCharacter[],
  knownCharacters: Record<string, CharacterMemory>,
  mc: StoryMC | null,
): { charactersPresent: SceneCharacter[]; newCharacters: NewCharacter[] } {
  const charactersPresent: SceneCharacter[] = [];
  const newCharacters: NewCharacter[] = [];
  const seen = new Set<string>();

  for (const item of inputs.slice(0, PEN_DRAFT_CAST_LIMIT)) {
    const sceneRole: CharacterSceneRole = item.sceneRole ?? "supporting";
    const sceneFocus = typeof item.sceneFocus === "number" ? Math.min(1, Math.max(0, item.sceneFocus)) : 0.5;
    const isMc = item.characterId?.trim() === "mc";

    let characterId = item.characterId?.trim();
    if (!characterId && item.name?.trim()) {
      characterId = slugifyCharacterName(item.name.trim());
    }
    if (!characterId || seen.has(characterId)) continue;
    seen.add(characterId);

    if (isMc) {
      if (mc && isMainCharacterValid(mc) && !knownCharacters["mc"] && !newCharacters.some((n) => n.characterId === "mc")) {
        newCharacters.push(buildMcNewCharacter(mc));
      }
      charactersPresent.push({ characterId: "mc", sceneRole, sceneFocus: typeof item.sceneFocus === "number" ? sceneFocus : 1 });
      continue;
    }

    if (knownCharacters[characterId]) {
      charactersPresent.push({ characterId, sceneRole, sceneFocus });
      continue;
    }

    const name = item.name?.trim() || characterId;
    if (!newCharacters.some((n) => n.characterId === characterId)) {
      newCharacters.push(buildMinimalNewCharacter(characterId, name, { sceneRole, sceneFocus }));
    }
    charactersPresent.push({ characterId, sceneRole, sceneFocus });
  }

  return { charactersPresent, newCharacters };
}

/** Normalizes a free-text character name into a stable character id. */
function slugifyCharacterName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/[\s-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "character"
  );
}

/**
 * Minimal `NewCharacter` for a cast member the author checked who isn't in
 * story state yet. Sparse but engine-valid; AI enrichment is a later phase.
 */
function buildMinimalNewCharacter(
  characterId: string,
  name: string,
  opts: { sceneRole: CharacterSceneRole; sceneFocus: number },
): NewCharacter {
  const antagonist = opts.sceneRole === "threat" || opts.sceneRole === "opposition";
  return {
    characterId,
    knownName: name,
    realName: name,
    gender: "unknown",
    role: antagonist ? "antagonist" : "character",
    bio: "",
    appearance: "",
    importance: antagonist ? "major" : "supporting",
    status: "active",
    secrets: [],
    relationshipToMC: { type: "stranger", status: "neutral", context: "", recognitionLevel: "never_seen" },
    potentialTwist: "none",
    recognitionLevel: "never_seen",
  };
}

/** Registers the reserved `"mc"` id into story state using the book's MC profile. */
function buildMcNewCharacter(mc: StoryMC): NewCharacter {
  const name = mc.name.trim();
  return {
    characterId: "mc",
    knownName: mc.knownName?.trim() || name,
    realName: name,
    gender: mc.gender as Gender,
    role: "main character",
    bio: mc.bio ?? "",
    appearance: "",
    importance: "major",
    status: "active",
    secrets: [],
    relationshipToMC: { type: "stranger", status: "neutral", context: "", recognitionLevel: "full_name_known" },
    potentialTwist: "none",
    recognitionLevel: "full_name_known",
  };
}

// ── Outline tree + author page peek (§6.6 Phase 3.d / Decision A) ───────────

/** Default `textPreview` window — short enough to keep the outline payload light. */
const PEN_OUTLINE_PREVIEW_CHARS = 200;

/**
 * Renders `text` as a single-line preview cut at a word boundary, with a
 * trailing ellipsis when truncated. `null` for blank pages.
 */
function previewOf(text: string | null | undefined, maxChars = PEN_OUTLINE_PREVIEW_CHARS): string | null {
  const trimmed = (text ?? "").trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  if (trimmed.length <= maxChars) return trimmed;
  const cut = trimmed.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut) + "…";
}

/**
 * Flat outline payload for the pen book's page/branch tree (§6.6, Phase 3.d).
 * The frontend builds the hierarchy from `parentId` (`buildOutlineTree`).
 *
 * Owner-scoped: the authenticated user must own the book. `isDeadEnd` is only
 * meaningful for branched books (a `novel` chain with 1 action is not a dead
 * end).
 *
 * @param userId - The authenticated user's id (ownership guard)
 * @param bookId - The book to list pages for
 * @throws PenSessionNotFoundError if the book is missing
 * @throws PenBookOwnershipError if the user does not own the book
 */
export async function getPenOutline(userId: string, bookId: string): Promise<PenOutlineData> {
  const book = await getBookFromDB(bookId);
  if (!book) throw new PenSessionNotFoundError("Book not found");
  if (book.userId !== userId) throw new PenBookOwnershipError();

  const [pageRows, branchRows] = await Promise.all([
    getBookPages(bookId),
    dbRead
      .select({ branchId: branches.branchId, displayName: branches.displayName })
      .from(branches)
      .where(eq(branches.bookId, bookId)),
  ]);

  const branched = book.mode === "interactive" || book.mode === "multiverse";

  const pages: PenOutlinePage[] = pageRows.map((page) => {
    const hasActions = (page.actions?.length ?? 0) > 0;
    return {
      id: page.id,
      page: page.page,
      parentId: page.parentId,
      branchId: page.branchId,
      mood: page.mood ?? undefined,
      textPreview: previewOf(page.text) ?? undefined,
      hasActions,
      isDeadEnd: branched && !hasActions,
      // Full action list rides along so the frontend can render action folders
      // and resolve the "leads to current page" reverse-edge without an extra
      // request per node (§6.6 action folders).
      actions: page.actions ?? [],
    };
  });

  return { pages, branches: branchRows };
}

/**
 * Full author-owned published page for the outline peek popover. Unlike the
 * reader's page payload this includes authorship rollups and no reader-specific
 * fields — the author sees the page exactly as published.
 *
 * @param userId - The authenticated user's id (ownership guard)
 * @param pageId - The published page to fetch
 * @throws PenSessionNotFoundError if the page or its book is missing
 * @throws PenBookOwnershipError if the user does not own the page's book
 */
export async function getPenAuthorPage(userId: string, pageId: string): Promise<PenAuthorPage> {
  const page = await getPageFromDB(pageId);
  if (!page) throw new PenSessionNotFoundError("Page not found");
  const book = await getBookFromDB(page.bookId);
  if (!book) throw new PenSessionNotFoundError("Book not found");
  if (book.userId !== userId) throw new PenBookOwnershipError();

  return {
    id: page.id,
    bookId: page.bookId,
    parentId: page.parentId,
    branchId: page.branchId,
    page: page.page,
    text: page.text,
    mood: page.mood ?? undefined,
    placeId: page.placeId ?? undefined,
    weather: page.weather ?? undefined,
    calendarDate: page.calendarDate ?? undefined,
    timeOfDay: page.timeOfDay ?? undefined,
    charactersPresent: page.charactersPresent ?? [],
    keyEvents: page.keyEvents ?? [],
    keyObjects: page.keyObjects ?? [],
    actions: page.actions ?? [],
    authorshipOrigin: (page.authorshipOrigin ?? "ai") as AuthorshipOrigin,
    aiContributionPercent: page.aiContributionPercent ?? null,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
  };
}
