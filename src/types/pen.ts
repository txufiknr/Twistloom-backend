/**
 * Pen (AI Co-Writing) types.
 *
 * Model C (draft-then-finalize): a Pen session owns a private span buffer
 * (`draftBuffer`) over one book. `/finalize` is the only way a draft becomes a
 * published page; `/discard` throws it away for free.
 *
 * @see docs/roadmap/AI_CO_WRITING_PEN_ROADMAP.md
 */

import type { CharacterSceneRole, SceneCharacter, Action } from "./story.js";

/** How the author works with the AI inside a Pen session. Independent of BookMode. */
export type AuthoringMode = "storyteller" | "text_adventure"; // TODO: shouldn't it infer from `PEN_AUTHORING_MODES`?

/**
 * Narrative person the Pen writes in (§1.1 #4, §10 Decision E).
 *
 * No first-person-only restriction: the author may draft in any POV and the
 * Pen continues in that POV. Text adventure is always second-person regardless
 * of this field.
 */
export type AuthoringPov = "first" | "second" | "third";

/**
 * Author's co-writing persona (§6, Phase 6). Injected into the Pen system
 * prompt as a style overlay. `books.coWritingPersona` is the stored shape.
 */
export type CoWritingPersona = {
  name: string;
  description: string;
  /** Appended to the system prompt. */
  styleDirectives: string;
  voice: "neutral" | "lyrical" | "terse" | "cinematic" | "academic";
};

/** Current lifecycle state of a Pen session. */
export type PenSessionStatus = "active" | "paused" | "closed";

/** What produced a draft span. Drives authorship attribution and credit cost. */
export type DraftSpanOrigin = "human" | "ai" | "revised";

/** Validation state of a draft span (delta-validation gate, §6.7). */
export type DraftSpanValidationState = "validated" | "dirty";

/**
 * A single slice of the draft workspace.
 *
 * `validationState` + `validatedAgainst` are the cache keys of the finalize
 * gate: only `dirty` spans (human prose, edited AI text, self-reported issues)
 * and spans whose `validatedAgainst` no longer equals `books.canonVersion`
 * (stale) are re-checked at finalize. Clean AI spans are skipped entirely.
 */
export type DraftSpan = {
  /** Unique key for this span within the draft buffer. */
  id: string;
  /** The span's text content. */
  text: string;
  /** Whether a human, the AI, or a human revision produced this text. */
  origin: DraftSpanOrigin;
  /** Character offset of the span in the final published page text (written at /finalize). */
  charOffsetStart?: number;
  /** Character offset (exclusive) of the span in the final published page text (written at /finalize). */
  charOffsetEnd?: number;
  /** The `pen_edits` row this span rolled up into (written at /finalize). */
  editId?: string;
  /** Validated vs dirty. Human spans start and stay dirty until finalize. */
  validationState: DraftSpanValidationState;
  /** `books.canonVersion` at check time. Stale when it differs from the current value. */
  validatedAgainst?: number;
  /** POV used for this interaction (§10 E). Null → session default applies. */
  authoringPov?: AuthoringPov | null;
};

/**
 * One cast member in the author's scene checklist (`draftCharactersPresent`).
 *
 * The author picks who is physically on scene before /finalize. Refer to a
 * known character by `characterId`, or type a new name (`name`) — new names are
 * slugged into an id and registered into story state as a minimal character at
 * finalize. `"mc"` is the reserved id for the main character (registered into
 * story state on first use). The main character IS included — there is no
 * POV restriction that would exclude them.
 */
export type PenDraftCharacter = {
  /** Known character id from story state, or the reserved `"mc"`. */
  characterId?: string;
  /** Free-text name of a not-yet-known character (page-1 casts, etc.). */
  name?: string;
  /** Role in this scene's dynamics (default `'supporting'`). */
  sceneRole?: CharacterSceneRole;
  /** Narrative focus weight 0..1 (default `0.5`; MC defaults to `1`). */
  sceneFocus?: number;
};

/**
 * Author-curated scene essentials for the NEXT published page
 * (`draftSceneEssentials`). Maps to the `pages` columns that persist a page's
 * setting: `placeId`, `mood`, `weather`, `calendarDate`, `timeOfDay`,
 * `keyEvents`, `keyObjects`. Blank fields are left undefined so `/finalize`
 * falls back to the previous published page's values — the Pen never clears
 * scene context the author didn't explicitly touch.
 */
