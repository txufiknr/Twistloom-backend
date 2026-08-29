/**
 * Pen (AI Co-Writing) Routes — Phase 1.a session lifecycle.
 *
 * Mounted at `/api/pen`. All endpoints require auth and verify book ownership.
 *
 * @see docs/roadmap/AI_CO_WRITING_PEN_ROADMAP.md §1.a
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../hono/env.js";
import { requireAuth } from "../middleware/nextauth.js";
import { requireNotSuspended, requireGenerationQuota } from "../middleware/trust-safety.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { PEN_CONTINUE_RATE_LIMIT, PEN_ESSENTIALS_RATE_LIMIT, PEN_FINALIZE_PROPOSE_RATE_LIMIT, PEN_TRANSFORM_RATE_LIMIT, PEN_CAST_DETECT_RATE_LIMIT } from "../config/ai-rate-limits.js";
import { cApiError, cNotFoundError, cValidationError } from "../utils/error.js";
import { dbWrite } from "../db/client.js";
import { isBase64Upload } from "../services/image.js";
import { PEN_ASSISTANCE_LEVEL_MAX, PEN_ASSISTANCE_LEVEL_MIN, PEN_AUTHORING_MODES, PEN_AUTHORING_POVS, PEN_DRAFT_BUFFER_MAX_CHARS, PEN_DRAFT_CAST_LIMIT, PEN_DRAFT_HTML_MAX_LENGTH, PEN_DRAFT_IMAGE_MAX_BYTES, PEN_DRAFT_SPAN_MAX_LENGTH, PEN_DRAFT_TEXT_MAX_LENGTH, PEN_DIRECTION_HINT_MAX_LENGTH, PEN_ESSENTIALS_MAX_LIST_ITEMS, PEN_ESSENTIALS_MAX_FIELD_LENGTH, PEN_FINALIZE_MAX_ACTIONS, PEN_FINALIZE_PROPOSE_MAX_INVENTORY_ITEMS, PEN_FINALIZE_PROPOSE_MAX_INJURIES, PEN_SCENE_FOCUS_MAX, PEN_SCENE_FOCUS_MIN, PEN_SESSION_STATUSES, PEN_CONTINUE_PROSE_MAX_LENGTH, PEN_DRAFT_LABEL_MAX_LENGTH, PEN_DRAFT_ACTION_TEXT_MAX_LENGTH, PEN_DRAFT_ACTION_HINT_MAX_LENGTH, PEN_TRANSFORM_SELECTION_MAX_LENGTH, PEN_ENDING_OUTLINE_MAX_ITEMS } from "../config/story.js";
import { moods } from "../types/story.js";
import { actionTypes, actionHintTypes } from "../types/story.js";
import type { StoryOutline } from "../types/story.js";
import { placeWeathers } from "../types/places.js";
import {
  createPenSession,
  getPenSessionForBook,
  getPenSessionById,
  updatePenSession,
  updatePenSessionOutline,
  updatePenSessionEnding,
  closePenSession,
  discardPenDraft,
  continuePenDraft,
  transformPenSelection,
  finalizePenDraft,
  autofillSceneEssentials,
  detectSceneCast,
  proposePenStateUpdates,
  getPenSessionState,
  getPenOutline,
  getPenAuthorPage,
  updatePenPageAction,
  updatePenPageProse,
  listSessionDrafts,
  createSessionDraft,
  activateSessionDraft,
  updateSessionDraft,
  discardSessionDraft,
  listPenNotes,
  createPenNote,
  updatePenNote,
  deletePenNote,
  PenSessionNotFoundError,
  PenSessionConflictError,
  PenBookOwnershipError,
  PenContinueError,
  PenTransformError,
  PenFinalizeError,
  PenEssentialsAutofillError,
  PenCastDetectError,
  PenStateProposalError,
  PenDraftLimitError,
  PenDraftNotActiveError,
  PenNoteNotFoundError,
  uploadPenDraftImage,
  PenImageUploadError,
} from "../services/pen.js";
import type { PenContinueInput, PenFinalizeInput, PenEssentialsAutofillInput, PenStateProposalInput } from "../services/pen.js";
import type { AuthoringMode, AuthoringPov, DraftSpan, PenDraftCharacter, PenDraftSceneEssentials, PenSessionStatus, PenBlockAction, PenCastDetectInput } from "../types/pen.js";
import { penBlockActions } from "../types/pen.js";
import { characterSceneRoles } from "../types/story.js";
import type { CharacterSceneRole } from "../types/story.js";

const router = new Hono<AppEnv>();

/**
 * Parses a JSON request body, returning `null` when the body is missing or
 * malformed so the route can answer 400 instead of crashing into a 500.
 * The caller already rejects `null`/non-object bodies as a validation error.
 */
async function readJsonBody(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/** Validates a single `draftCharactersPresent` entry; returns an error string or null. */
function validateDraftCastMember(member: unknown): string | null {
  if (!member || typeof member !== "object" || Array.isArray(member)) {
    return "each cast member must be an object";
  }
  const m = member as Record<string, unknown>;
  const hasId = typeof m.characterId === "string" && m.characterId.trim().length > 0;
  const hasName = typeof m.name === "string" && m.name.trim().length > 0;
  if (!hasId && !hasName) {
    return "each cast member needs a characterId or a name";
  }
  if (m.characterId !== undefined && typeof m.characterId !== "string") {
    return "characterId must be a string";
  }
  if (m.name !== undefined && typeof m.name !== "string") {
    return "name must be a string";
  }
  if (m.sceneRole !== undefined && !characterSceneRoles.includes(m.sceneRole as CharacterSceneRole)) {
    return `sceneRole must be one of: ${characterSceneRoles.join(", ")}`;
  }
  if (m.sceneFocus !== undefined && (typeof m.sceneFocus !== "number" || m.sceneFocus < PEN_SCENE_FOCUS_MIN || m.sceneFocus > PEN_SCENE_FOCUS_MAX)) {
    return "sceneFocus must be a number between 0 and 1";
  }
  return null;
}

/** Validates the `draftSceneEssentials` payload; returns an error string or null. */
function validateDraftSceneEssentials(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    return "draftSceneEssentials must be an object or null";
  }
  const e = value as Record<string, unknown>;
  const textFields = ["placeId", "mood", "weather", "calendarDate", "timeOfDay"] as const;
  for (const field of textFields) {
    if (e[field] !== undefined && typeof e[field] !== "string") {
      return `${field} must be a string`;
    }
  }
  const listFields = ["keyEvents", "keyObjects"] as const;
  for (const field of listFields) {
    if (e[field] !== undefined) {
      if (!Array.isArray(e[field])) return `${field} must be an array of strings`;
      if (e[field].some((item) => typeof item !== "string")) return `${field} must contain only strings`;
    }
  }
  return null;
}

/** Validates the `draftBuffer` span array (autosave layer 2, roadmap §18.1); returns an error string or null. */
function validateDraftBuffer(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return "draftBuffer must be an array of draft spans";
  }
  let totalChars = 0;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return "each draft span must be an object";
    }
    const s = item as Record<string, unknown>;
    if (typeof s.id !== "string" || s.id.length === 0) {
      return "each draft span needs a string id";
    }
    if (typeof s.text !== "string") {
      return "each draft span needs a string text";
    }
    if (s.text.length > PEN_DRAFT_SPAN_MAX_LENGTH) {
      return `each draft span text must be at most ${PEN_DRAFT_SPAN_MAX_LENGTH} characters`;
    }
    if (s.origin !== "human" && s.origin !== "ai" && s.origin !== "revised") {
      return "draft span origin must be human, ai, or revised";
    }
    if (s.validationState !== "validated" && s.validationState !== "dirty") {
      return "draft span validationState must be validated or dirty";
    }
    totalChars += s.text.length;
  }
  if (totalChars > PEN_DRAFT_BUFFER_MAX_CHARS) {
    return `draftBuffer total length must be at most ${PEN_DRAFT_BUFFER_MAX_CHARS} characters`;
  }
  return null;
}

