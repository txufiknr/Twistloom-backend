import { eq } from 'drizzle-orm';
import { dbRead, dbWrite } from '../db/client.js';
import { users } from '../db/schema.js';
import { DEFAULT_EDITOR_PREFS, type EditorPrefs } from '../types/pen.js';

const BACKGROUND_OPTIONS = ['default', 'sepia', 'dark', 'light'] as const;
const FONT_FAMILY_OPTIONS = ['serif', 'sans', 'mono'] as const;
const CONTENT_WIDTH_OPTIONS = ['narrow', 'medium', 'wide'] as const;

function isEditorBackground(value: unknown): value is EditorPrefs['background'] {
  return typeof value === 'string' && BACKGROUND_OPTIONS.includes(value as EditorPrefs['background']);
}

function isEditorFontFamily(value: unknown): value is EditorPrefs['fontFamily'] {
  return typeof value === 'string' && FONT_FAMILY_OPTIONS.includes(value as EditorPrefs['fontFamily']);
}

function isEditorContentWidth(value: unknown): value is EditorPrefs['contentWidth'] {
  return typeof value === 'string' && CONTENT_WIDTH_OPTIONS.includes(value as EditorPrefs['contentWidth']);
}

export function normalizeEditorPreferences(
  raw: Partial<EditorPrefs> | null | undefined,
): EditorPrefs {
  return {
    background: raw?.background ?? DEFAULT_EDITOR_PREFS.background,
    fontFamily: raw?.fontFamily ?? DEFAULT_EDITOR_PREFS.fontFamily,
    fontSize: raw?.fontSize ?? DEFAULT_EDITOR_PREFS.fontSize,
    textColor: raw?.textColor ?? DEFAULT_EDITOR_PREFS.textColor,
    lineHeight: raw?.lineHeight ?? DEFAULT_EDITOR_PREFS.lineHeight,
    contentWidth: raw?.contentWidth ?? DEFAULT_EDITOR_PREFS.contentWidth,
  };
}

function isEditorFontSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 10 && value <= 72;
}

function isEditorLineHeight(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 3;
}

/**
 * Validate a requested update to `users.editorPrefs`.
 *
 * Accepts a PARTIAL object — only the fields the caller actually changed. Every
 * *provided* field is validated individually and must pass its own guard; a
 * field the caller omits is left untouched ({@link updateEditorPreferences}
 * merges the patch over the stored value, never over the defaults). Unknown
 * keys are ignored. Returns null when the body carries no valid editor field so
 * the route can 400 a no-op request.
 */
export function sanitizeEditorPreferences(body: unknown): Partial<EditorPrefs> | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;

  const record = body as Record<string, unknown>;
  const patch: Partial<EditorPrefs> = {};

  if (record.background !== undefined) {
    if (!isEditorBackground(record.background)) return null;
    patch.background = record.background;
  }

  if (record.fontFamily !== undefined) {
    if (!isEditorFontFamily(record.fontFamily)) return null;
    patch.fontFamily = record.fontFamily;
  }

  if (record.fontSize !== undefined) {
    if (!isEditorFontSize(record.fontSize)) return null;
    patch.fontSize = record.fontSize;
  }

  if (record.textColor !== undefined) {
    if (typeof record.textColor !== 'string' || record.textColor.trim().length === 0) return null;
    patch.textColor = record.textColor.trim();
  }

  if (record.lineHeight !== undefined) {
    if (!isEditorLineHeight(record.lineHeight)) return null;
    patch.lineHeight = record.lineHeight;
  }

  if (record.contentWidth !== undefined) {
    if (!isEditorContentWidth(record.contentWidth)) return null;
    patch.contentWidth = record.contentWidth;
  }

  if (Object.keys(patch).length === 0) return null;
  return patch;
}

export async function getEditorPreferences(userId: string): Promise<EditorPrefs | null> {
  const [row] = await dbRead
    .select({ editorPrefs: users.editorPrefs })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1);

  if (!row) return null;
  return normalizeEditorPreferences(row.editorPrefs);
}

export async function ensureDefaultEditorPreferences(userId: string): Promise<void> {
  const [row] = await dbRead
    .select({ editorPrefs: users.editorPrefs })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1);

  if (!row) return;
  if (row.editorPrefs != null) return;

  await dbWrite
    .update(users)
    .set({ editorPrefs: DEFAULT_EDITOR_PREFS, updatedAt: new Date() })
    .where(eq(users.userId, userId));
}

export async function updateEditorPreferences(
  userId: string,
  patch: Partial<EditorPrefs>,
): Promise<EditorPrefs | null> {
  // Read-modify-write: merge the patch over the CURRENT stored value, not the
  // defaults. A dirty-only update must never reset a field the client didn't
  // touch (e.g. sepia saved on another device) back to its default — the
  // caller's partial object is not a full picture of the user's preferences.
  const [row] = await dbRead
    .select({ editorPrefs: users.editorPrefs })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1);

  if (!row) return null;

  const merged = normalizeEditorPreferences({ ...row.editorPrefs, ...patch });

  const [updated] = await dbWrite
    .update(users)
    .set({ editorPrefs: merged, updatedAt: new Date() })
    .where(eq(users.userId, userId))
    .returning({ editorPrefs: users.editorPrefs });

  return updated?.editorPrefs ? normalizeEditorPreferences(updated.editorPrefs) : null;
}