export type PenDraftSceneEssentials = {
  /** Current place ID where the story is taking place (`pages.place_id`). */
  placeId?: string;
  /** Current emotional atmosphere (`pages.mood`). */
  mood?: string;
  /** Current weather conditions (`pages.weather`). */
  weather?: string;
  /** Current in-world date, e.g. "2026-07-26" (`pages.calendar_date`). */
  calendarDate?: string;
  /** Current time mark, e.g. 'night' or 'HH:mm' (`pages.time_of_day`). */
  timeOfDay?: string;
  /** Key events that occur in the page (`pages.key_events`). */
  keyEvents?: string[];
  /** Important objects in the page (`pages.key_objects`). */
  keyObjects?: string[];
};

/** Edit classification recorded per AI/human interaction inside a session. */
export type PenEditType = "human_wrote" | "ai_continued" | "ai_revised" | "human_revised" | "plan";

// ── Multi-draft workspace (PEN_DRAFT_SHELF_ROADMAP.md) ──────────────────────

/**
 * One in-flight draft slot in the Pen's multi-draft workspace. Standalone and
 * switchable: continue / finalize / discard / autosave all operate on a single
 * row; `pen_sessions.active_draft_id` persists which one the editor shows.
 *
 * `draftId`, NOT `action.text`, is the draft identity — the published page's
 * incoming action is inherited from the parent at finalize, so sibling drafts
 * share it (roadmap D-1).
 */