/**
 * POST /api/pen/sessions
 * Create a Pen session for a book the user owns.
 * Body: { bookId, authoringMode, assistanceLevel? }
 */
router.post("/sessions", requireAuth, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const body = await readJsonBody(c);

    if (!body || typeof body !== "object") {
      return cValidationError(c, "Request body must be a JSON object");
    }
    const { bookId, authoringMode, assistanceLevel, authoringPov } = body as {
      bookId?: string;
      authoringMode?: AuthoringMode;
      assistanceLevel?: number;
      authoringPov?: AuthoringPov | null;
    };

    if (!bookId || typeof bookId !== "string") {
      return cValidationError(c, "bookId is required");
    }
    if (!authoringMode || !PEN_AUTHORING_MODES.includes(authoringMode)) {
      return cValidationError(c, `authoringMode must be one of: ${PEN_AUTHORING_MODES.join(", ")}`);
    }
    if (assistanceLevel !== undefined && (typeof assistanceLevel !== "number" || assistanceLevel < PEN_ASSISTANCE_LEVEL_MIN || assistanceLevel > PEN_ASSISTANCE_LEVEL_MAX)) {
      return cValidationError(c, "assistanceLevel must be a number between 0 and 1");
    }
    if (authoringPov !== undefined && authoringPov !== null && !PEN_AUTHORING_POVS.includes(authoringPov)) {
      return cValidationError(c, `authoringPov must be one of: ${PEN_AUTHORING_POVS.join(", ")} or null`);
    }

    const session = await createPenSession(userId, { bookId, authoringMode, assistanceLevel, authoringPov });
    return c.json({ session });
  } catch (error) {
    if (error instanceof PenSessionConflictError) return cApiError(c, error.message, undefined, 409);
    if (error instanceof PenBookOwnershipError) return cApiError(c, error.message, undefined, 403);
    if (error instanceof PenSessionNotFoundError) return cNotFoundError(c, error.message);
    return cApiError(c, "Failed to create pen session", error);
  }
});

/**
 * GET /api/pen/sessions/:bookId
 * Return the active (or most recent) session for a book, or 404.
 */
router.get("/sessions/:bookId", requireAuth, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const bookId = c.req.param("bookId");

    const session = await getPenSessionForBook(userId, bookId);
    if (!session) return cNotFoundError(c, "No pen session found for this book");

    return c.json({ session });
  } catch (error) {
    return cApiError(c, "Failed to load pen session", error);
  }
});

/**
 * GET /api/pen/sessions/:bookId/outline
 * Flat outline payload (`{ pages, branches }`) for the pen book's page/branch
 * tree (§6.6, Phase 3.d). The frontend builds the hierarchy from `parentId`.
 * Owner-scoped: the authenticated user must own the book.
 */
router.get("/sessions/:bookId/outline", requireAuth, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const bookId = c.req.param("bookId");

    const result = await getPenOutline(userId, bookId);
    return c.json(result);
  } catch (error) {
    if (error instanceof PenBookOwnershipError) return cApiError(c, error.message, undefined, 403);
    if (error instanceof PenSessionNotFoundError) return cNotFoundError(c, error.message);
    return cApiError(c, "Failed to load pen outline", error);
  }
});

/**
 * GET /api/pen/pages/:pageId
 * Full author-owned published page (prose + actions + scene essentials +
 * authorship rollups) for the outline peek popover. Lazy-loaded on demand so
 * the outline payload itself stays light.
 */
router.get("/pages/:pageId", requireAuth, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const pageId = c.req.param("pageId");

    const page = await getPenAuthorPage(userId, pageId);
    return c.json(page);
  } catch (error) {
    if (error instanceof PenBookOwnershipError) return cApiError(c, error.message, undefined, 403);
    if (error instanceof PenSessionNotFoundError) return cNotFoundError(c, error.message);
    return cApiError(c, "Failed to load pen page", error);
  }
});

/**
 * PATCH /api/pen/pages/:pageId/actions
 * Update the text of a specific action on a published page.
 * Body: { actionIndex: number, text: string }
 */
router.patch("/pages/:pageId/actions", requireAuth, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const pageId = c.req.param("pageId");
    const body = await readJsonBody(c);

    if (!body || typeof body !== "object") {
      return cValidationError(c, "Request body must be a JSON object");
    }

    const { actionIndex, text } = body as { actionIndex?: unknown; text?: unknown };
    if (typeof actionIndex !== "number" || !Number.isInteger(actionIndex) || actionIndex < 0) {
      return cValidationError(c, "actionIndex must be a non-negative integer");
    }
    if (typeof text !== "string" || text.trim().length === 0) {
      return cValidationError(c, "text must be a non-empty string");
    }
    if (text.trim().length > PEN_DRAFT_ACTION_TEXT_MAX_LENGTH) {
      return cValidationError(c, `text must be at most ${PEN_DRAFT_ACTION_TEXT_MAX_LENGTH} characters`);
    }

    const page = await updatePenPageAction(userId, pageId, {
      actionIndex,
      text: text.trim(),
    });
    return c.json({ page });
  } catch (error) {
    if (error instanceof PenBookOwnershipError) return cApiError(c, error.message, undefined, 403);
    if (error instanceof PenSessionNotFoundError) return cNotFoundError(c, error.message);
    return cApiError(c, "Failed to update pen page action", error);
  }
});

/**
 * PATCH /api/pen/pages/:pageId/prose
 * Update the prose text of a published page with fast-path & AI canon invariance checking.
 * Body: { text: string, force?: boolean }
 */
router.patch("/pages/:pageId/prose", requireAuth, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const pageId = c.req.param("pageId");
    const body = await readJsonBody(c);

    if (!body || typeof body !== "object") {
      return cValidationError(c, "Request body must be a JSON object");
    }

    const { text, force } = body as { text?: unknown; force?: unknown };
    if (typeof text !== "string" || text.trim().length === 0) {
      return cValidationError(c, "text must be a non-empty string");
    }

    const outcome = await updatePenPageProse(userId, pageId, {
      text: text.trim(),
      force: Boolean(force),
    });

    if (outcome.status === "needs_review") {
      return c.json(outcome, 422);
    }

    return c.json(outcome, 200);
  } catch (error) {
    if (error instanceof PenBookOwnershipError) return cApiError(c, error.message, undefined, 403);
    if (error instanceof PenSessionNotFoundError) return cNotFoundError(c, error.message);
    return cApiError(c, "Failed to update pen page prose", error);
  }
});

/**
 * PATCH /api/pen/sessions/:id
 * Update assistanceLevel, status, currentPageId, or authoringPov on a session
 * the user owns. Draft-workspace fields moved to `PATCH /drafts/:id` (Phase 4).
 */
