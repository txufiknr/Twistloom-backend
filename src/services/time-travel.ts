/**
 * Story Time Travel — fork discovery and branch reconstruction for the
 * reader-facing Journey / "Take This Path" feature.
 *
 * The whole feature is a read-and-shape operation over existing data:
 * - `storyStates` carries a **complete `StoryState` snapshot per page** (PK `pageId`),
 *   so no delta-replay engine is needed.
 * - `pages.actions[].destinationPageIds` tells us which alternatives at a fork
 *   already have a generated continuation.
 * - `user_sessions` resolves the reader's current frontier page.
 *
 * Fork discovery is pure preview: no writes, no AI, no credits.
 * Phase 2 (commit) reuses the existing actioning flow and is charged via the
 * `TIME_TRAVEL_COMMIT` credit key.
 */

import { dbRead } from "../db/client.js";
import { pages, userSessions, actionProgress, userPageProgress } from "../db/schema.js";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { StoryState } from "../types/story.js";
import type { CharacterStatus } from "../types/character.js";
import { getStoryState } from "./story.js";
import { aiPrompt } from "../utils/ai-chat.js";
import { AI_CHAT_MODELS_WRITING } from "../config/ai-clients.js";
import { AI_CHAT_CONFIG_DEFAULT } from "../config/ai-chat.js";

/** A set-membership change between the reader's path and an alternative. */
export type TimeTravelSetChange = "added" | "removed";

/**
 * A semantic story-state difference returned to the web client.
 *
 * The backend owns comparison semantics while the frontend owns localization
 * and presentation. Raw story values therefore remain structured and this
 * wire type intentionally contains no reader-facing prose.
 */
export type TimeTravelDiff =
  | {
      type: "characterStatus";
      characterId: string;
      name: string | null;
      before: CharacterStatus;
      after: CharacterStatus;
    }
  | {
      type: "plotFlag";
      change: TimeTravelSetChange;
      value: string;
    }
  | {
      type: "inventory";
      change: TimeTravelSetChange;
      value: string;
    }
  | {
      type: "composure";
      before: { value: number; max: number };
      after: { value: number; max: number };
    }
  | {
      type: "injury";
      change: TimeTravelSetChange;
      value: string;
    };

export type TimeTravelAlternative = {
  /** Action text of the alternative choice. */
  text: string;
  /** First generated page of this alternative's branch (null if not generated). */
  nextPageId: string | null;
  /** Whether a generated continuation exists for this alternative. */
  hasGeneratedPath: boolean;
  /** Branch the alternative belongs to (null if not generated). */
  branchId: string | null;
  /** Number of pages in the alternative's branch (0 if not generated). */
  generatedPageCount: number;
  /** True when a continuation is currently being generated (status `started`). */
  isGenerating: boolean;
};

/** A fork on the reader's active journey and the outcome of their chosen road. */
export type JourneyForkSummary = {
  /** Page number where the reader made the choice. */
  forkPage: number;
  /** Page id where the reader made the choice. */
  forkPageId: string;
  /** The action text the reader actually chose there. */
  chosenActionText: string;
  /** Exact first page reached by the chosen action. */
  chosenNextPageId: string | null;
  /** Page number reached by the chosen action, when still available. */
  outcomePage: number | null;
  /** Whether the chosen destination is a major narrative event. */
  outcomeIsMajorEvent: boolean;
  /** Roads that were available but not chosen. */
  alternatives: TimeTravelAlternative[];
};

/** Fork-focused read model consumed by the Journey timeline. */
export type GetJourneyForksResponse = {
  forks: JourneyForkSummary[];
};

export type ReconstructAlternative = TimeTravelAlternative & {
  /** Diff between the reader's branch and this alternative at equal depth (first page after the fork). */
  diffs: TimeTravelDiff[];
};