export type PenDraft = {
  id: string;
  sessionId: string;
  /** Published page being continued from (null → the would-be page 1). */
  parentPageId: string | null;
  /** Editorial, non-unique name shown in the outline draft shelf (D-3). */
  label: string | null;
  /** Author-authored choice text leading into this draft's page (D-4 core). */
  actionText: string | null;
  /** Draft workspace — JSONB spans, NOT plain text (Model C). */
  draftBuffer: DraftSpan[];
  /** Exact TipTap HTML mirror of `draftBuffer` (autosave layer 2). */
  draftHtml?: string | null;
  /** Author-curated cast present in this draft's scene (§10 Decision M). */
  draftCharactersPresent: PenDraftCharacter[];
  /** Author-curated scene essentials for the NEXT page. */
  draftSceneEssentials?: PenDraftSceneEssentials | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Lightweight draft summary for the session payload + outline draft shelf —
 * never carries the full buffer/html.
 */
export type PenDraftSummary = {
  id: string;
  /** Published page being continued from (null → the would-be page 1). */
  parentPageId: string | null;
  /** Editorial label (D-3). */
  label: string | null;
  /** Author-authored choice text leading into this draft's page (D-4 core). */
  actionText: string | null;
  /** Plain-text length of the buffer (for the word-count chip). */
  charCount: number;
  createdAt: Date;
  updatedAt: Date;
};

/** Allowed PATCH fields on a single `pen_drafts` row (autosave heartbeat). */
export type PenDraftUpdates = {
  label?: string;
  actionText?: string;
  draftBuffer?: DraftSpan[];
  draftHtml?: string;
  draftCharactersPresent?: PenDraftCharacter[];
  draftSceneEssentials?: PenDraftSceneEssentials | null;
  /** Client wall-clock (ms epoch, ISO string) of the most recent keystroke — last-write-wins key. */
  draftUpdatedAt?: string;
};

/** Rolled-up authorship of a published page (`pages.authorshipOrigin`). */
export type AuthorshipOrigin = "human" | "ai" | "revised";

/** A Pen session: one active draft workspace per (user, book). */
export type PenSession = {
  id: string;
  userId: string;
  bookId: string;
  authoringMode: AuthoringMode;
  /** Published page the author is continuing from (null until page 1 finalizes). */
  currentPageId: string | null;
  /** Draft workspace — JSONB spans, NOT plain text (Model C). */
  draftBuffer: DraftSpan[];
  /** Exact TipTap HTML mirror of `draftBuffer` (roadmap §18.1 layer 2) — preserves rich formatting across refresh/other devices. Null on pre-layer-2 rows. */
  draftHtml?: string | null;
  /** Author-curated cast for the current draft's scene (§10 Decision M). */
  draftCharactersPresent: PenDraftCharacter[];
  /** Author-curated scene essentials for the next page (setting: place/mood/weather/date/time/keys). */
  draftSceneEssentials?: PenDraftSceneEssentials | null;
  /** 0 (all human) to 1 (all AI) — maps to credit cost tiers. */
  assistanceLevel: number;
  /**
   * Session-level POV default (§10 E). Derived from the author's prose by the
   * editor; overridable per interaction. Text adventure ignores it (always
   * second-person).
   */
  authoringPov?: AuthoringPov | null;
  status: PenSessionStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Audit trail of one AI/human interaction within a session. Source of truth for attribution. */
export type PenEdit = {
  id: string;
  sessionId: string;
  userId: string;
  bookId: string;
  /** Published page this edit contributed to (null until the draft finalizes). */
  pageId: string | null;
  editType: PenEditType;
  /** The author's input (prose fragment or action command) — null for AI-initiated edits. */
  authorInput: string | null;
  /** The AI-generated continuation/revision before any human changes. */
  aiOutput: string | null;
  /** The final text after human editing within the draft. */
  finalText: string | null;
  /** Narrative position: which page this edit conceptually follows. */
  contextPageId: string | null;
  /** Character offsets in the final page text — written at /finalize. */
  charOffsetStart: number | null;
  charOffsetEnd: number | null;
  /** POV used for this interaction (§10 E). Null → session default applies. */
  authoringPov?: AuthoringPov | null;
  authoringMode: AuthoringMode;
  createdAt: Date;
};

/**
 * Author's persisted writing environment (§6.5). Global per user in v1
 * (`users.editorPrefs`); no per-book override column.
 */
export type EditorPrefs = {
  background: "default" | "sepia" | "dark" | "light";
  fontFamily: "serif" | "sans" | "mono";
  fontSize: number; // px, default 17
  textColor: string; // semantic token or hex
  lineHeight: number; // default 1.7
  contentWidth: "narrow" | "medium" | "wide";
};

/** Default editor preferences (must match the schema column default exactly). */
export const DEFAULT_EDITOR_PREFS: EditorPrefs = {
  background: "default",
  fontFamily: "serif",
  fontSize: 17,
  textColor: "default",
  lineHeight: 1.7,
  contentWidth: "medium",
};

/** Story bible entry types (§6.3). */
export type LoreEntryType = "character" | "place" | "item" | "rule" | "timeline_event" | "other";

/** Valid `LoreEntryType` values, used for request validation. */
export const loreEntryTypes: readonly LoreEntryType[] = ["character", "place", "item", "rule", "timeline_event", "other"];

/** Author-curated canonical override entry in the story bible (§6.3, Phase 5). */
export type LoreEntry = {
  id: string;
  bookId: string;
  entryType: LoreEntryType;
  name: string;
  description: string;
  /** Keyword triggers for prompt injection and delta-gate entity matching. */
  triggerKeywords: string[];
  /** Soft refs to engine state rows, if this entry mirrors one. */
  linkedCharacterId?: string | null;
  linkedPlaceId?: string | null;
  /** ImageKit file ID for character avatar. */
  imageId?: string | null;
  /** ImageKit CDN URL for character avatar. */
  imageUrl?: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Create shape for a story-bible entry (POST /books/:bookId/lore). */
export type LoreEntryInput = {
  entryType: LoreEntryType;
  name: string;
  description: string;
  /** Keyword triggers for prompt injection + delta-gate entity matching. */
  triggerKeywords?: string[];
  linkedCharacterId?: string | null;
  linkedPlaceId?: string | null;
  /** ImageKit file ID or base64 data URL for avatar image. */
  imageId?: string | null;
  imageUrl?: string | null;
};

/** Update shape for a story-bible entry (PATCH /lore/:entryId). */
export type LoreEntryUpdate = Partial<LoreEntryInput>;

/** Severity class of a finalize-gate finding — friction, not permission. */
export type FinalizeViolationSeverity = "high" | "medium" | "low";

/** Source of a finalize-gate finding. */
export type FinalizeViolationSource = "lore" | "fact" | "character_memory" | "place_memory";

/** A single canon-conflict finding from the finalize delta gate (§6.7). */
export type FinalizeViolation = {
  severity: FinalizeViolationSeverity;
  source: FinalizeViolationSource;
  /** e.g. "Mara Reyes" */
  entryName: string;
  /** e.g. "eye color" */
  field: string;
  /** lore: "brown eyes" */
  expected: string;
  /** draft: "blue eyes" */
  found: string;
  /** offending sentence from the draft */
  excerpt: string;
  /** proposed fix wording */
  suggestion: string;
  /** For source: 'lore' — the entry that would be amended by a canon change. */
  loreEntryId?: string;
  /** Current entry text at verify time, for the before→after diff in the confirm sheet. */
  currentDescription?: string;
};

/** "Proceed anyway + adopt the change as canon" (§6.7). Processed atomically with the publish. */
export type CanonAmendment = {
  /** Index in the violations array being overridden. */
  violationKey: string;
  action: "update_lore" | "create_lore_entry";
  /** For update_lore — matches FinalizeViolation.loreEntryId. */
  targetEntryId?: string;
  /** The draft's value that becomes canon (from violation.found). */
  newValue: string;
  /** Entry text BEFORE the change — required for the before→after diff (decision H). */
  currentDescription?: string;
  /** Author-confirmed description from the amend preview; used verbatim when present. */
  finalDescription?: string;
};

// ── Outline tree (GET /api/pen/sessions/:bookId/outline) ───────────────────

/** One page node in the outline payload (flat; the frontend builds the hierarchy from `parentId`). */
export type PenOutlinePage = {
  id: string;
  /** 1-based published page number in the section timeline. */
  page: number;
  /** Parent page id — null for a root page. */
  parentId: string | null;
  /** Branch this page belongs to (`branches[].branchId`). */
  branchId: string | null;
  /** Storyboard mood/tone label for this page. */
  mood?: string | null;
  /** Shortened prose preview for the tree node label + peek fallback. */
  textPreview?: string | null;
  /** True when the page exposes outgoing actions. */
  hasActions: boolean;
  /** True when a published page has 0 outgoing actions in a branched book (⚠ flag). */
  isDeadEnd: boolean;
  /**
   * Outgoing actions (with `destinationPageIds`) — powers the tree's action
   * folders and the peek's "leads to current page" highlight + breadcrumbs.
   */
  actions?: Action[];
};

/** A named narrative branch grouping one or more pages. */
export type PenOutlineBranch = {
  branchId: string;
  displayName: string;
};

/** GET /api/pen/sessions/:bookId/outline response. */
export type PenOutlineData = {
  pages: PenOutlinePage[];
  branches: PenOutlineBranch[];
  /**
   * The book's pen session + its in-flight draft slots, when a session exists
   * (the outline draft shelf, roadmap §7). `null` when the author hasn't opened
   * the pen yet — the outline still lists published pages.
   */
  workspace:
    | {
        sessionId: string;
        activeDraftId: string | null;
        drafts: PenDraftSummary[];
      }
    | null;
};

// ── Author page peek (GET /api/pen/pages/:pageId) ──────────────────────────

/**
 * Full author-owned published page for the outline peek popover. Mirrors the
 * stored `pages` row minus per-reader fields (selectedActions, visit stats).
 */
export type PenAuthorPage = {
  id: string;
  bookId: string;
  parentId: string | null;
  branchId: string;
  page: number;
  /** Full published prose. */
  text: string;
  mood?: string | null;
  placeId?: string | null;
  weather?: string;
  calendarDate?: string | null;
  timeOfDay?: string | null;
  /** Scene cast list (author-curated at finalize). */
  charactersPresent: SceneCharacter[];
  keyEvents: string[];
  keyObjects: string[];
  /** Outgoing actions; the peek highlights the one whose `destinationPageIds` includes the current page. */
  actions: Action[];
  /** Rolled-up authorship of this page. */
  authorshipOrigin: AuthorshipOrigin;
  /** 0–100 character-count share of non-AI text. */
  aiContributionPercent: number | null;
  createdAt: Date;
  updatedAt: Date;
};
