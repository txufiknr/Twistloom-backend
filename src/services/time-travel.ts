/**
 * Story Time Travel — read-only branch reconstruction for the reader-facing
 * "Fate Peek" / "Take This Path" feature (roadmap item 1.6).
 *
 * The whole feature is a read-and-shape operation over existing data:
 * - `storyStates` carries a **complete `StoryState` snapshot per page** (PK `pageId`),
 *   so no delta-replay engine is needed.
 * - `pages.actions[].destinationPageIds` tells us which alternatives at a fork
 *   already have a generated continuation.
 * - `user_sessions` resolves the reader's current frontier page.
 *
 * Phase 1 (Fate Peek) is pure preview: no writes, no AI, no credits.
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

export type TimeTravelPathNode = {
  /** Page number of the fork node. */
  page: number;
  /** Page id of the fork node (the page the action was chosen from). */
  pageId: string;
  /** The action text the reader actually chose there. */
  chosenActionText: string;
  /** True when the page offered more than one action. */
  isFork: boolean;
  alternatives: TimeTravelAlternative[];
};

export type GetTimeTravelPathResponse = {
  path: TimeTravelPathNode[];
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
 * all supplied fork pages in a single query (avoids N+1 in `getReaderPath`).
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
 * Fallback path reconstruction from `user_page_progress` when `storyStates`
 * snapshots are unavailable (cleaned up + parent-chain reconstruction failed).
 *
 * Queries the user's page-progress rows (NOT cleaned up) and batch-resolves
 * each page's available actions to identify forks, mirroring the shape
 * produced by the primary `storyStates`-based path.
 */
async function getReaderPathFromProgress(
  bookId: string,
  userId: string,
): Promise<GetTimeTravelPathResponse> {
  // 1. Fetch all progress rows for this user+book, ordered chronologically.
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

  if (progressRows.length === 0) return { path: [] };

  // 2. Batch-fetch page rows for every source page.
  const pageIds = [...new Set(progressRows.map((r) => r.actionedPageId))];
  const pageRows = pageIds.length
    ? await dbRead
        .select({ id: pages.id, page: pages.page, actions: pages.actions })
        .from(pages)
        .where(inArray(pages.id, pageIds))
    : [];
  const pageMap = new Map(pageRows.map((r) => [r.id, r]));

  // 3. Collect alternative nextPageIds for branch/count lookups.
  const forkPageIds: string[] = [];
  const altNextPageIds: string[] = [];
  for (const row of progressRows) {
    const pageRow = pageMap.get(row.actionedPageId);
    const actions = (pageRow?.actions ?? []) as ActionLike[];
    if (actions.length > 1) {
      forkPageIds.push(row.actionedPageId);
      for (const a of actions) {
        if (a.text === row.action.text) continue;
        const destIds = a.destinationPageIds ?? [];
        if (destIds.length > 0 && destIds[0]) altNextPageIds.push(destIds[0]);
      }
    }
  }

  // 4. Batch branch + count lookups (same as primary path).
  const branchRows = altNextPageIds.length
    ? await dbRead
        .select({ id: pages.id, branchId: pages.branchId })
        .from(pages)
        .where(inArray(pages.id, altNextPageIds))
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

  // 5. In-flight generations.
  const generatingMap = await getGeneratingActionsBatch(forkPageIds);

  // 6. Build path nodes.
  const path: TimeTravelPathNode[] = [];
  for (const row of progressRows) {
    const pageRow = pageMap.get(row.actionedPageId);
    const actions = (pageRow?.actions ?? []) as ActionLike[];
    const isFork = actions.length > 1;
    const alternatives: TimeTravelAlternative[] = [];

    if (isFork) {
      const generating = generatingMap.get(row.actionedPageId) ?? new Set<string>();
      for (const a of actions) {
        if (a.text === row.action.text) continue;
        const destIds = a.destinationPageIds ?? [];
        const hasGenerated = destIds.length > 0;
        const nextPageId = hasGenerated ? destIds[0] : null;
        const isGenerating = !hasGenerated && generating.has(a.text);
        let branchId: string | null = null;
        let generatedPageCount = 0;
        if (hasGenerated && nextPageId) {
          branchId = branchMap.get(nextPageId) ?? null;
          if (branchId) generatedPageCount = countMap.get(branchId) ?? 0;
        }
        alternatives.push({
          text: a.text,
          nextPageId,
          hasGeneratedPath: hasGenerated,
          branchId,
          generatedPageCount,
          isGenerating,
        });
      }
    }

    path.push({
      page: pageRow?.page ?? 0,
      pageId: row.actionedPageId,
      chosenActionText: row.action.text,
      isFork,
      alternatives,
    });
  }

  return { path };
}

/**
 * Build the reader's path as a list of nodes with fork/alternative info,
 * used to render the Fate tab.
 *
 * When `injectedHistory` is provided (from the frontend's existing
 * `page.context.actionsHistory`), the function skips the `getStoryState` call
 * entirely — this is the optimized path that avoids a redundant snapshot
 * reconstruction.
 */
export async function getReaderPath(
  bookId: string,
  currentPageId: string | null,
  userId?: string | null,
  fallbackPageId?: string | null,
  injectedHistory?: Array<{ pageId: string; page: number; text: string; nextPageId?: string }> | null,
): Promise<GetTimeTravelPathResponse> {
  let history: Array<{ pageId: string; page: number; text: string }>;

  if (injectedHistory && injectedHistory.length > 0) {
    // Fast path: the frontend already has the history from the page-read
    // endpoint — skip the getStoryState call entirely.
    console.log("[time-travel] getReaderPath using injected actionsHistory", {
      bookId,
      historyLen: injectedHistory.length,
    });
    history = injectedHistory;
  } else {
    // Slow path: reconstruct from storyStates (may need deep parent-chain
    // traversal when snapshots are cleaned up).
    const resolvedPageId = currentPageId ?? fallbackPageId ?? null;
    let stateRow: StoryState | null = null;
    if (currentPageId) stateRow = await getStoryState(currentPageId, { maxTraversalDepth: 20 });

    if (!stateRow && userId && fallbackPageId) {
      console.log("[time-travel] snapshot missing for", currentPageId, "— trying session frontier", fallbackPageId);
      stateRow = await getStoryState(fallbackPageId, { maxTraversalDepth: 20 });
    }

    console.log("[time-travel] getReaderPath", {
      bookId,
      requestedPageId: currentPageId,
      resolvedPageId,
      snapshotFound: !!stateRow,
      historyLen: (stateRow?.actionsHistory ?? []).length,
    });

    if (!stateRow) {
      // Fallback: reconstruct path from user_page_progress (not cleaned up).
      if (userId) {
        console.log("[time-travel] getReaderPath falling back to user_page_progress for user", userId);
        return getReaderPathFromProgress(bookId, userId);
      }
      return { path: [] };
    }

    history = (stateRow.actionsHistory ?? []) as Array<{
      pageId: string;
      page: number;
      text: string;
    }>;
  }

  // ── Batch all per-node / per-alternative lookups (fixes N+1) ──────────────
  const nodePageIds = history.map((n) => n.pageId);
  const pageRows = nodePageIds.length
    ? await dbRead
        .select({ id: pages.id, page: pages.page, actions: pages.actions })
        .from(pages)
        .where(inArray(pages.id, nodePageIds))
    : [];
  const pageMap = new Map(pageRows.map((r) => [r.id, r]));

  // First pass: decide forks and collect every generated alternative's nextPageId.
  const forkNodeIds: string[] = [];
  const nextPageIds: string[] = [];
  for (const node of history) {
    const actions = (pageMap.get(node.pageId)?.actions ?? []) as ActionLike[];
    if (actions.length > 1) {
      forkNodeIds.push(node.pageId);
      for (const a of actions) {
        if (a.text === node.text) continue;
        const destIds = a.destinationPageIds ?? [];
        if (destIds.length > 0 && destIds[0]) nextPageIds.push(destIds[0]);
      }
    }
  }

  // Branch ids for every alternative (one query) + per-branch page counts (one grouped query).
  const branchRows = nextPageIds.length
    ? await dbRead
        .select({ id: pages.id, branchId: pages.branchId })
        .from(pages)
        .where(inArray(pages.id, nextPageIds))
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

  // In-flight generations per fork page (one query).
  const generatingMap = await getGeneratingActionsBatch(forkNodeIds);

  // ── Build path nodes with zero per-node DB round-trips ───────────────────
  const path: TimeTravelPathNode[] = [];

  for (const node of history) {
    const pageRow = pageMap.get(node.pageId);
    const actions = (pageRow?.actions ?? []) as ActionLike[];
    const isFork = actions.length > 1;
    const alternatives: TimeTravelAlternative[] = [];

    if (isFork) {
      const generating = generatingMap.get(node.pageId) ?? new Set<string>();
      for (const a of actions) {
        if (a.text === node.text) continue;
        const destIds = a.destinationPageIds ?? [];
        const hasGenerated = destIds.length > 0;
        // Multiverse forks may list several candidate pages in `destinationPageIds`;
        // we surface the first as the representative next page. A live re-choose
        // would run candidate selection to pick one, but for the preview/commit
        // shortcut any valid generated candidate is an acceptable target (the
        // commit endpoint only verifies it belongs to this fork's action).
        const nextPageId = hasGenerated ? destIds[0] : null;
        const isGenerating = !hasGenerated && generating.has(a.text);
        let branchId: string | null = null;
        let generatedPageCount = 0;
        if (hasGenerated && nextPageId) {
          branchId = branchMap.get(nextPageId) ?? null;
          if (branchId) generatedPageCount = countMap.get(branchId) ?? 0;
        }
        alternatives.push({
          text: a.text,
          nextPageId,
          hasGeneratedPath: hasGenerated,
          branchId,
          generatedPageCount,
          isGenerating,
        });
      }
    }

    path.push({
      page: pageRow?.page ?? node.page,
      pageId: node.pageId,
      chosenActionText: node.text,
      isFork,
      alternatives,
    });
  }

  return { path };
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
