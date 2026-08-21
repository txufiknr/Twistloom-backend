/**
 * @overview Book Preview Service (Pen Live Preview — `?preview=1`)
 *
 * Implements the backend half of the Pen Live Preview feature (roadmap
 * `PEN_LIVE_PREVIEW_ROADMAP.md`, Phase 0). It synthesizes a stable, owner-only
 * "reader-shaped" page payload for an in-progress Pen draft book so the author
 * can open the full `ReaderPageClient` reading experience against their draft
 * in a new tab — without polluting reader sessions, caches, or credits.
 *
 * Behaviour (per the roadmap):
 * - **Owner-gated:** the session user must own the book; everyone else (and
 *   anonymous callers) gets a 404 so a private pen book never leaks.
 * - **Three bucket resolution** for `pageId`:
 *     1. A published page id → real page, optionally with the active draft's
 *        outgoing choice stitched onto it (so the author can "choose" into the
 *        draft).
 *     2. A draft id (`pen_drafts`) → a synthesized `Page` at the end of the path.
 *     3. Anything else → 404.
 * - **Stable payload:** no `visitDetails`, no `selectedActions`, no
 *   `originalActionsCount`, no `shownActionHint`; no credits, no `actioning`,
 *   no session/visit side effects. The route layer additionally forces
 *   `skipVisit` and sets `Cache-Control: no-store`.
 *
 * @see docs/roadmap/PEN_LIVE_PREVIEW_ROADMAP.md §5.3 (backend contract)
 */

import { eq, and } from "drizzle-orm";
import { dbRead } from "../db/client.js";
import { penDrafts } from "../db/schema.js";
import { getEnrichedBook, getPageFromDB, mapToEnrichedPage } from "./book.js";
import { getPenSessionForBook } from "./pen.js";
import type { PenSessionPayload } from "./pen.js";
import { htmlToPlainText } from "../utils/text-processing.js";
import type { Action, ActionHint, ActionType, EnrichedStoryPage, EnrichedStoryPageContext, SelectedAction, StoryPage } from "../types/story.js";
import type { EnrichedBookData } from "../types/book.js";
import type { DBPage, DBPenDraft } from "../types/schema.js";
import type { PenDraftSummary } from "../types/pen.js";

/** Shared empty-action hint used for stitched / synthesized preview actions. */
const EMPTY_HINT: ActionHint = { text: "", type: "none" };

/** The action-type used for preview-stitched / draft-terminal actions.
 *  `actionTypes` has no `'continue'` key, so we fall back to `'other'`. */
const PREVIEW_ACTION_TYPE: ActionType = "other";

/**
 * Loads a single `pen_drafts` row by id, scoped to the book the user owns.
 *
 * @param userId - The authenticated owner (ownership guard)
 * @param bookId - Book the draft belongs to
 * @param draftId - Draft row id to load
 * @returns The draft row (with full buffer/html/essentials) or null
 */
async function loadDraftRow(
  userId: string,
  bookId: string,
  draftId: string,
): Promise<DBPenDraft | null> {
  const session = await getPenSessionForBook(userId, bookId);
  if (!session) return null;

  const [row] = await dbRead
    .select()
    .from(penDrafts)
    .where(and(eq(penDrafts.id, draftId), eq(penDrafts.sessionId, session.id)))
    .limit(1);

  return row ?? null;
}

/**
 * Picks the draft (if any) to stitch onto a published page: a non-ending draft
 * whose `parentPageId` equals the page being previewed, preferring the active
 * draft slot. Returns null when no such draft exists.
 */
function findStitchDraft(
  session: PenSessionPayload,
  pageId: string,
): PenDraftSummary | null {
  const candidates = session.drafts.filter(
    (d) => d.parentPageId === pageId && !d.isEnding,
  );
  if (candidates.length === 0) return null;
  return candidates.find((d) => d.id === session.activeDraftId) ?? candidates[0];
}

/**
 * Builds the synthetic outgoing action for a stitched/terminal draft.
 */
function buildDraftAction(text: string | null, nextPageId: string | null): Action {
  return {
    text: text?.trim() || "Continue",
    type: PREVIEW_ACTION_TYPE,
    hint: EMPTY_HINT,
    // `nextPageId` is the draft id for a stitched published page, or empty for a
    // terminal synthesized draft page (the reader already renders dead-ends).
    destinationPageIds: nextPageId ? [nextPageId] : [],
    source: "ai",
  };
}

/**
 * Extracts plain-text prose from a draft row (TipTap HTML mirror, else spans).
 */
function draftPlainText(draft: DBPenDraft): string {
  if (draft.draftHtml) return htmlToPlainText(draft.draftHtml);
  return (draft.draftBuffer ?? [])
    .map((span) => (span as { text?: string }).text || "")
    .join("")
    .trim();
}

/**
 * Resolves a Pen preview payload for a published page — bucket 1.
 *
 * Fetches the real page, then (if an active non-ending draft is anchored at it)
 * appends a synthesized outgoing action carrying the draft id as its
 * destination, so the author can "choose" into their in-progress page. The
 * page is mapped through the normal enrichment path (with `userId` omitted so
 * no reader-side `selectedActions`/hints/custom-actions leak), then the
 * preview-stability fields are zeroed.
 */
