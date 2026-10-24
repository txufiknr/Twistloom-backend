import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalGuestProgress, clearedGuestImportMarker, guestImportFingerprint, parseGuestProgressImport, resolveGuestImport } from './guest-progress.js';
import type { GuestProgressImport, GuestProgressPage, GuestProgressState } from './guest-progress.js';

const root = '0199a248-8d40-7000-8000-000000000001';
const tip = '0199a248-8d40-7000-8000-000000000002';
const foreign = '0199a248-8d40-7000-8000-000000000003';
const operation = '0199a248-8d40-7000-8000-000000000004';
const nextOperation = '0199a248-8d40-7000-8000-000000000005';
const input = (): GuestProgressImport => ({
  importVersion: 1, operationId: operation, pageIds: [root, tip], expectedSession: null,
  actions: [{ actionedPageId: root, nextPageId: tip, actionId: 'action-1' }],
  session: { pageId: root, frontierPageId: tip },
});
const pages = (): GuestProgressPage[] => [
  { id: root, parentId: null, bookId: 'book', page: 1, actions: [{
    text: 'Canonical choice', type: 'explore', hint: { text: 'Canonical hint', type: 'none' },
    source: 'ai', destinationPageIds: [tip],
  }] },
  { id: tip, parentId: root, bookId: 'book', page: 2, actions: [] },
];
test('parser accepts bounded references and refuses missing session precondition', () => {
  assert.deepEqual(parseGuestProgressImport(input()), input());
  assert.throws(() => parseGuestProgressImport({ ...input(), expectedSession: undefined }));
  assert.throws(() => parseGuestProgressImport({ ...input(), actions: Array(51).fill(input().actions[0]) }));
  assert.throws(() => parseGuestProgressImport({ ...input(), pageIds: ['not-a-uuid'] }));
});
test('canonical graph supplies text, categories, depth and ancestry', () => {
  const result = canonicalGuestProgress(input(), pages(), 'book');
  assert.equal(result.actions[0]?.action.text, 'Canonical choice');
  assert.equal(result.actions[0]?.action.page, 1);
  assert.equal(result.session.frontierPageNumber, 2);
  assert.deepEqual(result.session.frontierAncestorIds, [root]);
  assert.equal(result.session.pageId, root);
});
test('refuses foreign pages, disconnected cursors and incomplete ancestry', () => {
  assert.throws(() => canonicalGuestProgress(input(), pages(), 'other-book'));
  assert.throws(() => canonicalGuestProgress({ ...input(), session: { pageId: foreign, frontierPageId: tip } }, pages(), 'book'));
  assert.throws(() => canonicalGuestProgress(input(), pages().slice(1), 'book'));
});
test('refuses forged action identity, absent destinations and incomplete choices', () => {
  const forged = input(); forged.actions[0]!.actionId = 'Invented choice';
  assert.throws(() => canonicalGuestProgress(forged, pages(), 'book'));
  const changed = pages(); changed[0]!.actions[0]!.destinationPageIds = [];
  assert.throws(() => canonicalGuestProgress(input(), changed, 'book'));
  assert.throws(() => canonicalGuestProgress({ ...input(), actions: [] }, pages(), 'book'));
});

const boundedInput = (): GuestProgressImport => input();
const snapshot = (changes: Partial<GuestProgressState> = {}): GuestProgressState => ({
  pageId: tip, updatedAt: new Date('2026-10-19T06:00:00.000Z'),
  frontierPageId: tip, frontierPageNumber: 2, frontierAncestorIds: [root],
  lastGuestImportId: operation, lastGuestImportHash: 'hash', ...changes,
});

test('V1 requires an operation key and explicit marker in replacement consent', () => {
  assert.deepEqual(parseGuestProgressImport(boundedInput()), boundedInput());
  assert.throws(() => parseGuestProgressImport({ ...boundedInput(), operationId: undefined }));
  assert.throws(() => parseGuestProgressImport({ ...boundedInput(), importVersion: 2 }));
  assert.throws(() => parseGuestProgressImport({ ...boundedInput(), expectedSession: { pageId: root, updatedAt: '2026-10-19T00:00:00Z' } }));
  assert.doesNotThrow(() => parseGuestProgressImport({ ...boundedInput(), expectedSession: { pageId: root, updatedAt: '2026-10-19T00:00:00Z', lastGuestImportId: null } }));
});

test('lost response retry confirms current progress after normal reading, without a historical result', () => {
  const current = snapshot({ pageId: foreign, frontierPageId: foreign, frontierPageNumber: 30 });
  const result = resolveGuestImport(boundedInput(), 'hash', current);
  assert.equal(result?.sessionApplied, true);
  assert.equal(result?.alreadyApplied, true);
  assert.equal(result?.session?.pageId, foreign);
  assert.equal(current.pageId, foreign);
});

test('same operation with different content or method is refused', async () => {
  const original = boundedInput();
  const hash = await guestImportFingerprint(original);
  const current = snapshot({ lastGuestImportHash: hash });
  const changed = { ...original, pageIds: [root] };
  assert.equal(resolveGuestImport(changed, await guestImportFingerprint(changed), current)?.reason, 'operation_mismatch');
  assert.equal(resolveGuestImport({ ...original, session: { pageId: tip, frontierPageId: tip } },
    await guestImportFingerprint({ ...original, session: { pageId: tip, frontierPageId: tip } }), current)?.reason, 'operation_mismatch');
});

test('newer import replaces the one marker and old recovery becomes a terminal conflict', () => {
  assert.equal(resolveGuestImport(boundedInput(), 'hash', snapshot({ lastGuestImportId: nextOperation }))?.sessionApplied, false);
});

test('reset or legacy action mutation invalidates prior confirmation', () => {
  const reset = snapshot({ ...clearedGuestImportMarker, pageId: root,
    updatedAt: new Date('2026-10-19T06:00:00.001Z') });
  assert.equal(resolveGuestImport(boundedInput(), 'hash', reset)?.reason, 'conflict');
});

test('replacement binds page, timestamp and previous import marker, even when cursor is unchanged', () => {
  const original = boundedInput();
  const current = snapshot();
  original.expectedSession = { pageId: tip, updatedAt: current.updatedAt.toISOString(), lastGuestImportId: operation };
  original.operationId = nextOperation;
  assert.equal(resolveGuestImport(original, 'new-hash', current), null);
  assert.equal(resolveGuestImport(original, 'new-hash', snapshot({ lastGuestImportId: null }))?.reason, 'conflict');
  assert.equal(resolveGuestImport(original, 'new-hash', snapshot({ pageId: foreign }))?.reason, 'conflict');
  assert.equal(resolveGuestImport(original, 'new-hash', snapshot({ updatedAt: new Date('2026-10-19T06:00:01Z') }))?.reason, 'conflict');
});

test('concurrent first-create winner is confirmed only for the identical command', () => {
  assert.equal(resolveGuestImport(boundedInput(), 'hash', undefined), null);
  assert.equal(resolveGuestImport(boundedInput(), 'hash', snapshot())?.alreadyApplied, true);
  assert.equal(resolveGuestImport(boundedInput(), 'hash', snapshot({ lastGuestImportId: nextOperation }))?.reason, 'conflict');
});

test('missing current pages are refused', () => {
  assert.equal(resolveGuestImport(boundedInput(), 'hash', snapshot({ frontierPageId: null }))?.sessionApplied, false);
});
