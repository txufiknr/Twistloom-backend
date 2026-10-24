import { isValidUuid } from './uuid.js';
import type { Action, SelectedAction } from '../types/story.js';

export const GUEST_PROGRESS_VERSION = 1;
export const MAX_GUEST_ACTIONS = 50;
export type GuestProgressImport = {
  pageIds: string[];
  actions: Array<{ actionedPageId: string; nextPageId: string; actionId: string }>;
  session: { pageId: string; frontierPageId: string };
  expectedSession: { pageId: string; updatedAt: string; lastGuestImportId?: string | null } | null;
} & { importVersion: 1; operationId: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

export function parseGuestProgressImport(body: unknown): GuestProgressImport {
  if (!isRecord(body) || !hasOnlyKeys(body, ['importVersion', 'operationId', 'pageIds', 'actions', 'session', 'expectedSession']) ||
      body.importVersion !== GUEST_PROGRESS_VERSION) throw new Error('Invalid guest import version');
  if (typeof body.operationId !== 'string' || !isValidUuid(body.operationId)) throw new Error('Invalid guest operation UUID');
  if (!Array.isArray(body.pageIds) || body.pageIds.length < 1 || body.pageIds.length > 512) throw new Error('Invalid guest page window');
  const pageIds: string[] = [];
  const uniquePageIds = new Set<string>();
  for (const id of body.pageIds) {
    if (!isValidUuid(id) || uniquePageIds.has(id)) throw new Error('Invalid or duplicate guest page UUID');
    uniquePageIds.add(id);
    pageIds.push(id);
  }
  if (!Array.isArray(body.actions) || body.actions.length > MAX_GUEST_ACTIONS) throw new Error('Too many guest actions (max 50)');
  const actions: GuestProgressImport['actions'] = [];
  for (const edge of body.actions) {
    if (!isRecord(edge) || !hasOnlyKeys(edge, ['actionedPageId', 'nextPageId', 'actionId']) ||
        !isValidUuid(edge.actionedPageId) || !isValidUuid(edge.nextPageId) ||
        typeof edge.actionId !== 'string' || edge.actionId.length < 1 || edge.actionId.length > 2000) throw new Error('Invalid guest action reference');
    actions.push({ actionedPageId: edge.actionedPageId, nextPageId: edge.nextPageId, actionId: edge.actionId });
  }
  if (!isRecord(body.session) || !hasOnlyKeys(body.session, ['pageId', 'frontierPageId']) ||
      !isValidUuid(body.session.pageId) || !isValidUuid(body.session.frontierPageId)) throw new Error('Invalid guest session');
  if (!uniquePageIds.has(body.session.pageId) || !uniquePageIds.has(body.session.frontierPageId)) {
    throw new Error('Guest session pages are missing from the page window');
  }
  if (actions.some((edge) => !uniquePageIds.has(edge.actionedPageId) || !uniquePageIds.has(edge.nextPageId))) {
    throw new Error('Guest action pages are missing from the page window');
  }
  let expectedSession: GuestProgressImport['expectedSession'] = null;
  if (body.expectedSession !== null) {
    const expected = body.expectedSession;
    if (!isRecord(expected) || !hasOnlyKeys(expected, ['pageId', 'updatedAt', 'lastGuestImportId']) ||
        !Object.hasOwn(expected, 'lastGuestImportId') || !isValidUuid(expected.pageId) || typeof expected.updatedAt !== 'string' ||
        !Number.isFinite(Date.parse(expected.updatedAt))) throw new Error('Invalid guest session precondition');
    if (expected.lastGuestImportId !== null && !isValidUuid(expected.lastGuestImportId)) {
      throw new Error('Missing or invalid guest import precondition marker');
    }
    expectedSession = { pageId: expected.pageId, updatedAt: expected.updatedAt,
      ...(expected.lastGuestImportId === null || typeof expected.lastGuestImportId === 'string'
        ? { lastGuestImportId: expected.lastGuestImportId } : {}),
    };
  }
  const refs = { pageIds, actions, session: { pageId: body.session.pageId, frontierPageId: body.session.frontierPageId }, expectedSession };
  return { importVersion: GUEST_PROGRESS_VERSION, operationId: body.operationId, ...refs };
}

export type GuestProgressAcknowledgement = {
  importVersion: 1;
  operationId: string;
  sessionApplied: boolean;
  alreadyApplied: boolean;
  actionsImported: number;
  reason?: 'conflict' | 'operation_mismatch';
  session?: { pageId: string; frontierPageId: string; frontierPageNumber: number; frontierAncestorIds: string[] };
};

/** Fixed-size metadata carried by the existing session row. */
export const clearedGuestImportMarker = Object.freeze({ lastGuestImportId: null, lastGuestImportHash: null });

export type GuestProgressState = {
  pageId: string | null;
  updatedAt: Date;
  frontierPageId: string | null;
  frontierPageNumber: number;
  frontierAncestorIds: string[];
  lastGuestImportId: string | null;
  lastGuestImportHash: string | null;
};

export async function guestImportFingerprint(input: GuestProgressImport): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function guestImportConflict(input: GuestProgressImport, reason: 'conflict' | 'operation_mismatch' = 'conflict'): GuestProgressAcknowledgement {
  return { importVersion: GUEST_PROGRESS_VERSION, operationId: input.operationId,
    sessionApplied: false, alreadyApplied: false, actionsImported: 0, reason };
}

/** Called under the session row lock. Null means the original consent still
 * permits one application. No historical success is inferred from a cursor. */
export function resolveGuestImport(input: GuestProgressImport, hash: string, current: GuestProgressState | undefined): GuestProgressAcknowledgement | null {
  if (current?.lastGuestImportId === input.operationId) {
    if (current.lastGuestImportHash !== hash) return guestImportConflict(input, 'operation_mismatch');
    if (!current.pageId || !current.frontierPageId) return guestImportConflict(input);
    return { importVersion: GUEST_PROGRESS_VERSION, operationId: input.operationId,
      sessionApplied: true, alreadyApplied: true, actionsImported: input.actions.length,
      session: { pageId: current.pageId, frontierPageId: current.frontierPageId,
        frontierPageNumber: current.frontierPageNumber, frontierAncestorIds: current.frontierAncestorIds } };
  }
  const expected = input.expectedSession;
  const matches = expected === null ? current === undefined : current !== undefined &&
    current.pageId === expected.pageId && current.updatedAt.getTime() === Date.parse(expected.updatedAt) &&
    current.lastGuestImportId === expected.lastGuestImportId;
  return matches ? null : guestImportConflict(input);
}
export type GuestProgressPage = {
  id: string;
  parentId: string | null;
  bookId: string;
  page: number;
  actions: Action[];
};

/** Bounded, deterministic validation. Missing ancestry is refused, never guessed. */
export function canonicalGuestProgress(input: GuestProgressImport, rows: GuestProgressPage[], bookId: string) {
  const session = canonicalGuestSession(input.session, rows, bookId);
  const pathIds = new Set(session.path.map((page) => page.id));
  const actions = canonicalGuestActions(input.actions, rows, bookId);
  if (actions.length !== session.path.length - 1) throw new Error('Guest choices do not cover the confirmed path');
  if (actions.some((edge) => !pathIds.has(edge.actionedPageId) || !pathIds.has(edge.nextPageId))) {
    throw new Error('Guest choice is outside the confirmed branch');
  }
  return { actions, session: session.session };
}

/** Resolves the current/frontier cursor and ancestry exclusively from canonical pages. */
export function canonicalGuestSession(
  input: GuestProgressImport['session'],
  rows: GuestProgressPage[],
  bookId: string,
) {
  const pages = new Map(rows.filter((p) => p.bookId === bookId).map((p) => [p.id, p]));
  const path: GuestProgressPage[] = [];
  const seen = new Set<string>();
  let cursor: string | null = input.frontierPageId;
  while (cursor !== null) {
    if (seen.has(cursor)) throw new Error('Guest path contains a cycle');
    seen.add(cursor);
    const page = pages.get(cursor);
    if (!page) throw new Error('Guest path is incomplete or no longer available');
    path.push(page);
    cursor = page.parentId;
  }
  path.reverse();
  if (!seen.has(input.pageId)) throw new Error('Current page is outside the guest frontier');
  const frontier = path.at(-1);
  if (!frontier) throw new Error('Guest path is empty');
  return {
    path,
    session: {
      pageId: input.pageId,
      frontierPageId: frontier.id,
      frontierPageNumber: frontier.page,
      frontierAncestorIds: path.slice(0, -1).map((p) => p.id),
    },
  };
}

/** Validates legacy selected-action references against the canonical page data.
 * Client action metadata is intentionally ignored and rebuilt from the source page. */
export function canonicalGuestActions(
  edges: GuestProgressImport['actions'],
  rows: GuestProgressPage[],
  bookId: string,
): Array<{ actionedPageId: string; nextPageId: string; action: SelectedAction }> {
  const pages = new Map(rows.filter((p) => p.bookId === bookId).map((p) => [p.id, p]));
  const sources = new Set<string>();
  const actions: Array<{ actionedPageId: string; nextPageId: string; action: SelectedAction }> = [];
  for (const edge of edges) {
    if (sources.has(edge.actionedPageId)) throw new Error('Duplicate guest choice');
    sources.add(edge.actionedPageId);
    const source = pages.get(edge.actionedPageId);
    const destination = pages.get(edge.nextPageId);
    if (!source || !destination || destination.parentId !== source.id) {
      throw new Error('Guest choice is not a valid page transition');
    }
    const action = source.actions.find((a, i) =>
      (a.text === edge.actionId || a.customActionId === edge.actionId || `action-${i + 1}` === edge.actionId) &&
      a.destinationPageIds?.includes(destination.id),
    );
    if (!action) throw new Error('Guest choice no longer matches a canonical action');
    actions.push({
      actionedPageId: source.id,
      nextPageId: destination.id,
      action: {
        text: action.text, type: action.type, hint: action.hint, source: action.source,
        pageId: source.id, page: source.page, nextPageId: destination.id,
      },
    });
  }
  return actions;
}