router.patch("/sessions/:id", requireAuth, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const sessionId = c.req.param("id");
    const body = await readJsonBody(c);

    if (!body || typeof body !== "object") {
      return cValidationError(c, "Request body must be a JSON object");
    }
    const { assistanceLevel, status, currentPageId, authoringPov } = body as {
      assistanceLevel?: number;
      status?: PenSessionStatus;
      currentPageId?: string | null;
      authoringPov?: AuthoringPov | null;
    };

    if (assistanceLevel !== undefined && (typeof assistanceLevel !== "number" || assistanceLevel < PEN_ASSISTANCE_LEVEL_MIN || assistanceLevel > PEN_ASSISTANCE_LEVEL_MAX)) {
      return cValidationError(c, "assistanceLevel must be a number between 0 and 1");
    }
    if (status !== undefined && !PEN_SESSION_STATUSES.includes(status)) {
      return cValidationError(c, `status must be one of: ${PEN_SESSION_STATUSES.join(", ")}`);
    }
    if (currentPageId !== undefined && currentPageId !== null && typeof currentPageId !== "string") {
      return cValidationError(c, "currentPageId must be a string or null");
    }
    if (authoringPov !== undefined && authoringPov !== null && !PEN_AUTHORING_POVS.includes(authoringPov)) {
      return cValidationError(c, `authoringPov must be one of: ${PEN_AUTHORING_POVS.join(", ")} or null`);
    }

    const session = await updatePenSession(userId, sessionId, { assistanceLevel, status, currentPageId, authoringPov });
    return c.json({ session });
  } catch (error) {
    if (error instanceof PenSessionNotFoundError) return cNotFoundError(c, error.message);
    return cApiError(c, "Failed to update pen session", error);
  }
});

/**
 * PATCH /api/pen/sessions/:id/outline
 * Updates outline beats on the active page's story state (StoryState.viableEnding in PostgreSQL story_states)
 * and synchronizes the book-level blueprint (books.ending in PostgreSQL books).
 */
router.patch("/sessions/:id/outline", requireAuth, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const sessionId = c.req.param("id");
    const body = await readJsonBody(c);

    if (!body || typeof body !== "object") {
      return cValidationError(c, "Request body must be a JSON object");
    }
    const { outline } = body as { outline?: StoryOutline[] };
    if (!Array.isArray(outline)) {
      return cValidationError(c, "outline must be an array of StoryOutline items");
    }

    const result = await updatePenSessionOutline(userId, sessionId, outline);
    return c.json(result);
  } catch (error) {
    if (error instanceof PenSessionNotFoundError) return cNotFoundError(c, error.message);
    return cApiError(c, "Failed to update pen session outline", error);
  }
});

/**
 * PATCH /api/pen/sessions/:id/ending
 * Updates the ending direction ("North Star") and outline beats for the active branch/page
 * (StoryState.viableEnding in PostgreSQL story_states), or resets it to the main book blueprint.
 */
router.patch("/sessions/:id/ending", requireAuth, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const sessionId = c.req.param("id");
    const body = await readJsonBody(c);

    if (!body || typeof body !== "object") {
      return cValidationError(c, "Request body must be a JSON object");
    }
    const { text, type, outline, resetToMain } = body as {
      text?: string;
      type?: unknown;
      outline?: StoryOutline[];
      resetToMain?: boolean;
    };

    if (text !== undefined && typeof text !== "string") {
      return cValidationError(c, "text must be a string");
    }
    if (outline !== undefined && !Array.isArray(outline)) {
      return cValidationError(c, "outline must be an array of StoryOutline items");
    }
    if (resetToMain !== undefined && typeof resetToMain !== "boolean") {
      return cValidationError(c, "resetToMain must be a boolean");
    }

    const result = await updatePenSessionEnding(userId, sessionId, {
      text: typeof text === "string" ? text : undefined,
      type: typeof type === "string" ? (type as any) : undefined,
      outline: Array.isArray(outline) ? outline : undefined,
      resetToMain: Boolean(resetToMain),
    });
    return c.json(result);
  } catch (error) {
    if (error instanceof PenSessionNotFoundError) return cNotFoundError(c, error.message);
    return cApiError(c, "Failed to update pen session ending", error);
  }
});

/**
 * POST /api/pen/sessions/:id/close
 * Mark a session closed (draft preserved for resume).
 */
router.post("/sessions/:id/close", requireAuth, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const sessionId = c.req.param("id");

    const session = await closePenSession(userId, sessionId);
    return c.json({ session });
  } catch (error) {
    if (error instanceof PenSessionNotFoundError) return cNotFoundError(c, error.message);
    return cApiError(c, "Failed to close pen session", error);
  }
});

/**
 * POST /api/pen/sessions/:id/discard
 * Permanently delete the active draft slot (zero cost). The session itself is
 * preserved; the most recently touched sibling becomes the new active draft.
 */
router.post("/sessions/:id/discard", requireAuth, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const sessionId = c.req.param("id");

    const session = await discardPenDraft(userId, sessionId);
    return c.json({ session });
  } catch (error) {
    if (error instanceof PenSessionNotFoundError) return cNotFoundError(c, error.message);
    return cApiError(c, "Failed to discard pen draft", error);
  }
});

/**
 * GET /api/pen/sessions/:id/drafts
 * Lists every in-flight draft slot for the outline draft shelf (roadmap §7).
 * Returns lightweight summaries only — the full buffer/html rides on the
 * session payload (active draft) or the per-draft PATCH responses.
 */
router.get("/sessions/:id/drafts", requireAuth, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const sessionId = c.req.param("id");

    const drafts = await listSessionDrafts(userId, sessionId);
    return c.json({ drafts });
  } catch (error) {
    if (error instanceof PenSessionNotFoundError) return cNotFoundError(c, error.message);
    return cApiError(c, "Failed to list pen drafts", error);
  }
});

/**
 * POST /api/pen/sessions/:id/drafts
 * Creates a new in-flight draft slot (roadmap §6.1). Body:
 * `{ parentPageId?, label?, activate? }` — the published page being continued
 * from (null → the would-be page 1), an optional editorial label, and whether
 * the new slot should immediately become the active draft (the "New draft" /
 * branchFromPage action). Enforces the soft per-parent cap
 * (PEN_DRAFTS_PER_PARENT). Returns the session payload so the frontend can sync
 * its shelf + editor state in one round trip.
 */
router.post("/sessions/:id/drafts", requireAuth, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const sessionId = c.req.param("id");
    const body = await readJsonBody(c);

    if (!body || typeof body !== "object") {
      return cValidationError(c, "Request body must be a JSON object");
    }
    const { parentPageId, label, actionText, activate } = body as { parentPageId?: unknown; label?: unknown; actionText?: unknown; activate?: unknown };
    if (parentPageId !== undefined && parentPageId !== null && typeof parentPageId !== "string") {
      return cValidationError(c, "parentPageId must be a string or null");
    }
    if (label !== undefined && typeof label !== "string") {
      return cValidationError(c, "label must be a string");
    }
    if (typeof label === "string" && label.trim().length > PEN_DRAFT_LABEL_MAX_LENGTH) {
      return cValidationError(c, `label must be at most ${PEN_DRAFT_LABEL_MAX_LENGTH} characters`);
    }
    if (actionText !== undefined && typeof actionText !== "string") {
      return cValidationError(c, "actionText must be a string");
    }
    if (typeof actionText === "string" && actionText.trim().length > PEN_DRAFT_ACTION_TEXT_MAX_LENGTH) {
      return cValidationError(c, `actionText must be at most ${PEN_DRAFT_ACTION_TEXT_MAX_LENGTH} characters`);
    }
    if (activate !== undefined && typeof activate !== "boolean") {
      return cValidationError(c, "activate must be a boolean");
    }

    const session = await createSessionDraft(userId, sessionId, {
      parentPageId: typeof parentPageId === "string" ? parentPageId : null,
      label: typeof label === "string" ? label : undefined,
      actionText: typeof actionText === "string" ? actionText : undefined,
      activate: activate === true,
    });
    return c.json({ session });
  } catch (error) {
    if (error instanceof PenSessionNotFoundError) return cNotFoundError(c, error.message);
    if (error instanceof PenDraftLimitError) return cApiError(c, error.message, undefined, 422);
    return cApiError(c, "Failed to create pen draft", error);
  }
});

