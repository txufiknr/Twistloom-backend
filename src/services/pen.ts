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
import type { AuthoringMode, DraftSpan, PenSessionStatus } from "../types/pen.js";
import type { BookMode } from "../types/book.js";
import type { StoryState } from "../types/story.js";
import { getBranchPath } from "../utils/branch-traversal.js";
import { getStoryStateWithBranch } from "./story-branch.js";
import { buildPenContinuePrompt, PEN_SYSTEM_PROMPT, PEN_CONTINUE_SCHEMA, PEN_CONTINUE_REQUIRED_FIELDS } from "../utils/pen-prompt.js";
import type { PenContinueResult as PenContinueAIOutput } from "../utils/pen-prompt.js";
import { aiPrompt, createAIOptionsWithSchema } from "../utils/ai-chat.js";
import type { AIPromptForJson } from "../types/ai-chat.js";
import { AI_CHAT_MODELS_WRITING } from "../config/ai-clients.js";
import { AI_CHAT_CONFIG_DEFAULT } from "../config/ai-chat.js";
import { generateId } from "../utils/uuid.js";
import { executeWithCredits } from "./credits.js";

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
  params: { bookId: string; authoringMode: AuthoringMode; assistanceLevel?: number }
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
  | { type: "storyteller"; prose: string; directionHint?: string }
  | { type: "text_adventure"; command: string };

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

  const prompt =
    input.type === "text_adventure"
      ? buildPenContinuePrompt({ ...shared, command: input.command })
      : buildPenContinuePrompt({ ...shared, prose: input.prose, directionHint: input.directionHint });

  const promptConfig: AIPromptForJson<PenContinueAIOutput> = {
    schema: PEN_CONTINUE_SCHEMA,
    requiredFields: PEN_CONTINUE_REQUIRED_FIELDS,
    fallbackField: "text",
    baseOptions: {
      modelSelection: AI_CHAT_MODELS_WRITING,
      context: "pen-continue",
      systemPrompt: PEN_SYSTEM_PROMPT,
      config: { ...AI_CHAT_CONFIG_DEFAULT, maxOutputToken: 1000 },
    },
  };

  const aiResponse = await aiPrompt<PenContinueAIOutput>(prompt, createAIOptionsWithSchema(promptConfig));
  const output = aiResponse.result;

  if (!output || typeof output.text !== "string" || output.text.trim().length === 0) {
    throw new PenContinueError("AI returned no continuation text");
  }

  const issues = Array.isArray(output.issues) && output.issues.length > 0
    ? output.issues.filter((i) => i && typeof i.seen === "string" && typeof i.expected === "string")
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
