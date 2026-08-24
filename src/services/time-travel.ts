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
import { pages, storyStates, userSessions, actionProgress } from "../db/schema.js";
import { and, desc, eq, sql } from "drizzle-orm";
import type { StoryState } from "../types/story.js";

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
  /** The alternative branch's full snapshot at its tip page (null if not generated). */
  tipState: StoryState | null;
  /** Diff between the reader's current branch and this alternative's tip. Empty if not generated. */
  diffs: DiffLine[];
};

export type ReconstructForkResponse = {
  /** The fork page's own snapshot. */
  page: StoryState | null;
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

async function countBranchPages(bookId: string, branchId: string): Promise<number> {
  const [row] = await dbRead
    .select({ count: sql<number>`count(*)::int` })
    .from(pages)
    .where(and(eq(pages.bookId, bookId), eq(pages.branchId, branchId)));
  return row?.count ?? 0;
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
  currentPageId: string,
  userId?: string | null,
): Promise<GetTimeTravelPathResponse> {
  // Load the reader's actionsHistory from the storyStates snapshot of the
  // current page. If that snapshot was cleaned up (intermediate rows can be
  // deleted by the story-state cleanup strategy), fall back to the reader's
  // session frontier page.
  let resolvedPageId = currentPageId;
  let [stateRow] = await dbRead
    .select({ actionsHistory: storyStates.actionsHistory })
    .from(storyStates)
    .where(and(eq(storyStates.pageId, resolvedPageId), eq(storyStates.bookId, bookId)))
    .limit(1);

  if (!stateRow && userId) {
    const frontier = await resolveCurrentPageId(bookId, userId, undefined);
    console.log("[time-travel] snapshot missing for", resolvedPageId, "— trying session frontier", frontier);
    if (frontier) {
      resolvedPageId = frontier;
      [stateRow] = await dbRead
        .select({ actionsHistory: storyStates.actionsHistory })
        .from(storyStates)
        .where(and(eq(storyStates.pageId, resolvedPageId), eq(storyStates.bookId, bookId)))
        .limit(1);
    }
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

  const path: TimeTravelPathNode[] = [];

  for (const node of history) {
    const [pageRow] = await dbRead
      .select({ page: pages.page, actions: pages.actions })
      .from(pages)
      .where(eq(pages.id, node.pageId))
      .limit(1);

    const actions = (pageRow?.actions ?? []) as ActionLike[];
    const isFork = actions.length > 1;
    const alternatives: TimeTravelAlternative[] = [];

    if (isFork) {
      const generating = await getGeneratingActions(node.pageId);
      for (const a of actions) {
        if (a.text === node.text) continue;
        const destIds = a.destinationPageIds ?? [];
        const hasGenerated = destIds.length > 0;
        const nextPageId = hasGenerated ? destIds[0] : null;
        const isGenerating = !hasGenerated && generating.has(a.text);
        let branchId: string | null = null;
        let generatedPageCount = 0;
        if (hasGenerated && nextPageId) {
          const [dest] = await dbRead
            .select({ branchId: pages.branchId })
            .from(pages)
            .where(eq(pages.id, nextPageId))
            .limit(1);
          branchId = dest?.branchId ?? null;
          if (branchId) generatedPageCount = await countBranchPages(bookId, branchId);
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

    console.log("[time-travel] node", {
      pageId: node.pageId,
      chosen: node.text,
      pageActions: actions.length,
      isFork,
      altCount: alternatives.length,
    });

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
 * Reconstruct a fork: return the fork page's own snapshot, the taken action,
 * and every alternative with its generated branch tip + a diff vs the reader's
 * current branch.
 */
export async function reconstructFork(
  bookId: string,
  ancestorPageId: string,
  readerPageId: string | null,
): Promise<ReconstructForkResponse> {
  const [forkStateRow] = await dbRead
    .select()
    .from(storyStates)
    .where(eq(storyStates.pageId, ancestorPageId))
    .limit(1);
  const forkState = (forkStateRow as StoryState | undefined) ?? null;

  let readerState: StoryState | null = null;
  if (readerPageId) {
    const [readerRow] = await dbRead
      .select()
      .from(storyStates)
      .where(eq(storyStates.pageId, readerPageId))
      .limit(1);
    readerState = (readerRow as StoryState | undefined) ?? null;
  }

  const [forkPage] = await dbRead
    .select({ actions: pages.actions })
    .from(pages)
    .where(eq(pages.id, ancestorPageId))
    .limit(1);
  const actions = (forkPage?.actions ?? []) as ActionLike[];

  const generating = await getGeneratingActions(ancestorPageId);

  let takenAction: string | null = null;
  if (readerState) {
    const match = (readerState.actionsHistory ?? []).find(
      (h) => h.pageId === ancestorPageId,
    );
    takenAction = match?.text ?? null;
  }

  const alternatives: ReconstructAlternative[] = [];

  for (const a of actions) {
    if (takenAction && a.text === takenAction) continue;
    const destIds = a.destinationPageIds ?? [];
    const hasGenerated = destIds.length > 0;
    const nextPageId = hasGenerated ? destIds[0] : null;
    const isGenerating = !hasGenerated && generating.has(a.text);
    let branchId: string | null = null;
    let generatedPageCount = 0;
    let tipState: StoryState | null = null;

    if (hasGenerated && nextPageId) {
      const [dest] = await dbRead
        .select({ branchId: pages.branchId })
        .from(pages)
        .where(eq(pages.id, nextPageId))
        .limit(1);
      branchId = dest?.branchId ?? null;
      if (branchId) {
        generatedPageCount = await countBranchPages(bookId, branchId);
        const tip = await getBranchTip(bookId, branchId);
        if (tip) {
          const [tipRow] = await dbRead
            .select()
            .from(storyStates)
            .where(eq(storyStates.pageId, tip.id))
            .limit(1);
          tipState = (tipRow as StoryState | undefined) ?? null;
        }
      }
    }

    const diffs = readerState && tipState ? diffStoryStates(readerState, tipState) : [];
    alternatives.push({
      text: a.text,
      nextPageId,
      hasGeneratedPath: hasGenerated,
      branchId,
      generatedPageCount,
      isGenerating,
      tipState,
      diffs,
    });
  }

  return { page: forkState, takenAction, readerPageId, alternatives };
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

  // Phase / length: note if the alternative is shorter than the reader's branch
  const readerPage = reader.page ?? 0;
  const altPage = alt.page ?? 0;
  if (altPage > 0 && altPage < readerPage) {
    lines.push({ dimension: "phase", text: `This path currently reaches page ${altPage}` });
  }

  return lines;
}