export type ReconstructForkResponse = {
  /** The action text the reader actually chose at this fork (null if unresolved). */
  takenAction: string | null;
  /** The reader's current frontier page id used for the diff. */
  readerPageId: string | null;
  alternatives: ReconstructAlternative[];
};

type ActionLike = { text: string; destinationPageIds?: string[] };

type JourneyHistoryEntry = {
  pageId: string;
  page: number;
  text: string;
  nextPageId?: string | null;
};

/**
 * Set of action texts on a page whose continuation is currently being
 * generated (status `started` in `actionProgress`). Used to surface a
 * "generating…" state instead of a flat "unknown possibility" tile.
 */
async function getGeneratingActions(pageId: string): Promise<Set<string>> {
  const rows = await dbRead
    .select({ actionText: actionProgress.actionText })
    .from(actionProgress)
    .where(and(eq(actionProgress.pageId, pageId), eq(actionProgress.status, "started")));
  return new Set(rows.map((r) => r.actionText));
}

/**
 * Batched variant: returns a map of pageId -> set of in-flight action texts for
 * all supplied fork pages in a single query (avoids N+1 in `getJourneyForks`).
 */
async function getGeneratingActionsBatch(
  pageIds: string[],
): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  if (pageIds.length === 0) return map;
  const rows = await dbRead
    .select({ pageId: actionProgress.pageId, actionText: actionProgress.actionText })
    .from(actionProgress)
    .where(and(eq(actionProgress.status, "started"), inArray(actionProgress.pageId, pageIds)));
  for (const r of rows) {
    if (!map.has(r.pageId)) map.set(r.pageId, new Set());
    map.get(r.pageId)!.add(r.actionText);
  }
  return map;
}

/**
 * Resolve the reader's current frontier page id.
 * Authed readers use their active session; guests must supply `pageId`.
 */
export async function resolveCurrentPageId(
  bookId: string,
  userId: string | null | undefined,
  suppliedPageId: string | null | undefined,
): Promise<string | null> {
  if (suppliedPageId) return suppliedPageId;
  if (!userId) return null;
  const [session] = await dbRead
    .select({ frontierPageId: userSessions.frontierPageId, pageId: userSessions.pageId })
    .from(userSessions)
    .where(and(eq(userSessions.userId, userId), eq(userSessions.bookId, bookId)))
    .limit(1);
  return session?.frontierPageId ?? session?.pageId ?? null;
}

/**
 * Shape an authoritative action history into the compact fork-only Journey
 * read model. All database work is batched by relation type.
 */
