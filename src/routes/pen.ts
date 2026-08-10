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
import { rateLimit } from "../middleware/rate-limit.js";
import { PEN_CONTINUE_RATE_LIMIT, PEN_ESSENTIALS_RATE_LIMIT } from "../config/ai-rate-limits.js";
import { cApiError, cNotFoundError, cValidationError } from "../utils/error.js";
import { PEN_ASSISTANCE_LEVEL_MAX, PEN_ASSISTANCE_LEVEL_MIN, PEN_AUTHORING_MODES, PEN_AUTHORING_POVS, PEN_DRAFT_CAST_LIMIT, PEN_FINALIZE_MAX_ACTIONS, PEN_SCENE_FOCUS_MAX, PEN_SCENE_FOCUS_MIN, PEN_SESSION_STATUSES } from "../config/story.js";
import {
  createPenSession,
  getPenSessionForBook,
  getPenSessionById,
  updatePenSession,
  closePenSession,
  discardPenDraft,
  continuePenDraft,
  finalizePenDraft,
  autofillSceneEssentials,
  getPenSessionState,
  getPenOutline,
  getPenAuthorPage,
  PenSessionNotFoundError,
  PenSessionConflictError,
  PenBookOwnershipError,
  PenContinueError,
  PenFinalizeError,
  PenEssentialsAutofillError,
} from "../services/pen.js";
import type { PenContinueInput, PenFinalizeInput, PenEssentialsAutofillInput } from "../services/pen.js";
import type { AuthoringMode, AuthoringPov, PenDraftCharacter, PenDraftSceneEssentials, PenSessionStatus } from "../types/pen.js";
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
 * PATCH /api/pen/sessions/:id
 * Update assistanceLevel, status, or currentPageId on a session the user owns.
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
    const { assistanceLevel, status, currentPageId, authoringPov, draftCharactersPresent, draftSceneEssentials } = body as {
      assistanceLevel?: number;
      status?: PenSessionStatus;
      currentPageId?: string | null;
      authoringPov?: AuthoringPov | null;
      draftCharactersPresent?: PenDraftCharacter[];
      draftSceneEssentials?: PenDraftSceneEssentials | null;
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

    const session = await updatePenSession(userId, sessionId, { assistanceLevel, status, currentPageId, authoringPov, draftCharactersPresent, draftSceneEssentials });
    return c.json({ session });
  } catch (error) {
    if (error instanceof PenSessionNotFoundError) return cNotFoundError(c, error.message);
    return cApiError(c, "Failed to update pen session", error);
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
 * Clear the draft buffer (zero cost). The session itself is preserved.
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
router.post("/sessions/:id/continue", requireAuth, rateLimit(PEN_CONTINUE_RATE_LIMIT), async (c) => {
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

    const result = await continuePenDraft(userId, sessionId, input);
    return c.json(result);
  } catch (error) {
    if (error instanceof PenSessionNotFoundError) return cNotFoundError(c, error.message);
    if (error instanceof PenBookOwnershipError) return cApiError(c, error.message, undefined, 403);
    if (error instanceof PenContinueError) return cApiError(c, error.message, undefined, 422);
    return cApiError(c, "Failed to continue pen draft", error);
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
router.post("/sessions/:id/essentials/autofill", requireAuth, rateLimit(PEN_ESSENTIALS_RATE_LIMIT), async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const sessionId = c.req.param("id");
    const body = await readJsonBody(c);

    const input: PenEssentialsAutofillInput = {};
    const raw = body as { draftText?: unknown; mode?: unknown } | null | undefined;
    if (raw && typeof raw.draftText === "string") {
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
 * POST /api/pen/sessions/:id/finalize
 * Publish the session's draft as the next story page (Phase 1.c).
 *
 * Phase A runs the advisory delta gate over dirty/stale spans only (§6.7). If
 * the gate found high-severity findings and `force` was not passed, it returns
 * `{ status: 'needs_review', violations }` with nothing written. With `force`
 * (or a clean/author-consistent draft) it publishes via `persistPageWithState`
 * / `insertStoryPage`, rolls the draft up into `penEdits` spans with character
 * offsets, and clears the draft.
 * Body: { force?, amendments?, actions? } — `actions` supplies author-defined
 * next choices for interactive/multiverse; novel always uses the single default.
 */
router.post("/sessions/:id/finalize", requireAuth, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const sessionId = c.req.param("id");
    let body: PenFinalizeInput = {};
    try {
      const raw = await c.req.json();
      if (raw && typeof raw === "object") body = raw as PenFinalizeInput;
    } catch {
      // No body or non-JSON body → default to an empty finalize (publish clean).
    }

    if (body.force !== undefined && typeof body.force !== "boolean") {
      return cValidationError(c, "force must be a boolean");
    }
    if (body.actions !== undefined && (!Array.isArray(body.actions) || body.actions.length > PEN_FINALIZE_MAX_ACTIONS)) {
      return cValidationError(c, `actions must be an array of at most ${PEN_FINALIZE_MAX_ACTIONS} items`);
    }

    const result = await finalizePenDraft(userId, sessionId, body);
    return c.json(result);
  } catch (error) {
    if (error instanceof PenSessionNotFoundError) return cNotFoundError(c, error.message);
    if (error instanceof PenBookOwnershipError) return cApiError(c, error.message, undefined, 403);
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

export default router;