/**
 * POST /api/pen/sessions/:id/drafts/:draftId/activate
 * Switches `activeDraftId` to the given slot — the outline "switch draft"
 * action. Returns the session payload (the editor hydrates from its draft view).
 */
router.post("/sessions/:id/drafts/:draftId/activate", requireAuth, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const sessionId = c.req.param("id");
    const draftId = c.req.param("draftId");

    const session = await activateSessionDraft(userId, sessionId, draftId);
    return c.json({ session });
  } catch (error) {
    if (error instanceof PenSessionNotFoundError) return cNotFoundError(c, error.message);
    return cApiError(c, "Failed to activate pen draft", error);
  }
});

/**
 * PATCH /api/pen/sessions/:id/drafts/:draftId
 * Autosave heartbeat for a single draft slot (roadmap §6.1). Allowed fields:
 * `{ label?, draftBuffer?, draftHtml?, draftCharactersPresent?,
 * draftSceneEssentials?, draftUpdatedAt? }`. Buffer/html writes are dropped
 * when `draftUpdatedAt` is not newer than the stored row's `updatedAt`
 * (last-write-wins). Returns `{ draft }` (the updated row).
 */
router.patch("/sessions/:id/drafts/:draftId", requireAuth, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const sessionId = c.req.param("id");
    const draftId = c.req.param("draftId");
    const body = await readJsonBody(c);

    if (!body || typeof body !== "object") {
      return cValidationError(c, "Request body must be a JSON object");
    }
    const { label, actionText, draftBuffer, draftHtml, draftCharactersPresent, draftSceneEssentials, isEnding, draftUpdatedAt } = body as {
      label?: unknown;
      actionText?: unknown;
      draftBuffer?: unknown;
      draftHtml?: unknown;
      draftCharactersPresent?: unknown;
      draftSceneEssentials?: unknown;
      isEnding?: unknown;
      draftUpdatedAt?: unknown;
    };

    if (label !== undefined && typeof label !== "string") {
      return cValidationError(c, "label must be a string");
    }
    if (typeof label === "string" && label.trim().length > PEN_DRAFT_LABEL_MAX_LENGTH) {
      return cValidationError(c, `label must be at most ${PEN_DRAFT_LABEL_MAX_LENGTH} characters`);
    }
    if (actionText !== undefined && typeof actionText !== "string") {
      return cValidationError(c, "actionText must be a string");
    }
    if (typeof actionText === "string" && actionText.trim().length > PEN_DRAFT_ACTION_TEXT_MAX_LENGTH) {
      return cValidationError(c, `actionText must be at most ${PEN_DRAFT_ACTION_TEXT_MAX_LENGTH} characters`);
    }
    if (isEnding !== undefined && typeof isEnding !== "boolean") {
      return cValidationError(c, "isEnding must be a boolean");
    }
    if (draftBuffer !== undefined) {
      const bufferError = validateDraftBuffer(draftBuffer);
      if (bufferError) return cValidationError(c, bufferError);
    }
    if (draftHtml !== undefined && typeof draftHtml !== "string") {
      return cValidationError(c, "draftHtml must be a string");
    }
    if (typeof draftHtml === "string" && draftHtml.length > PEN_DRAFT_HTML_MAX_LENGTH) {
      return cValidationError(c, `draftHtml must be at most ${PEN_DRAFT_HTML_MAX_LENGTH} characters`);
    }
    if (draftCharactersPresent !== undefined) {
      if (!Array.isArray(draftCharactersPresent) || draftCharactersPresent.length > PEN_DRAFT_CAST_LIMIT) {
        return cValidationError(c, `draftCharactersPresent must be an array of at most ${PEN_DRAFT_CAST_LIMIT} cast members`);
      }
      for (const member of draftCharactersPresent) {
        const memberError = validateDraftCastMember(member);
        if (memberError) return cValidationError(c, memberError);
      }
    }
    if (draftSceneEssentials !== undefined) {
      const essentialsError = validateDraftSceneEssentials(draftSceneEssentials);
      if (essentialsError) return cValidationError(c, essentialsError);
    }
    if (draftUpdatedAt !== undefined && (typeof draftUpdatedAt !== "string" || Number.isNaN(Date.parse(draftUpdatedAt)))) {
      return cValidationError(c, "draftUpdatedAt must be a valid date string");
    }

    const draft = await updateSessionDraft(userId, sessionId, draftId, {
      label: typeof label === "string" ? label : undefined,
      actionText: typeof actionText === "string" ? actionText : undefined,
      draftBuffer: draftBuffer as DraftSpan[] | undefined,
      draftHtml: typeof draftHtml === "string" ? draftHtml : undefined,
      draftCharactersPresent: draftCharactersPresent as PenDraftCharacter[] | undefined,
      draftSceneEssentials: draftSceneEssentials as PenDraftSceneEssentials | null | undefined,
      isEnding: typeof isEnding === "boolean" ? isEnding : undefined,
      draftUpdatedAt: typeof draftUpdatedAt === "string" ? draftUpdatedAt : undefined,
    });
    return c.json({ draft });
  } catch (error) {
    if (error instanceof PenSessionNotFoundError) return cNotFoundError(c, error.message);
    return cApiError(c, "Failed to update pen draft", error);
  }
});

/**
 * DELETE /api/pen/sessions/:id/drafts/:draftId
 * Permanently deletes a single draft slot (zero cost). If it was the active
 * draft, the most recently touched sibling becomes active (or the editor
 * empties). Returns the session payload.
 */
router.delete("/sessions/:id/drafts/:draftId", requireAuth, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const sessionId = c.req.param("id");
    const draftId = c.req.param("draftId");

    const session = await discardSessionDraft(userId, sessionId, draftId);
    return c.json({ session });
  } catch (error) {
    if (error instanceof PenSessionNotFoundError) return cNotFoundError(c, error.message);
    return cApiError(c, "Failed to discard pen draft", error);
  }
});

/**
 * POST /api/pen/sessions/:id/continue
 * Runs the single-request validate-and-generate continuation for an active
 * session the user owns. Body (discriminated by `type`):
 *   storyteller   -> { type: 'storyteller', prose, directionHint?, assistanceLevel? }
 *   text_adventure-> { type: 'text_adventure', command, assistanceLevel? }
 * `assistanceLevel?` (0..1) snaps to the continuation-length tier (short/medium/
 * long, §8) — it chooses how many words the AI appends and the credit cost, and
 * is persisted onto the session so the default stays convergent with what the
 * author last used. Returns { span, edit, draft } where span is validated/dirty.
 */
