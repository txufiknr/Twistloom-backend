import { sanitizeText } from './text-processing.js';
import type {
  WallChronologicalCursor,
  WallCursor,
  WallDiscoverCursor,
  WallProfileCursor,
} from '../types/wall.js';
import { WALL_LIMITS } from '../types/wall.js';
import { isValidUuid } from './uuid.js';

const WALL_CURSOR_VERSION = 1;
const URL_SCHEME_PATTERN = /(?:https?|ftp):\/\//iu;
const PROTOCOL_PATTERN = /\b(?:https?|ftp|mailto|javascript|data|file|tel):/iu;
const WWW_PATTERN = /(?:^|[\s(])www\./iu;
const EMAIL_PATTERN = /\b[^\s@]+@[^\s@]+\.[a-z]{2,}\b/iu;
const DOMAIN_PATTERN = /(?:^|[\s(])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:com|net|org|io|co|app|dev|me|tv|gg|id|xyz|info|site|online|link|ly)(?=$|[\s/:),.!?])/iu;

/** Normalizes a Wall text field before validation and persistence. */
export function normalizeWallContent(value: string): string {
  const normalized = value
    .normalize('NFC')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '')
    .replace(/\n{3,}/gu, '\n\n');

  return sanitizeText(normalized, { preserveNewlines: true }).normalize('NFC').trim();
}

/** Counts user-perceived Unicode characters rather than UTF-16 code units. */
export function countWallGraphemes(value: string): number {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let count = 0;

  for (const _segment of segmenter.segment(value)) {
    count += 1;
  }

  return count;
}

/** Detects link-like content that V1 intentionally rejects. */
export function containsExternalWallLink(value: string): boolean {
  const normalized = value.normalize('NFKC');
  return URL_SCHEME_PATTERN.test(normalized)
    || PROTOCOL_PATTERN.test(normalized)
    || WWW_PATTERN.test(normalized)
    || EMAIL_PATTERN.test(normalized)
    || DOMAIN_PATTERN.test(normalized);
}

/** Encodes a validated cursor as an opaque, versioned base64url token. */
export function encodeWallCursor(cursor: WallCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** Decodes a strictly shaped Wall cursor. Invalid input returns null. */
export function decodeWallCursor(value: string | undefined): WallCursor | null {
  if (!value || value.length > WALL_LIMITS.maximumCursorLength) {
    return null;
  }

  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(decoded);

    if (!isRecord(parsed)
      || parsed.version !== WALL_CURSOR_VERSION
      || typeof parsed.kind !== 'string'
      || typeof parsed.createdAt !== 'string'
      || !isValidIsoDate(parsed.createdAt)
      || !isValidUuid(parsed.id)) {
      return null;
    }

    if (parsed.kind === 'chronological' && hasOnlyKeys(parsed, ['version', 'kind', 'createdAt', 'id'])) {
      const cursor: WallChronologicalCursor = {
        version: WALL_CURSOR_VERSION,
        kind: 'chronological',
        createdAt: parsed.createdAt,
        id: parsed.id,
      };
      return cursor;
    }

    if (parsed.kind === 'discover'
      && typeof parsed.score === 'number'
      && Number.isSafeInteger(parsed.score)
      && parsed.score >= 0
      && hasOnlyKeys(parsed, ['version', 'kind', 'score', 'createdAt', 'id'])) {
      const cursor: WallDiscoverCursor = {
        version: WALL_CURSOR_VERSION,
        kind: 'discover',
        score: parsed.score,
        createdAt: parsed.createdAt,
        id: parsed.id,
      };
      return cursor;
    }

    if (parsed.kind === 'profile'
      && (parsed.pinnedRank === 0 || parsed.pinnedRank === 1)
      && hasOnlyKeys(parsed, ['version', 'kind', 'pinnedRank', 'createdAt', 'id'])) {
      const cursor: WallProfileCursor = {
        version: WALL_CURSOR_VERSION,
        kind: 'profile',
        pinnedRank: parsed.pinnedRank,
        createdAt: parsed.createdAt,
        id: parsed.id,
      };
      return cursor;
    }
  } catch {
    return null;
  }

  return null;
}

/** Creates the canonical cursor for a chronological result row. */
export function createWallChronologicalCursor(createdAt: Date, id: string): string {
  return encodeWallCursor({
    version: WALL_CURSOR_VERSION,
    kind: 'chronological',
    createdAt: createdAt.toISOString(),
    id,
  });
}

/** Creates the canonical cursor for a ranked Discover result row. */
export function createWallDiscoverCursor(score: number, createdAt: Date, id: string): string {
  return encodeWallCursor({
    version: WALL_CURSOR_VERSION,
    kind: 'discover',
    score,
    createdAt: createdAt.toISOString(),
    id,
  });
}

/** Creates the pinned-first cursor used by profile Wall pagination. */
export function createWallProfileCursor(
  pinnedRank: 0 | 1,
  createdAt: Date,
  id: string,
): string {
  return encodeWallCursor({
    version: WALL_CURSOR_VERSION,
    kind: 'profile',
    pinnedRank,
    createdAt: createdAt.toISOString(),
    id,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidIsoDate(value: string): boolean {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}