async function buildJourneyForks(
  bookId: string,
  history: JourneyHistoryEntry[],
): Promise<GetJourneyForksResponse> {
  if (history.length === 0) return { forks: [] };

  // Source and chosen-destination pages share one lookup. Identity remains
  // page-id based even when different branches reuse a numeric page position.
  const pageIds = [...new Set(history.flatMap((entry) => [
    entry.pageId,
    ...(entry.nextPageId ? [entry.nextPageId] : []),
  ]))];
  const pageRows = await dbRead
    .select({
      id: pages.id,
      page: pages.page,
      actions: pages.actions,
      stateDelta: pages.stateDelta,
    })
    .from(pages)
    .where(and(eq(pages.bookId, bookId), inArray(pages.id, pageIds)));
  const pageMap = new Map(pageRows.map((row) => [row.id, row]));

  const forkHistory = history.filter((entry) => {
    const actions = (pageMap.get(entry.pageId)?.actions ?? []) as ActionLike[];
    return actions.length > 1;
  });
  if (forkHistory.length === 0) return { forks: [] };

  const alternativeNextPageIds = [...new Set(forkHistory.flatMap((entry) => {
    const actions = (pageMap.get(entry.pageId)?.actions ?? []) as ActionLike[];
    return actions.flatMap((action) => (
      action.text !== entry.text && action.destinationPageIds?.[0]
        ? [action.destinationPageIds[0]]
        : []
    ));
  }))];
  const branchRows = alternativeNextPageIds.length > 0
    ? await dbRead
        .select({ id: pages.id, branchId: pages.branchId })
        .from(pages)
        .where(and(eq(pages.bookId, bookId), inArray(pages.id, alternativeNextPageIds)))
    : [];
  const branchMap = new Map(branchRows.map((row) => [row.id, row.branchId] as const));
  const branchIds = [...new Set(branchRows.map((row) => row.branchId).filter(Boolean))] as string[];
  const countRows = branchIds.length > 0
    ? await dbRead
        .select({ branchId: pages.branchId, count: sql<number>`count(*)::int` })
        .from(pages)
        .where(and(eq(pages.bookId, bookId), inArray(pages.branchId, branchIds)))
        .groupBy(pages.branchId)
    : [];
  const countMap = new Map(countRows.map((row) => [row.branchId, row.count] as const));
  const generatingMap = await getGeneratingActionsBatch(
    [...new Set(forkHistory.map((entry) => entry.pageId))],
  );

  const forks = forkHistory.map<JourneyForkSummary>((entry) => {
    const sourcePage = pageMap.get(entry.pageId);
    const outcomePage = entry.nextPageId ? pageMap.get(entry.nextPageId) : undefined;
    const actions = (sourcePage?.actions ?? []) as ActionLike[];
    const generating = generatingMap.get(entry.pageId) ?? new Set<string>();
    const alternatives = actions
      .filter((action) => action.text !== entry.text)
      .map<TimeTravelAlternative>((action) => {
        const nextPageId = action.destinationPageIds?.[0] ?? null;
        const branchId = nextPageId ? (branchMap.get(nextPageId) ?? null) : null;
        return {
          text: action.text,
          nextPageId,
          hasGeneratedPath: nextPageId !== null,
          branchId,
          generatedPageCount: branchId ? (countMap.get(branchId) ?? 0) : 0,
          isGenerating: nextPageId === null && generating.has(action.text),
        };
      });
    const outcomeHasMajorFlag =
      outcomePage?.stateDelta.addPlotFlags?.some((flag) => flag.isMajorEvent) ?? false;

    return {
      forkPage: sourcePage?.page ?? entry.page,
      forkPageId: entry.pageId,
      chosenActionText: entry.text,
      chosenNextPageId: entry.nextPageId ?? null,
      outcomePage: outcomePage?.page ?? null,
      outcomeIsMajorEvent:
        outcomePage?.stateDelta.isMajorEvent === true || outcomeHasMajorFlag,
      alternatives,
    };
  });

  return { forks };
}

/**
 * Fallback fork reconstruction from `user_page_progress` when story snapshots
 * are unavailable. Progress rows retain the exact chosen destination ids.
 */
async function getJourneyForksFromProgress(
  bookId: string,
  userId: string,
): Promise<GetJourneyForksResponse> {
  const progressRows = await dbRead
    .select({
      actionedPageId: userPageProgress.actionedPageId,
      nextPageId: userPageProgress.nextPageId,
      action: userPageProgress.action,
    })
    .from(userPageProgress)
    .where(and(
      eq(userPageProgress.userId, userId),
      eq(userPageProgress.bookId, bookId),
    ))
    .orderBy(asc(userPageProgress.createdAt));

  return buildJourneyForks(
    bookId,
    progressRows.map((row) => ({
      pageId: row.actionedPageId,
      page: row.action.page,
      text: row.action.text,
      nextPageId: row.nextPageId,
    })),
  );
}

/**
 * Return only the forks on the reader's active journey, including the exact
 * chosen destination and enough outcome metadata for Journey filtering.
 *
 * When `injectedHistory` comes from the already-loaded page context, the
 * function skips story-state reconstruction.
 */