router.post("/sessions/:id/continue", requireAuth, rateLimit(PEN_CONTINUE_RATE_LIMIT), requireNotSuspended, requireGenerationQuota, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const sessionId = c.req.param("id");
    const body = await readJsonBody(c);

    if (!body || typeof body !== "object") {
      return cValidationError(c, "Request body must be a JSON object");
    }

    let input: PenContinueInput;
    const raw = body as Record<string, unknown>;

    const draftIdParam = raw.draftId;
    if (draftIdParam !== undefined && (typeof draftIdParam !== "string" || draftIdParam.trim().length === 0)) {
      return cValidationError(c, "draftId must be a non-empty string");
    }

    const authoringPov = raw.authoringPov as AuthoringPov | null | undefined;
    if (authoringPov !== undefined && authoringPov !== null && !PEN_AUTHORING_POVS.includes(authoringPov)) {
      return cValidationError(c, `authoringPov must be one of: ${PEN_AUTHORING_POVS.join(", ")} or null`);
    }

    const assistanceLevel = raw.assistanceLevel as number | undefined;
    if (assistanceLevel !== undefined && (typeof assistanceLevel !== "number" || assistanceLevel < PEN_ASSISTANCE_LEVEL_MIN || assistanceLevel > PEN_ASSISTANCE_LEVEL_MAX)) {
      return cValidationError(c, "assistanceLevel must be a number between 0 and 1");
    }

    if (raw.type === "text_adventure") {
      if (typeof raw.command !== "string" || raw.command.trim().length === 0) {
        return cValidationError(c, "command is required for text_adventure");
      }
      input = { type: "text_adventure", command: raw.command, authoringPov: authoringPov ?? undefined, assistanceLevel };
    } else if (raw.type === "storyteller") {
      if (typeof raw.prose !== "string" || raw.prose.trim().length === 0) {
        return cValidationError(c, "prose is required for storyteller");
      }
      if (raw.prose.length > PEN_CONTINUE_PROSE_MAX_LENGTH) {
        return cValidationError(c, `prose must be at most ${PEN_CONTINUE_PROSE_MAX_LENGTH} characters`);
      }
      if (raw.directionHint !== undefined && typeof raw.directionHint !== "string") {
        return cValidationError(c, "directionHint must be a string");
      }
      if (typeof raw.directionHint === "string" && raw.directionHint.length > PEN_DIRECTION_HINT_MAX_LENGTH) {
        return cValidationError(c, `directionHint must be at most ${PEN_DIRECTION_HINT_MAX_LENGTH} characters`);
      }
      input = {
        type: "storyteller",
        prose: raw.prose,
        directionHint: typeof raw.directionHint === "string" ? raw.directionHint : undefined,
        authoringPov: authoringPov ?? undefined,
        assistanceLevel,
      };
    } else {
      return cValidationError(c, "type must be 'storyteller' or 'text_adventure'");
    }

    // Multi-draft: continue always targets a draft slot. Optional `draftId`
    // defaults to the session's active draft (backward compat for older
    // clients). `null` when no draft exists yet.
    let draftId: string | undefined = typeof draftIdParam === "string" ? draftIdParam : undefined;
    if (!draftId) {
      const session = await getPenSessionById(userId, sessionId);
      draftId = session.activeDraftId ?? undefined;
    }
    if (!draftId) {
      return cValidationError(c, "No active draft to continue — create one first");
    }

    const result = await continuePenDraft(userId, sessionId, draftId, input);
    return c.json(result);
  } catch (error) {
    if (error instanceof PenSessionNotFoundError) return cNotFoundError(c, error.message);
    if (error instanceof PenBookOwnershipError) return cApiError(c, error.message, undefined, 403);
    if (error instanceof PenDraftNotActiveError) return cApiError(c, error.message, undefined, 409);
    if (error instanceof PenContinueError) return cApiError(c, error.message, undefined, 422);
    return cApiError(c, "Failed to continue pen draft", error);
  }
});

/**
 * POST /api/pen/sessions/:id/transform
 * Runs an in-editor block action (rephrase, continue, describe, visualize, twist)
 * on a highlighted selection in the active draft surface.
 * Body: {
 *   draftId?: string,
 *   selection: { text: string, from?: number, to?: number },
 *   action: PenBlockAction,
 *   subAction?: string,
 *   customInstruction?: string,
 *   surroundingProse?: string,
 *   authoringPov?: AuthoringPov
 * }
 */
router.post("/sessions/:id/transform", requireAuth, rateLimit(PEN_TRANSFORM_RATE_LIMIT), requireNotSuspended, requireGenerationQuota, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const sessionId = c.req.param("id");
    const body = await readJsonBody(c);

    if (!body || typeof body !== "object") {
      return cValidationError(c, "Request body must be a JSON object");
    }

    const raw = body as Record<string, unknown>;

    const selection = raw.selection as { text?: unknown; from?: unknown; to?: unknown } | undefined;
    if (!selection || typeof selection !== "object" || typeof selection.text !== "string" || selection.text.trim().length === 0) {
      return cValidationError(c, "selection with non-empty text is required");
    }
    if (selection.text.length > PEN_TRANSFORM_SELECTION_MAX_LENGTH) {
      return cValidationError(c, `selection text must be at most ${PEN_TRANSFORM_SELECTION_MAX_LENGTH} characters`);
    }

    const action = raw.action as PenBlockAction;
    if (!action || !penBlockActions.includes(action)) {
      return cValidationError(c, `action must be one of: ${penBlockActions.join(", ")}`);
    }

    const subAction = typeof raw.subAction === "string" ? raw.subAction.trim() : undefined;
    const customInstruction = typeof raw.customInstruction === "string" ? raw.customInstruction.trim() : undefined;
    const surroundingProse = typeof raw.surroundingProse === "string" ? raw.surroundingProse : undefined;

    const authoringPov = raw.authoringPov as AuthoringPov | null | undefined;
    if (authoringPov !== undefined && authoringPov !== null && !PEN_AUTHORING_POVS.includes(authoringPov)) {
      return cValidationError(c, `authoringPov must be one of: ${PEN_AUTHORING_POVS.join(", ")} or null`);
    }

    const draftIdParam = raw.draftId;
    if (draftIdParam !== undefined && (typeof draftIdParam !== "string" || draftIdParam.trim().length === 0)) {
      return cValidationError(c, "draftId must be a non-empty string");
    }

    const result = await transformPenSelection(userId, sessionId, {
      draftId: typeof draftIdParam === "string" ? draftIdParam : undefined,
      selection: {
        text: selection.text,
        from: typeof selection.from === "number" ? selection.from : undefined,
        to: typeof selection.to === "number" ? selection.to : undefined,
      },
      action,
      subAction,
      customInstruction,
      surroundingProse,
      authoringPov: authoringPov ?? undefined,
    });

    return c.json(result);
  } catch (error) {
    if (error instanceof PenSessionNotFoundError) return cNotFoundError(c, error.message);
    if (error instanceof PenBookOwnershipError) return cApiError(c, error.message, undefined, 403);
    if (error instanceof PenTransformError) return cApiError(c, error.message, undefined, 422);
    return cApiError(c, "Failed to transform pen selection", error);
  }
});

/**
 * POST /api/pen/sessions/:id/essentials/autofill
 * AI-fill the blank Page Essentials fields (mood/weather/date/time/keys/place)
 * for the next page, from the session's canon + recent prose + the author's
 * current in-progress draft.
 *
 * Body: `{ draftText?, mode? }` — the current draft prose (plain text) and the
 * autofill mode (`fill_empty` | `review_all`, default `fill_empty`). The service
 * never mutates the session: it returns a COMPLETE proposal and the frontend
 * applies only the currently-blank fields (fill mode) or shows per-field diffs
 * for acceptance (review mode), persisting via the normal debounced
 * `PATCH /sessions/:id`. Every proposed value is clamped server-side (enum
 * mood/weather, bible-place resolution, length caps). Charges
 * `PEN_ESSENTIALS_AUTOFILL` (1 credit) and writes a `plan` audit row.
 */