async function resolvePublishedPreview(params: {
  userId: string;
  dbPage: DBPage;
  book: EnrichedBookData;
  headerLanguage?: string | null;
  translate: boolean;
}): Promise<EnrichedStoryPage> {
  const { userId, dbPage, book, headerLanguage, translate } = params;

  const enriched = await mapToEnrichedPage(dbPage, {
    userId: undefined,
    book,
    headerLanguage,
    translate,
    sourceAction: undefined,
    isUserTakeAction: false,
  });

  if (!enriched) {
    throw new Error("Failed to enrich preview page");
  }

  // Stitch the active draft's outgoing choice onto the page (if any).
  const session = await getPenSessionForBook(userId, book.id);
  const stitch = session ? findStitchDraft(session, dbPage.id) : null;
  if (stitch) {
    enriched.actions = [
      ...(enriched.actions ?? []),
      buildDraftAction(stitch.actionText, stitch.id),
    ];
  }

  // Preview-stability: strip reader-side personalization + disable polling.
  enriched.selectedActions = [];
  enriched.originalActionsCount = 0;
  enriched.shownActionHint = [];

  return enriched;
}

/**
 * Resolves a Pen preview payload for a draft row — bucket 2.
 *
 * Synthesizes an `EnrichedStoryPage` at the end of the current path:
 * - `page` = parent's page number + 1 (or 1 for a root draft).
 * - `text` = the draft's plain-text prose.
 * - `actions` = the draft's choice text leading onward, with an empty
 *   destination (terminal) unless the draft is an ending (no actions).
 * - `context` = the parent page's enriched context (story-so-far world state)
 *   with `actionsHistory` extended by this draft's hop, so scroll-mode's
 *   ancestor chain + `chosenActionTexts` render correctly.
 */
async function resolveDraftPreview(params: {
  userId: string;
  draft: DBPenDraft;
  book: EnrichedBookData;
  headerLanguage?: string | null;
  translate: boolean;
}): Promise<EnrichedStoryPage> {
  const { draft, book } = params;

  const parentDbPage = draft.parentPageId
    ? await getPageFromDB(draft.parentPageId)
    : null;

  const parentEnriched = parentDbPage
    ? await mapToEnrichedPage(parentDbPage, {
        userId: undefined,
        book,
        headerLanguage: params.headerLanguage,
        translate: params.translate,
        sourceAction: undefined,
        isUserTakeAction: false,
      })
    : null;

  const pageNumber = parentDbPage ? parentDbPage.page + 1 : 1;
  const branchId = parentDbPage?.branchId ?? "main";
  const text = draftPlainText(draft);
  const scene = draft.draftSceneEssentials;

  const actions: Action[] = draft.isEnding
    ? []
    : [buildDraftAction(draft.actionText ?? draft.label, null)];

  // Extend the parent's ancestor chain with this draft's hop (scroll mode).
  let context: EnrichedStoryPageContext | undefined;
  if (parentEnriched?.context && parentDbPage) {
    const hop: SelectedAction = {
      text: draft.actionText ?? draft.label ?? "Continue",
      type: PREVIEW_ACTION_TYPE,
      hint: EMPTY_HINT,
      source: "ai",
      pageId: parentDbPage.id,
      page: parentDbPage.page,
      nextPageId: draft.id,
    };
    context = {
      ...parentEnriched.context,
      actionsHistory: [...parentEnriched.context.actionsHistory, hop],
      maxPage: parentEnriched.context.maxPage,
    };
  }

  const page: EnrichedStoryPage = {
    id: draft.id,
    bookId: book.id,
    parentId: draft.parentPageId ?? null,
    branchId,
    page: pageNumber,
    text,
    actions,
    mood: scene?.mood as StoryPage["mood"],
    placeId: scene?.placeId,
    weather: scene?.weather as StoryPage["weather"],
    calendarDate: scene?.calendarDate,
    timeOfDay: scene?.timeOfDay,
    charactersPresent: (draft.draftCharactersPresent ?? []) as StoryPage["charactersPresent"],
    keyEvents: scene?.keyEvents ?? [],
    keyObjects: scene?.keyObjects ?? [],
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    // Preview-stability fields (no polling, no personalization).
    originalActionsCount: 0,
    selectedActions: [],
    shownActionHint: [],
    branchName: parentEnriched?.branchName,
    context,
    translation: undefined,
    communityActions: undefined,
  };

  return page;
}

/**
 * Entry point for the `?preview=1` page mode.
 *
 * @param userId - Authenticated owner of the pen book
 * @param bookIdentifier - Book slug or UUID v7
 * @param pageId - Published page id OR draft id
 * @param options.translate - Whether to translate the published page
 * @param options.headerLanguage - Accept-Language header value
 * @returns The preview `{ page, book }` payload, or `null` when the book is not
 *   found, not owned by the caller, or `pageId` resolves to neither a published
 *   page nor a draft. Callers should map `null` → 404 (do not leak existence).
 */
export async function getPreviewBookPage(params: {
  userId: string;
  bookIdentifier: string;
  pageId: string;
  translate?: boolean;
  headerLanguage?: string | null;
}): Promise<{ page: EnrichedStoryPage; book: EnrichedBookData } | null> {
  const { userId, bookIdentifier, pageId, translate = false, headerLanguage } = params;

  // Resolve + ownership-gate the book. `getEnrichedBook` returns null for
  // missing books and (because the row exists) for any book — we then verify
  // ownership and 404 otherwise so a private pen book never leaks.
  const book = await getEnrichedBook(bookIdentifier, userId);
  if (!book || book.userId !== userId) return null;

  // Bucket 1 — published page.
  const dbPage = await getPageFromDB(pageId, { bookIdentifier });
  if (dbPage) {
    const page = await resolvePublishedPreview({
      userId,
      dbPage,
      book,
      headerLanguage,
      translate,
    });
    return { page, book };
  }

  // Bucket 2 — draft id.
  const draft = await loadDraftRow(userId, book.id, pageId);
  if (draft) {
    const page = await resolveDraftPreview({
      userId,
      draft,
      book,
      headerLanguage,
      translate,
    });
    return { page, book };
  }

  // Bucket 3 — neither.
  return null;
}