export async function getJourneyForks(
  bookId: string,
  currentPageId: string | null,
  userId?: string | null,
  fallbackPageId?: string | null,
  injectedHistory?: JourneyHistoryEntry[] | null,
): Promise<GetJourneyForksResponse> {
  let history: JourneyHistoryEntry[];

  if (injectedHistory && injectedHistory.length > 0) {
    console.log("[time-travel] getJourneyForks using injected actionsHistory", {
      bookId,
      historyLen: injectedHistory.length,
    });
    history = injectedHistory;
  } else {
    let stateRow: StoryState | null = null;
    if (currentPageId) {
      stateRow = await getStoryState(currentPageId, { maxTraversalDepth: 20 });
    }

    if (!stateRow && userId && fallbackPageId) {
      console.log(
        "[time-travel] snapshot missing for",
        currentPageId,
        "— trying session frontier",
        fallbackPageId,
      );
      stateRow = await getStoryState(fallbackPageId, { maxTraversalDepth: 20 });
    }

    console.log("[time-travel] getJourneyForks", {
      bookId,
      requestedPageId: currentPageId,
      snapshotFound: !!stateRow,
      historyLen: (stateRow?.actionsHistory ?? []).length,
    });

    if (!stateRow) {
      if (userId) {
        console.log(
          "[time-travel] getJourneyForks falling back to user_page_progress for user",
          userId,
        );
        return getJourneyForksFromProgress(bookId, userId);
      }
      return { forks: [] };
    }

    history = stateRow.actionsHistory;
  }

  return buildJourneyForks(bookId, history);
}
/**
 * Reconstruct a fork: return the taken action and every alternative with a
 * deterministic diff vs the reader's branch.
 *
 * Diff semantics (fixes the asymmetric-compare bug): we never compare the
 * reader's *tip* against the alternative's *tip*. Instead we compare the two
 * branches at **equal depth** — the reader's first page after the fork against
 * the alternative's first page after the fork — so the diff isolates what
 * actually diverged *because of the choice*, not differences that merely
 * happened later on a longer branch. Branch length is metadata, not a
 * story-state difference, so it is intentionally excluded from the diff.
 */