router.post("/sessions/:id/essentials/autofill", requireAuth, rateLimit(PEN_ESSENTIALS_RATE_LIMIT), requireNotSuspended, requireGenerationQuota, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const sessionId = c.req.param("id");
    const body = await readJsonBody(c);

    const input: PenEssentialsAutofillInput = {};
    const raw = body as { draftText?: unknown; mode?: unknown } | null | undefined;
    if (raw && typeof raw.draftText === "string") {
      if (raw.draftText.length > PEN_DRAFT_TEXT_MAX_LENGTH) {
        return cValidationError(c, `draftText must be at most ${PEN_DRAFT_TEXT_MAX_LENGTH} characters`);
      }
      input.draftText = raw.draftText;
    }
    if (raw && (raw.mode === "fill_empty" || raw.mode === "review_all")) {
      input.mode = raw.mode;
    }

    const result = await autofillSceneEssentials(userId, sessionId, input);
    return c.json(result);
  } catch (error) {
    if (error instanceof PenSessionNotFoundError) return cNotFoundError(c, error.message);
    if (error instanceof PenBookOwnershipError) return cApiError(c, error.message, undefined, 403);
    if (error instanceof PenEssentialsAutofillError) return cApiError(c, error.message, undefined, 422);
    return cApiError(c, "Failed to autofill scene essentials", error);
  }
});

/**
 * POST /api/pen/sessions/:id/cast/detect
 * Scans story text from the draft to infer all characters present on the scene,
 * their roles, focus weights, and propose new lore entities.
 *
 * Body: `{ draftText }` — the current draft prose (plain text).
 * Charges `PEN_DETECT_CAST` (1 credit) and writes a `plan` audit row.
 */
router.post("/sessions/:id/cast/detect", requireAuth, rateLimit(PEN_CAST_DETECT_RATE_LIMIT), requireNotSuspended, requireGenerationQuota, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const sessionId = c.req.param("id");
    const body = await readJsonBody(c);

    const raw = body as { draftText?: unknown } | null | undefined;
    if (!raw || typeof raw.draftText !== "string" || !raw.draftText.trim()) {
      return cValidationError(c, "draftText with non-empty text is required");
    }
    if (raw.draftText.length > PEN_DRAFT_TEXT_MAX_LENGTH) {
      return cValidationError(c, `draftText must be at most ${PEN_DRAFT_TEXT_MAX_LENGTH} characters`);
    }

    const input: PenCastDetectInput = { draftText: raw.draftText };
    const result = await detectSceneCast(userId, sessionId, input);
    return c.json(result);
  } catch (error) {
    if (error instanceof PenSessionNotFoundError) return cNotFoundError(c, error.message);
    if (error instanceof PenBookOwnershipError) return cApiError(c, error.message, undefined, 403);
    if (error instanceof PenCastDetectError) return cApiError(c, error.message, undefined, 422);
    return cApiError(c, "Failed to detect scene cast characters", error);
  }
});

/**
 * POST /api/pen/sessions/:id/finalize/propose
 * AI-compute the next page's scene pin + inventory/injuries as an "adopt as
 * canon" proposal (§2.i / §10).
 *
 * Body: `{ draftText? }` — the current draft prose (plain text). The service
 * never mutates the session: it returns a COMPLETE next-state proposal
 * `{ mood?, weather?, calendarDate?, timeOfDay?, inventory, injuries,
 * keyEvents, keyObjects }` (full-replacement arrays) that the frontend shows
 * in the publish dialog for acceptance/editing, then sends back via
 * `/finalize` as `adoptMood`/`adoptWeather`/`adoptCalendarDate`/
 * `adoptTimeOfDay`/`adoptInventory`/`adoptInjuries`. Page 1 has no prior
 * state, so inventory/injuries come back empty but the scene pin is still
 * proposed from the opening draft. Free (`PEN_FINALIZE_PROPOSE` = 0) and
 * writes a `plan` audit row.
 */
router.post("/sessions/:id/finalize/propose", requireAuth, rateLimit(PEN_FINALIZE_PROPOSE_RATE_LIMIT), async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const sessionId = c.req.param("id");
    const body = await readJsonBody(c);

    const input: PenStateProposalInput = {};
    const raw = body as { draftText?: unknown; actionText?: unknown } | null | undefined;
    if (raw && typeof raw.draftText === "string") {
      if (raw.draftText.length > PEN_DRAFT_TEXT_MAX_LENGTH) {
        return cValidationError(c, `draftText must be at most ${PEN_DRAFT_TEXT_MAX_LENGTH} characters`);
      }
      input.draftText = raw.draftText;
    }
    if (raw && typeof raw.actionText === "string") {
      if (raw.actionText.trim().length > PEN_DRAFT_ACTION_TEXT_MAX_LENGTH) {
        return cValidationError(c, `actionText must be at most ${PEN_DRAFT_ACTION_TEXT_MAX_LENGTH} characters`);
      }
      input.actionText = raw.actionText;
    }

    const result = await proposePenStateUpdates(userId, sessionId, input);
    return c.json(result);
  } catch (error) {
    if (error instanceof PenSessionNotFoundError) return cNotFoundError(c, error.message);
    if (error instanceof PenBookOwnershipError) return cApiError(c, error.message, undefined, 403);
    if (error instanceof PenStateProposalError) return cApiError(c, error.message, undefined, 422);
    return cApiError(c, "Failed to propose the next page state", error);
  }
});

/**
 * POST /api/pen/sessions/:id/finalize
 * Publish the session's draft as the next story page (Phase 1.c).
 *
 * Phase A runs the advisory delta gate over dirty/stale spans only (§6.7). If
 * the gate found high-severity findings and `force` was not passed, it returns
 * `{ status: 'needs_review', violations }` with nothing written. With `force`
 * (or a clean/author-consistent draft) it publishes via `persistPageWithState`
 * / `insertStoryPage`, rolls the draft up into `penEdits` spans with character
 * offsets, and clears the draft.
 * Body: { force?, amendments?, actions?, adoptInventory?, adoptInjuries? } —
 * `actions` supplies author-defined next choices for interactive/multiverse;
 * novel always uses the single default. `adoptInventory`/`adoptInjuries` are
 * the confirmed "adopt as canon" state proposal from `/finalize/propose`.
 */
