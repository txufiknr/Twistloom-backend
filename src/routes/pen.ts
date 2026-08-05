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
import { cApiError, cNotFoundError, cValidationError } from "../utils/error.js";
import {
  createPenSession,
  getPenSessionForBook,
  getPenSessionById,
  updatePenSession,
  closePenSession,
  discardPenDraft,
  PenSessionNotFoundError,
  PenSessionConflictError,
} from "../services/pen.js";
import type { AuthoringMode, PenSessionStatus } from "../types/pen.js";

const router = new Hono<AppEnv>();

const AUTHORING_MODES: readonly AuthoringMode[] = ["storyteller", "text_adventure"];
const SESSION_STATUSES: readonly PenSessionStatus[] = ["active", "paused", "closed"];

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
    const { bookId, authoringMode, assistanceLevel } = body as {
      bookId?: string;
      authoringMode?: AuthoringMode;
      assistanceLevel?: number;
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

    const session = await createPenSession(userId, { bookId, authoringMode, assistanceLevel });
    return c.json({ session });
  } catch (error) {
    if (error instanceof PenSessionConflictError) return cApiError(c, error.message, undefined, 409);
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
    const { assistanceLevel, status, currentPageId } = body as {
      assistanceLevel?: number;
      status?: PenSessionStatus;
      currentPageId?: string | null;
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

    const session = await updatePenSession(userId, sessionId, { assistanceLevel, status, currentPageId });
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