export async function reconstructFork(
  bookId: string,
  ancestorPageId: string,
  readerPageId: string | null,
): Promise<ReconstructForkResponse> {
  // Per-request memo so identical page states aren't reconstructed twice (B8).
  const stateCache = new Map<string, Promise<StoryState | null>>();
  const getState = (id: string) => {
    if (!stateCache.has(id)) stateCache.set(id, getStoryState(id));
    return stateCache.get(id)!;
  };

  let readerState: StoryState | null = null;
  if (readerPageId) {
    readerState = (await getState(readerPageId)) ?? null;
  }

  const [forkPage] = await dbRead
    .select({ actions: pages.actions })
    .from(pages)
    .where(eq(pages.id, ancestorPageId))
    .limit(1);
  const actions = (forkPage?.actions ?? []) as ActionLike[];

  const generating = await getGeneratingActions(ancestorPageId);

  // Resolve the taken action from the reader's history at this fork.
  let takenAction: string | null = null;
  if (readerState) {
    const match = (readerState.actionsHistory ?? []).find(
      (h) => h.pageId === ancestorPageId,
    );
    takenAction = match?.text ?? null;
  }

  // Equal-depth comparison base: the reader's first page *after* the fork.
  // (When the reader hasn't progressed past the fork yet — e.g. they opened
  // Fate on the fork page itself — fall back to their current state.)
  const forkHistoryEntry = readerState?.actionsHistory?.find(
    (h) => h.pageId === ancestorPageId,
  );
  const readerPostForkPageId = forkHistoryEntry?.nextPageId ?? null;
  const readerCompareState = readerPostForkPageId
    ? ((await getState(readerPostForkPageId)) ?? readerState)
    : readerState;

  // Batch branch ids + counts for generated alternatives.
  const generatedNextIds = actions
    .filter((a) => (a.destinationPageIds ?? []).length > 0)
    .map((a) => a.destinationPageIds![0])
    .filter(Boolean) as string[];
  const branchRows = generatedNextIds.length
    ? await dbRead
        .select({ id: pages.id, branchId: pages.branchId })
        .from(pages)
        .where(inArray(pages.id, generatedNextIds))
    : [];
  const branchMap = new Map(branchRows.map((r) => [r.id, r.branchId] as const));
  const branchIds = [...new Set(branchRows.map((r) => r.branchId).filter(Boolean))] as string[];
  const countRows = branchIds.length
    ? await dbRead
        .select({ branchId: pages.branchId, count: sql<number>`count(*)::int` })
        .from(pages)
        .where(and(eq(pages.bookId, bookId), inArray(pages.branchId, branchIds)))
        .groupBy(pages.branchId)
    : [];
  const countMap = new Map(countRows.map((r) => [r.branchId, r.count] as const));

  const alternatives: ReconstructAlternative[] = [];

  for (const a of actions) {
    // Skip the taken action, and (edge case: reader opened Fate on the fork
    // page) any alternative whose first page *is* the page they're already on.
    if (takenAction && a.text === takenAction) continue;
    const destIds = a.destinationPageIds ?? [];
    const hasGenerated = destIds.length > 0;
    const nextPageId = hasGenerated ? destIds[0] : null;
    if (hasGenerated && nextPageId && nextPageId === readerPageId) continue;

    const isGenerating = !hasGenerated && generating.has(a.text);
    let branchId: string | null = null;
    let generatedPageCount = 0;
    const diffs: TimeTravelDiff[] = [];

    if (hasGenerated && nextPageId) {
      branchId = branchMap.get(nextPageId) ?? null;
      if (branchId) generatedPageCount = countMap.get(branchId) ?? 0;

      // Equal-depth diff: alternative's first page after the fork vs the
      // reader's first page after the fork.
      const altPostState = await getState(nextPageId);
      if (readerCompareState && altPostState) {
        diffs.push(...diffStoryStates(readerCompareState, altPostState));
      }
    }

    alternatives.push({
      text: a.text,
      nextPageId,
      hasGeneratedPath: hasGenerated,
      branchId,
      generatedPageCount,
      isGenerating,
      diffs,
    });
  }

  return { takenAction, readerPageId, alternatives };
}

/**
 * Deterministic, zero-AI diff between the reader's current canon branch and an
 * alternative branch. Emits a line only where the two actually differ.
 */
export function diffStoryStates(reader: StoryState, alt: StoryState): TimeTravelDiff[] {
  const lines: TimeTravelDiff[] = [];

  // Characters: compare fate status
  const readerChars = reader.characters ?? {};
  const altChars = alt.characters ?? {};
  const charIds = new Set([...Object.keys(readerChars), ...Object.keys(altChars)]);
  for (const id of charIds) {
    const r = readerChars[id];
    const a = altChars[id];
    if (!r || !a || r.status === a.status) continue;
    lines.push({
      type: "characterStatus",
      characterId: id,
      name: r.knownName || a.knownName || null,
      before: r.status,
      after: a.status,
    });
  }

  // Plot flags: set diff on `fact`
  const readerFacts = new Set((reader.plotFlags ?? []).map((f) => f.fact));
  const altFacts = new Set((alt.plotFlags ?? []).map((f) => f.fact));
  for (const f of readerFacts) {
    if (!altFacts.has(f)) lines.push({ type: "plotFlag", change: "removed", value: f });
  }
  for (const f of altFacts) {
    if (!readerFacts.has(f)) lines.push({ type: "plotFlag", change: "added", value: f });
  }

  // Inventory: set diff on item name
  const readerItems = new Set((reader.inventory ?? []).map((i) => i.name));
  const altItems = new Set((alt.inventory ?? []).map((i) => i.name));
  for (const i of readerItems) {
    if (!altItems.has(i)) lines.push({ type: "inventory", change: "removed", value: i });
  }
  for (const i of altItems) {
    if (!readerItems.has(i)) lines.push({ type: "inventory", change: "added", value: i });
  }

  // Sanity / composure
  const rc = reader.sanityState?.composure;
  const ac = alt.sanityState?.composure;
  const readerMaxComposure = reader.sanityState?.maxComposure ?? 100;
  const altMaxComposure = alt.sanityState?.maxComposure ?? 100;
  if (
    rc !== undefined &&
    ac !== undefined &&
    (rc !== ac || readerMaxComposure !== altMaxComposure)
  ) {
    lines.push({
      type: "composure",
      before: { value: rc, max: readerMaxComposure },
      after: { value: ac, max: altMaxComposure },
    });
  }

  // Injuries: set diff on description
  const readerInj = new Set((reader.injuries ?? []).map((i) => i.description));
  const altInj = new Set((alt.injuries ?? []).map((i) => i.description));
  for (const i of readerInj) {
    if (!altInj.has(i)) lines.push({ type: "injury", change: "removed", value: i });
  }
  for (const i of altInj) {
    if (!readerInj.has(i)) lines.push({ type: "injury", change: "added", value: i });
  }

  return lines;
}