router.post("/sessions/:id/finalize", requireAuth, rateLimit({ maxRequests: 10, windowSeconds: 60 }), requireNotSuspended, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const sessionId = c.req.param("id");

    // BE3: distinguish "no body" (publish clean, the client may send an empty
    // finalize) from "body sent but corrupted" (400 — adoptions/actions must
    // never be silently dropped by a truncated request).
    let body: PenFinalizeInput = {};
    const rawText = await c.req.text();
    if (rawText.trim().length > 0) {
      let raw: unknown;
      try {
        raw = JSON.parse(rawText);
      } catch {
        return cValidationError(c, "finalize body is not valid JSON");
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return cValidationError(c, "finalize body must be a JSON object");
      }
      body = raw as PenFinalizeInput;
    }

    if (body.force !== undefined && typeof body.force !== "boolean") {
      return cValidationError(c, "force must be a boolean");
    }
    if (body.isEnding !== undefined && typeof body.isEnding !== "boolean") {
      return cValidationError(c, "isEnding must be a boolean");
    }
    if (body.actions !== undefined && (!Array.isArray(body.actions) || body.actions.length > PEN_FINALIZE_MAX_ACTIONS)) {
      return cValidationError(c, `actions must be an array of at most ${PEN_FINALIZE_MAX_ACTIONS} items`);
    }
    if (body.actions !== undefined) {
      const allowedTypes = Object.keys(actionTypes);
      for (const action of body.actions) {
        if (!action || typeof action !== "object" || Array.isArray(action)) {
          return cValidationError(c, "each action must be an object");
        }
        if (typeof action.text !== "string" || action.text.trim().length === 0) {
          return cValidationError(c, "each action needs a non-empty text");
        }
        if (typeof action.type !== "string" || !allowedTypes.includes(action.type)) {
          return cValidationError(c, `each action type must be one of: ${allowedTypes.join(", ")}`);
        }
        if (action.hint !== undefined && (typeof action.hint !== "object" || Array.isArray(action.hint))) {
          return cValidationError(c, "each action hint must be an object");
        }
      }
    }
    if (body.adoptInventory !== undefined && (!Array.isArray(body.adoptInventory) || body.adoptInventory.length > PEN_FINALIZE_PROPOSE_MAX_INVENTORY_ITEMS)) {
      return cValidationError(c, `adoptInventory must be an array of at most ${PEN_FINALIZE_PROPOSE_MAX_INVENTORY_ITEMS} items`);
    }
    if (body.adoptInjuries !== undefined && (!Array.isArray(body.adoptInjuries) || body.adoptInjuries.length > PEN_FINALIZE_PROPOSE_MAX_INJURIES)) {
      return cValidationError(c, `adoptInjuries must be an array of at most ${PEN_FINALIZE_PROPOSE_MAX_INJURIES} items`);
    }
    if (body.adoptKeyEvents !== undefined && (!Array.isArray(body.adoptKeyEvents) || body.adoptKeyEvents.length > PEN_ESSENTIALS_MAX_LIST_ITEMS)) {
      return cValidationError(c, `adoptKeyEvents must be an array of at most ${PEN_ESSENTIALS_MAX_LIST_ITEMS} items`);
    }
    if (body.adoptKeyObjects !== undefined && (!Array.isArray(body.adoptKeyObjects) || body.adoptKeyObjects.length > PEN_ESSENTIALS_MAX_LIST_ITEMS)) {
      return cValidationError(c, `adoptKeyObjects must be an array of at most ${PEN_ESSENTIALS_MAX_LIST_ITEMS} items`);
    }
    if (body.adoptOutline !== undefined) {
      if (!Array.isArray(body.adoptOutline) || body.adoptOutline.length > PEN_ENDING_OUTLINE_MAX_ITEMS) {
        return cValidationError(c, `adoptOutline must be an array of at most ${PEN_ENDING_OUTLINE_MAX_ITEMS} items`);
      }
      for (const beat of body.adoptOutline) {
        if (!beat || typeof beat !== "object" || Array.isArray(beat)) {
          return cValidationError(c, "each outline beat must be an object");
        }
        if (typeof beat.text !== "string" || beat.text.trim().length === 0) {
          return cValidationError(c, "each outline beat needs a non-empty text");
        }
        if (typeof beat.isDone !== "boolean") {
          return cValidationError(c, "each outline beat isDone must be a boolean");
        }
      }
    }
    if (body.adoptPlotFlags !== undefined) {
      if (!Array.isArray(body.adoptPlotFlags)) {
        return cValidationError(c, "adoptPlotFlags must be an array");
      }
      for (const flag of body.adoptPlotFlags) {
        if (!flag || typeof flag !== "object" || Array.isArray(flag)) {
          return cValidationError(c, "each plot flag must be an object");
        }
        if (typeof flag.fact !== "string" || flag.fact.trim().length === 0) {
          return cValidationError(c, "each plot flag needs a non-empty fact");
        }
        if (typeof flag.isMajorEvent !== "boolean") {
          return cValidationError(c, "each plot flag isMajorEvent must be a boolean");
        }
      }
    }
    if (body.adoptFacts !== undefined) {
      if (!Array.isArray(body.adoptFacts)) {
        return cValidationError(c, "adoptFacts must be an array");
      }
      for (const fact of body.adoptFacts) {
        if (!fact || typeof fact !== "object" || Array.isArray(fact)) {
          return cValidationError(c, "each fact must be an object");
        }
        if (typeof fact.key !== "string" || fact.key.trim().length === 0) {
          return cValidationError(c, "each fact needs a non-empty key");
        }
        if (typeof fact.value !== "string" || fact.value.trim().length === 0) {
          return cValidationError(c, "each fact needs a non-empty value");
        }
      }
    }
    if (body.adoptMood !== undefined && (typeof body.adoptMood !== "string" || !moods.includes(body.adoptMood as (typeof moods)[number]))) {
      return cValidationError(c, "adoptMood must be a valid mood key");
    }
    if (body.adoptWeather !== undefined && (typeof body.adoptWeather !== "string" || !placeWeathers.includes(body.adoptWeather as (typeof placeWeathers)[number]))) {
      return cValidationError(c, "adoptWeather must be a valid weather key");
    }
    if (body.adoptCalendarDate !== undefined && (typeof body.adoptCalendarDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.adoptCalendarDate))) {
      return cValidationError(c, "adoptCalendarDate must be a YYYY-MM-DD string");
    }
    if (body.adoptTimeOfDay !== undefined && (typeof body.adoptTimeOfDay !== "string" || body.adoptTimeOfDay.trim().length === 0 || body.adoptTimeOfDay.length > PEN_ESSENTIALS_MAX_FIELD_LENGTH)) {
      return cValidationError(c, `adoptTimeOfDay must be a non-empty string of at most ${PEN_ESSENTIALS_MAX_FIELD_LENGTH} characters`);
    }
    if (body.adoptActionType !== undefined && (typeof body.adoptActionType !== "string" || !Object.keys(actionTypes).includes(body.adoptActionType))) {
      return cValidationError(c, `adoptActionType must be one of: ${Object.keys(actionTypes).join(", ")}`);
    }
    if (body.adoptActionHint !== undefined) {
      const hint = body.adoptActionHint as { text?: unknown; type?: unknown };
      if (!hint || typeof hint !== "object" || Array.isArray(hint)) {
        return cValidationError(c, "adoptActionHint must be an object");
      }
      if (hint.text !== undefined && (typeof hint.text !== "string" || hint.text.length > PEN_DRAFT_ACTION_HINT_MAX_LENGTH)) {
        return cValidationError(c, `adoptActionHint.text must be a string of at most ${PEN_DRAFT_ACTION_HINT_MAX_LENGTH} characters`);
      }
      if (hint.type !== undefined && (typeof hint.type !== "string" || !actionHintTypes.includes(hint.type as (typeof actionHintTypes)[number]))) {
        return cValidationError(c, `adoptActionHint.type must be one of: ${actionHintTypes.join(", ")}`);
      }
    }

    // Multi-draft: finalize publishes exactly one draft slot. Optional `draftId`
    // defaults to the session's active draft (backward compat).
    const draftIdParam = (body as Record<string, unknown>).draftId;
    if (draftIdParam !== undefined && (typeof draftIdParam !== "string" || draftIdParam.trim().length === 0)) {
      return cValidationError(c, "draftId must be a non-empty string");
    }
    let draftId: string | undefined = typeof draftIdParam === "string" ? draftIdParam : undefined;
    if (!draftId) {
      const session = await getPenSessionById(userId, sessionId, { client: dbWrite });
      draftId = session.activeDraftId ?? undefined;
    }
    if (!draftId) {
      return cValidationError(c, "No active draft to finalize — create one first");
    }

    const result = await finalizePenDraft(userId, sessionId, draftId, body);
    return c.json(result);
  } catch (error) {
    if (error instanceof PenSessionNotFoundError) return cNotFoundError(c, error.message);
    if (error instanceof PenBookOwnershipError) return cApiError(c, error.message, undefined, 403);
    if (error instanceof PenDraftNotActiveError) return cApiError(c, error.message, undefined, 409);
    if (error instanceof PenFinalizeError) return cApiError(c, error.message, undefined, 422);
    return cApiError(c, "Failed to finalize pen draft", error);
  }
});

