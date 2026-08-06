/**
 * Pen (AI Co-Writing) Routes — Phase 1.a session lifecycle.
 *
 * Mounted at `/api/pen`. All endpoints require auth and verify book ownership.
 *
 * @see docs/roadmap/AI_CO_WRITING_PEN_ROADMAP.md §1.a
 */

import { Hono } from "hono";
import type { AppEnv } from "../hono/env.js";
import { requireAuth } from "../middleware/nextauth.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { PEN_SUGGEST_RATE_LIMIT } from "../config/ai-rate-limits.js";
import { cApiError, cNotFoundError, cValidationError } from "../utils/error.js";
import {
  createPenSession,
  getPenSessionForBook,
  getPenSessionById,
  updatePenSession,
  closePenSession,
  discardPenDraft,
  continuePenDraft,
  finalizePenDraft,
  DRAFT_CAST_LIMIT,
  PenSessionNotFoundError,
  PenSessionConflictError,
  PenBookOwnershipError,
  PenContinueError,
  PenFinalizeError,
} from "../services/pen.js";
import type { PenContinueInput, PenFinalizeInput } from "../services/pen.js";
import type { AuthoringMode, AuthoringPov, PenDraftCharacter, PenSessionStatus } from "../types/pen.js";
import { characterSceneRoles } from "../types/story.js";
import type { CharacterSceneRole } from "../types/story.js";

const router = new Hono<AppEnv>();

const AUTHORING_MODES: readonly AuthoringMode[] = ["storyteller", "text_adventure"];
const AUTHORING_POVS: readonly AuthoringPov[] = ["first", "second", "third"];
const SESSION_STATUSES: readonly PenSessionStatus[] = ["active", "paused", "closed"];

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
  if (m.sceneFocus !== undefined && (typeof m.sceneFocus !== "number" || m.sceneFocus < 0 || m.sceneFocus > 1)) {
    return "sceneFocus must be a number between 0 and 1";
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
    const body = await c.req.json();

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
    if (!authoringMode || !AUTHORING_MODES.includes(authoringMode)) {
      return cValidationError(c, `authoringMode must be one of: ${AUTHORING_MODES.join(", ")}`);
    }
    if (assistanceLevel !== undefined && (typeof assistanceLevel !== "number" || assistanceLevel < 0 || assistanceLevel > 1)) {
      return cValidationError(c, "assistanceLevel must be a number between 0 and 1");
    }
    if (authoringPov !== undefined && authoringPov !== null && !AUTHORING_POVS.includes(authoringPov)) {
      return cValidationError(c, `authoringPov must be one of: ${AUTHORING_POVS.join(", ")} or null`);
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
 * PATCH /api/pen/sessions/:id
 * Update assistanceLevel, status, or currentPageId on a session the user owns.
 */
router.patch("/sessions/:id", requireAuth, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const sessionId = c.req.param("id");
    const body = await c.req.json();

    if (!body || typeof body !== "object") {
      return cValidationError(c, "Request body must be a JSON object");
    }
    const { assistanceLevel, status, currentPageId, authoringPov, draftCharactersPresent } = body as {
      assistanceLevel?: number;
      status?: PenSessionStatus;
      currentPageId?: string | null;
      authoringPov?: AuthoringPov | null;
      draftCharactersPresent?: PenDraftCharacter[];
    };

    if (assistanceLevel !== undefined && (typeof assistanceLevel !== "number" || assistanceLevel < 0 || assistanceLevel > 1)) {
      return cValidationError(c, "assistanceLevel must be a number between 0 and 1");
    }
    if (status !== undefined && !SESSION_STATUSES.includes(status)) {
      return cValidationError(c, `status must be one of: ${SESSION_STATUSES.join(", ")}`);
    }
    if (currentPageId !== undefined && currentPageId !== null && typeof currentPageId !== "string") {
      return cValidationError(c, "currentPageId must be a string or null");
    }
    if (authoringPov !== undefined && authoringPov !== null && !AUTHORING_POVS.includes(authoringPov)) {
      return cValidationError(c, `authoringPov must be one of: ${AUTHORING_POVS.join(", ")} or null`);
    }
    if (draftCharactersPresent !== undefined) {
      if (!Array.isArray(draftCharactersPresent) || draftCharactersPresent.length > DRAFT_CAST_LIMIT) {
        return cValidationError(c, `draftCharactersPresent must be an array of at most ${DRAFT_CAST_LIMIT} cast members`);
      }
      for (const member of draftCharactersPresent) {
        const memberError = validateDraftCastMember(member);
        if (memberError) return cValidationError(c, memberError);
      }
    }

    const session = await updatePenSession(userId, sessionId, { assistanceLevel, status, currentPageId, authoringPov, draftCharactersPresent });
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
 *   storyteller   -> { type: 'storyteller', prose, directionHint? }
 *   text_adventure-> { type: 'text_adventure', command }
 * Returns { span, edit, draft } where span is validated/dirty.
 */
router.post("/sessions/:id/continue", requireAuth, rateLimit(PEN_SUGGEST_RATE_LIMIT), async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const sessionId = c.req.param("id");
    const body = await c.req.json();

    if (!body || typeof body !== "object") {
      return cValidationError(c, "Request body must be a JSON object");
    }

    let input: PenContinueInput;
    const raw = body as Record<string, unknown>;

    const authoringPov = raw.authoringPov as AuthoringPov | null | undefined;
    if (authoringPov !== undefined && authoringPov !== null && !AUTHORING_POVS.includes(authoringPov)) {
      return cValidationError(c, `authoringPov must be one of: ${AUTHORING_POVS.join(", ")} or null`);
    }

    if (raw.type === "text_adventure") {
      if (typeof raw.command !== "string" || raw.command.trim().length === 0) {
        return cValidationError(c, "command is required for text_adventure");
      }
      input = { type: "text_adventure", command: raw.command, authoringPov: authoringPov ?? undefined };
    } else if (raw.type === "storyteller") {
      if (typeof raw.prose !== "string" || raw.prose.trim().length === 0) {
        return cValidationError(c, "prose is required for storyteller");
      }
      input = {
        type: "storyteller",
        prose: raw.prose,
        directionHint: typeof raw.directionHint === "string" ? raw.directionHint : undefined,
        authoringPov: authoringPov ?? undefined,
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
    if (body.actions !== undefined && (!Array.isArray(body.actions) || body.actions.length > 6)) {
      return cValidationError(c, "actions must be an array of at most 6 items");
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
 * GET /api/pen/sessions/:id
 * Return a single session by id (ownership verified).
 */
router.get("/sessions/:id", requireAuth, async (c) => {
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