// ── AI-narrated "what happens if" summaries (Q5) ──────────────────────────

/** Convert one structured difference into internal grounding text for the LLM. */
function formatTimeTravelDiffForPrompt(diff: TimeTravelDiff): string {
  switch (diff.type) {
    case "characterStatus":
      return `Character: ${diff.name ?? "Someone"} changed from ${diff.before} to ${diff.after}`;
    case "plotFlag":
      return `Plot flag ${diff.change}: ${diff.value}`;
    case "inventory":
      return `Inventory item ${diff.change}: ${diff.value}`;
    case "composure":
      return `Composure changed from ${diff.before.value}/${diff.before.max} to ${diff.after.value}/${diff.after.max}`;
    case "injury":
      return `Injury ${diff.change}: ${diff.value}`;
  }
}

/**
 * Produces a short, atmospheric, second-person narration of what stepping onto
 * an alternative path would feel like, based strictly on the structured diffs
 * returned by `diffStoryStates`. Returns `null` if the LLM call fails or
 * returns an empty response — the caller should treat `null` as a transient
 * failure and surface a user-facing error.
 *
 * The narration is free-form prose; it does NOT invent new plot beyond the
 * provided diffs, keeping it grounded in the actual world-state divergence.
 */
export async function narrateForkAlternative(input: {
  bookTitle: string;
  takenActionText: string;
  alternativeText: string;
  diffs: TimeTravelDiff[];
}): Promise<string | null> {
  const diffText =
    input.diffs.length > 0
      ? input.diffs.map((diff) => `- ${formatTimeTravelDiffForPrompt(diff)}`).join("\n")
      : "(No concrete differences were detected — the two roads are effectively identical up to this point.)";

  const userPrompt =
    `Book: "${input.bookTitle}".\n` +
    `At a fork, the reader chose "${input.takenActionText}". ` +
    `The alternative road not taken is "${input.alternativeText}".\n\n` +
    `Here is the structured difference between the reader's road and that alternative, ` +
    `measured at the first page after the fork:\n${diffText}\n\n` +
    `Write a vivid, second-person, 2-3 sentence narration describing what stepping onto ` +
    `"${input.alternativeText}" would feel like and what changes. Do not invent new plot; ` +
    `only reflect the differences above. Keep it under 60 words.`;

  const res = await aiPrompt<string>(userPrompt, {
    systemPrompt:
      "You are a literary narrator for an interactive branching fiction app. " +
      "You describe alternate paths the reader could have taken, based strictly on the " +
      "provided structured differences. Be atmospheric but concise.",
    modelSelection: AI_CHAT_MODELS_WRITING,
    config: { ...AI_CHAT_CONFIG_DEFAULT, maxOutputToken: 240, temperature: 0.8 },
    context: "time-travel-narrate",
  });

  if (res.provider === "none" || !res.output) return null;
  return res.output.trim();
}