/**
 * GET /api/pen/sessions/:id/state
 * Story state for the session's current published page — the same StoryState
 * the reader companion consumes (drawer panels + scene-cast suggestions).
 * `{ state: null }` before page 1 finalizes (§1.e).
 */
router.get("/sessions/:id/state", requireAuth, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const sessionId = c.req.param("id");

    const result = await getPenSessionState(userId, sessionId);
    return c.json(result);
  } catch (error) {
    if (error instanceof PenSessionNotFoundError) return cNotFoundError(c, error.message);
    return cApiError(c, "Failed to load pen session state", error);
  }
});

/**
 * GET /api/pen/session/:id
 * Return a single session by id (ownership verified).
 *
 * Uses the singular `/session` prefix so it does not collide with the
 * `/sessions/:bookId` lookup — Hono resolves identical `:param` patterns to the
 * first registered handler, which silently shadowed this route.
 */
router.get("/session/:id", requireAuth, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const sessionId = c.req.param("id");

    const session = await getPenSessionById(userId, sessionId);
    return c.json({ session });
  } catch (error) {
    if (error instanceof PenSessionNotFoundError) return cNotFoundError(c, error.message);
    return cApiError(c, "Failed to load pen session", error);
  }
});

/**
 * POST /api/pen/sessions/:id/images
 * Upload an inline draft image for a session the user owns and record it in
 * `uploaded_images` (type `pen`). Body: `{ imageBase64 }` — a base64 data URL
 * produced by the Pen editor's image compression. Returns `{ imageUrl }`, which
 * the editor embeds in the draft HTML. Ownership is verified via the session.
 */
router.post("/sessions/:id/images", requireAuth, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const sessionId = c.req.param("id");
    const body = await readJsonBody(c);

    if (!body || typeof body !== "object") {
      return cValidationError(c, "Request body must be a JSON object");
    }
    const { imageBase64 } = body as { imageBase64?: unknown };
    if (!isBase64Upload(imageBase64)) {
      return cValidationError(c, "imageBase64 must be a valid base64 image (data URL or raw base64)");
    }

    // BE6: reject oversized payloads before they are decoded into memory and
    // pushed to ImageKit. base64 ≈ 4/3 × binary bytes (minus padding), so a
    // length check is a cheap upper-bound estimate.
    const payload = typeof imageBase64 === "string" && imageBase64.includes(",")
      ? imageBase64.slice(imageBase64.indexOf(",") + 1)
      : (typeof imageBase64 === "string" ? imageBase64 : "");
    const approxBytes = Math.floor((payload.length * 3) / 4);
    if (approxBytes > PEN_DRAFT_IMAGE_MAX_BYTES) {
      return cValidationError(c, `imageBase64 must decode to at most ${PEN_DRAFT_IMAGE_MAX_BYTES} bytes`);
    }

    const result = await uploadPenDraftImage(userId, sessionId, imageBase64);
    return c.json(result);
  } catch (error) {
    if (error instanceof PenSessionNotFoundError) return cNotFoundError(c, error.message);
    if (error instanceof PenBookOwnershipError) return cApiError(c, error.message, undefined, 403);
    if (error instanceof PenImageUploadError) return cApiError(c, error.message, undefined, 400);
    return cApiError(c, "Failed to upload pen draft image", error);
  }
});

/**
 * GET /api/pen/books/:bookId/notes
 * List all scratchpad notes for an author's book.
 */
router.get("/books/:bookId/notes", requireAuth, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const bookId = c.req.param("bookId");

    const notes = await listPenNotes(userId, bookId);
    return c.json({ notes });
  } catch (error) {
    if (error instanceof PenSessionNotFoundError) return cNotFoundError(c, error.message);
    if (error instanceof PenBookOwnershipError) return cApiError(c, error.message, undefined, 403);
    return cApiError(c, "Failed to list pen notes", error);
  }
});

/**
 * POST /api/pen/books/:bookId/notes
 * Create a new scratchpad note for an author's book.
 * Body: { text: string, annotation?: string }
 */
router.post("/books/:bookId/notes", requireAuth, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const bookId = c.req.param("bookId");
    const body = await readJsonBody(c);

    if (!body || typeof body !== "object") {
      return cValidationError(c, "Request body must be a JSON object");
    }

    const { text, annotation } = body as { text?: unknown; annotation?: unknown };
    if (typeof text !== "string" || text.trim().length === 0) {
      return cValidationError(c, "text must be a non-empty string");
    }

    const note = await createPenNote(userId, bookId, {
      text,
      annotation: typeof annotation === "string" ? annotation : undefined,
    });

    return c.json({ note }, 201);
  } catch (error) {
    if (error instanceof PenSessionNotFoundError) return cNotFoundError(c, error.message);
    if (error instanceof PenBookOwnershipError) return cApiError(c, error.message, undefined, 403);
    return cApiError(c, "Failed to create pen note", error);
  }
});

/**
 * PATCH /api/pen/notes/:id
 * Update an existing scratchpad note.
 * Body: { text?: string, annotation?: string | null }
 */
router.patch("/notes/:id", requireAuth, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const noteId = c.req.param("id");
    const body = await readJsonBody(c);

    if (!body || typeof body !== "object") {
      return cValidationError(c, "Request body must be a JSON object");
    }

    const { text, annotation } = body as { text?: unknown; annotation?: unknown };
    if (text !== undefined && (typeof text !== "string" || text.trim().length === 0)) {
      return cValidationError(c, "text cannot be empty");
    }

    const note = await updatePenNote(userId, noteId, {
      text: typeof text === "string" ? text : undefined,
      annotation: annotation === null ? null : (typeof annotation === "string" ? annotation : undefined),
    });

    return c.json({ note });
  } catch (error) {
    if (error instanceof PenNoteNotFoundError) return cNotFoundError(c, error.message);
    if (error instanceof PenBookOwnershipError) return cApiError(c, error.message, undefined, 403);
    return cApiError(c, "Failed to update pen note", error);
  }
});

/**
 * DELETE /api/pen/notes/:id
 * Delete an existing scratchpad note.
 */
router.delete("/notes/:id", requireAuth, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const noteId = c.req.param("id");

    await deletePenNote(userId, noteId);
    return c.json({ success: true });
  } catch (error) {
    if (error instanceof PenNoteNotFoundError) return cNotFoundError(c, error.message);
    if (error instanceof PenBookOwnershipError) return cApiError(c, error.message, undefined, 403);
    return cApiError(c, "Failed to delete pen note", error);
  }
});

export default router;
