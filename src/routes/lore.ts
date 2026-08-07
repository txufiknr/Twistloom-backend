/**
 * Story-Bible (Lore) Routes — Phase 5 CRUD (§6.3).
 *
 * Mounted at `/api/pen`. All endpoints require auth and verify book ownership
 * (lore entries are private to the author — nothing in the bible is exposed to
 * readers until the prompt-injection path consumes it server-side).
 *
 * @see docs/roadmap/AI_CO_WRITING_PEN_ROADMAP.md §6.3, Phase 5
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../hono/env.js";
import { requireAuth } from "../middleware/nextauth.js";
import { cApiError, cNotFoundError, cValidationError } from "../utils/error.js";
import { isValidUuid } from "../utils/uuid.js";
import { PEN_LORE_DESCRIPTION_MAX_LENGTH, PEN_LORE_MAX_TRIGGERS, PEN_TITLE_MAX_LENGTH, PEN_TITLE_MIN_LENGTH } from "../config/story.js";
import {
  listLoreEntries,
  createLoreEntry,
  updateLoreEntry,
  deleteLoreEntry,
  LoreEntryNotFoundError,
  LoreBookOwnershipError,
} from "../services/lore.js";
import type { LoreEntryInput, LoreEntryUpdate, LoreEntryType } from "../types/pen.js";
import { loreEntryTypes } from "../types/pen.js";

const router = new Hono<AppEnv>();

/** Parses a JSON body, returning `null` on missing/malformed input. */
async function readJsonBody(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/** Validates the shared lore fields; returns an error string or null. */
function validateLoreFields(fields: Partial<LoreEntryInput>): string | null {
  if (fields.entryType !== undefined && !loreEntryTypes.includes(fields.entryType)) {
    return `entryType must be one of: ${loreEntryTypes.join(", ")}`;
  }
  if (fields.name !== undefined) {
    if (typeof fields.name !== "string" || fields.name.trim().length < PEN_TITLE_MIN_LENGTH || fields.name.trim().length > PEN_TITLE_MAX_LENGTH) {
      return `name must be a string between ${PEN_TITLE_MIN_LENGTH} and ${PEN_TITLE_MAX_LENGTH} characters`;
    }
  }
  if (fields.description !== undefined) {
    if (typeof fields.description !== "string" || fields.description.trim().length === 0 || fields.description.length > PEN_LORE_DESCRIPTION_MAX_LENGTH) {
      return `description must be a non-empty string of at most ${PEN_LORE_DESCRIPTION_MAX_LENGTH} characters`;
    }
  }
  if (fields.triggerKeywords !== undefined) {
    if (!Array.isArray(fields.triggerKeywords) || fields.triggerKeywords.length > PEN_LORE_MAX_TRIGGERS) {
      return `triggerKeywords must be an array of at most ${PEN_LORE_MAX_TRIGGERS} keywords`;
    }
    for (const kw of fields.triggerKeywords) {
      if (typeof kw !== "string" || kw.trim().length === 0) {
        return "each triggerKeyword must be a non-empty string";
      }
    }
  }
  if (fields.linkedCharacterId !== undefined && fields.linkedCharacterId !== null && !isValidUuid(fields.linkedCharacterId)) {
    return "linkedCharacterId must be a valid UUID or null";
  }
  if (fields.linkedPlaceId !== undefined && fields.linkedPlaceId !== null && !isValidUuid(fields.linkedPlaceId)) {
    return "linkedPlaceId must be a valid UUID or null";
  }
  return null;
}

/**
 * GET /api/pen/books/:bookId/lore
 * List all story-bible entries for a book the user owns.
 */
router.get("/books/:bookId/lore", requireAuth, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const bookId = c.req.param("bookId");

    const entries = await listLoreEntries(userId, bookId);
    return c.json({ entries });
  } catch (error) {
    if (error instanceof LoreBookOwnershipError) return cApiError(c, error.message, undefined, 403);
    return cApiError(c, "Failed to load lore entries", error);
  }
});

/**
 * POST /api/pen/books/:bookId/lore
 * Create a story-bible entry (bumps `books.canonVersion`).
 * Body: { entryType, name, description, triggerKeywords?, linkedCharacterId?, linkedPlaceId? }
 */
router.post("/books/:bookId/lore", requireAuth, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const bookId = c.req.param("bookId");
    const body = await readJsonBody(c);

    if (!body || typeof body !== "object") {
      return cValidationError(c, "Request body must be a JSON object");
    }
    const input = body as Partial<LoreEntryInput>;
    if (input.entryType === undefined || input.name === undefined || input.description === undefined) {
      return cValidationError(c, "entryType, name, and description are required");
    }
    const fieldError = validateLoreFields(input as LoreEntryInput);
    if (fieldError) return cValidationError(c, fieldError);

    const entry = await createLoreEntry(userId, bookId, input as LoreEntryInput & { entryType: LoreEntryType });
    return c.json({ entry });
  } catch (error) {
    if (error instanceof LoreBookOwnershipError) return cApiError(c, error.message, undefined, 403);
    return cApiError(c, "Failed to create lore entry", error);
  }
});

/**
 * PATCH /api/pen/lore/:entryId
 * Update a story-bible entry the user owns (bumps `books.canonVersion`).
 */
router.patch("/lore/:entryId", requireAuth, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const entryId = c.req.param("entryId");
    const body = await readJsonBody(c);

    if (!body || typeof body !== "object") {
      return cValidationError(c, "Request body must be a JSON object");
    }
    const update = body as LoreEntryUpdate;
    const fieldError = validateLoreFields(update);
    if (fieldError) return cValidationError(c, fieldError);

    const entry = await updateLoreEntry(userId, entryId, update);
    return c.json({ entry });
  } catch (error) {
    if (error instanceof LoreEntryNotFoundError) return cNotFoundError(c, error.message);
    return cApiError(c, "Failed to update lore entry", error);
  }
});

/**
 * DELETE /api/pen/lore/:entryId
 * Delete a story-bible entry the user owns (bumps `books.canonVersion`).
 */
router.delete("/lore/:entryId", requireAuth, async (c) => {
  try {
    const userId = c.get("userId");
    if (!userId) return cApiError(c, "Authentication required", undefined, 401);
    const entryId = c.req.param("entryId");

    await deleteLoreEntry(userId, entryId);
    return c.json({ ok: true });
  } catch (error) {
    if (error instanceof LoreEntryNotFoundError) return cNotFoundError(c, error.message);
    return cApiError(c, "Failed to delete lore entry", error);
  }
});

export default router;
