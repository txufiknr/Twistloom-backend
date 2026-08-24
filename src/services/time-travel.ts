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
import { pages, userSessions, actionProgress } from "../db/schema.js";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { StoryState } from "../types/story.js";
import { getStoryState } from "./story.js";

export type TimeTravelDiffDimension =
  | "character"
  | "plotFlag"
  | "inventory"
  | "sanity"
  | "injury"
  | "phase";

export type DiffLine = {
  dimension: TimeTravelDiffDimension;
  text: string;
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
  diffs: DiffLine[];
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

/** Tip page (highest page number) of a branch. */
export async function getBranchTip(
  bookId: string,
  branchId: string,
): Promise<{ id: string; page: number } | null> {
  const [tip] = await dbRead
    .select({ id: pages.id, page: pages.page })
    .from(pages)
    .where(and(eq(pages.bookId, bookId), eq(pages.branchId, branchId)))
    .orderBy(desc(pages.page))
    .limit(1);
  return tip ?? null;
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
 * Build the reader's path as a list of nodes with fork/alternative info,
 * used to render the Fate tab.
 */
export async function getReaderPath(
  bookId: string,
  currentPageId: string | null,
  userId?: string | null,
  fallbackPageId?: string | null,
): Promise<GetTimeTravelPathResponse> {
  // The `storyStates` table's full rows can be deleted by the cleanup strategy,
  // so we read through `getStoryState`, which reconstructs a missing snapshot
  // from the parent-chain deltas — the same path the reader UI uses. If the
  // supplied page's state is still missing, fall back to the reader's session
  // frontier page (resolved once by the caller and passed as `fallbackPageId`).
  const resolvedPageId = currentPageId ?? fallbackPageId ?? null;
  let stateRow: StoryState | null = null;
  if (currentPageId) stateRow = await getStoryState(currentPageId);

  if (!stateRow && userId && fallbackPageId) {
    console.log("[time-travel] snapshot missing for", currentPageId, "— trying session frontier", fallbackPageId);
    stateRow = await getStoryState(fallbackPageId);
  }

  console.log("[time-travel] getReaderPath", {
    bookId,
    requestedPageId: currentPageId,
    resolvedPageId,
    snapshotFound: !!stateRow,
    historyLen: (stateRow?.actionsHistory ?? []).length,
  });

  if (!stateRow) return { path: [] };

  const history = (stateRow.actionsHistory ?? []) as Array<{
    pageId: string;
    page: number;
    text: string;
  }>;

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
 * happened later on a longer branch. A separate "reaches page N" note (below)
 * still captures length asymmetry.
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

  const readerCurrentPage = readerState?.page ?? 0;

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
    const diffs: DiffLine[] = [];

    if (hasGenerated && nextPageId) {
      branchId = branchMap.get(nextPageId) ?? null;
      if (branchId) generatedPageCount = countMap.get(branchId) ?? 0;

      // Equal-depth diff: alternative's first page after the fork vs the
      // reader's first page after the fork.
      const altPostState = await getState(nextPageId);
      if (readerCompareState && altPostState) {
        diffs.push(...diffStoryStates(readerCompareState, altPostState));
      }

      // Length note: if the alternative's branch tip is *shorter* than the
      // reader's current page, surface how far it currently reaches.
      const tip = branchId ? await getBranchTip(bookId, branchId) : null;
      if (tip && readerCurrentPage > 0 && tip.page < readerCurrentPage) {
        diffs.push({
          dimension: "phase",
          text: `This path currently reaches page ${tip.page}`,
        });
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
export function diffStoryStates(reader: StoryState, alt: StoryState): DiffLine[] {
  const lines: DiffLine[] = [];

  // Characters: compare fate status
  const readerChars = reader.characters ?? {};
  const altChars = alt.characters ?? {};
  const charIds = new Set([...Object.keys(readerChars), ...Object.keys(altChars)]);
  for (const id of charIds) {
    const r = readerChars[id];
    const a = altChars[id];
    if (!r || !a || r.status === a.status) continue;
    const name = r.knownName || a.knownName || "Someone";
    if (r.status === "dead" && a.status !== "dead") {
      lines.push({ dimension: "character", text: `${name} is not dead` });
    } else if (r.status !== "dead" && a.status === "dead") {
      lines.push({ dimension: "character", text: `${name} died` });
    } else {
      lines.push({ dimension: "character", text: `${name} is ${a.status} (was ${r.status})` });
    }
  }

  // Plot flags: set diff on `fact`
  const readerFacts = new Set((reader.plotFlags ?? []).map((f) => f.fact));
  const altFacts = new Set((alt.plotFlags ?? []).map((f) => f.fact));
  for (const f of readerFacts) {
    if (!altFacts.has(f)) lines.push({ dimension: "plotFlag", text: `flag '${f}' was never set` });
  }
  for (const f of altFacts) {
    if (!readerFacts.has(f)) lines.push({ dimension: "plotFlag", text: `new flag: '${f}'` });
  }

  // Inventory: set diff on item name
  const readerItems = new Set((reader.inventory ?? []).map((i) => i.name));
  const altItems = new Set((alt.inventory ?? []).map((i) => i.name));
  for (const i of readerItems) {
    if (!altItems.has(i)) lines.push({ dimension: "inventory", text: `You never obtained ${i}` });
  }
  for (const i of altItems) {
    if (!readerItems.has(i)) lines.push({ dimension: "inventory", text: `You gained: ${i}` });
  }

  // Sanity / composure
  const rc = reader.sanityState?.composure;
  const ac = alt.sanityState?.composure;
  if (rc !== undefined && ac !== undefined && rc !== ac) {
    const max = alt.sanityState?.maxComposure ?? 100;
    lines.push({ dimension: "sanity", text: `Composure ${rc}/${max} → ${ac}/${max}` });
  }

  // Injuries: set diff on description
  const readerInj = new Set((reader.injuries ?? []).map((i) => i.description));
  const altInj = new Set((alt.injuries ?? []).map((i) => i.description));
  for (const i of readerInj) {
    if (!altInj.has(i)) lines.push({ dimension: "injury", text: `No ${i}` });
  }
  for (const i of altInj) {
    if (!readerInj.has(i)) lines.push({ dimension: "injury", text: `Acquired: ${i}` });
  }

  // NOTE: length/phase comparison ("reaches page N") is intentionally NOT done
  // here. `reconstructFork` calls this with branches compared at equal depth
  // (first page after the fork) and emits the length note separately, so this
  // pure diff only reports genuine field-level divergence.

  return lines;
}
