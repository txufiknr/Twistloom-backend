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

export function sanitizeEditorPreferences(body: unknown): EditorPrefs | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;

  const record = body as Record<string, unknown>;
  const background = record.background;
  const fontFamily = record.fontFamily;
  const fontSize = record.fontSize;
  const textColor = record.textColor;
  const lineHeight = record.lineHeight;
  const contentWidth = record.contentWidth;

  if (
    !isEditorBackground(background) ||
    !isEditorFontFamily(fontFamily) ||
    !isEditorFontSize(fontSize) ||
    typeof textColor !== 'string' ||
    textColor.trim().length === 0 ||
    !isEditorLineHeight(lineHeight) ||
    !isEditorContentWidth(contentWidth)
  ) {
    return null;
  }

  return {
    background,
    fontFamily,
    fontSize,
    textColor: textColor.trim(),
    lineHeight,
    contentWidth,
  };
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
  preferences: EditorPrefs,
): Promise<EditorPrefs | null> {
  const [row] = await dbWrite
    .update(users)
    .set({ editorPrefs: normalizeEditorPreferences(preferences), updatedAt: new Date() })
    .where(eq(users.userId, userId))
    .returning({ editorPrefs: users.editorPrefs });

  return row?.editorPrefs ? normalizeEditorPreferences(row.editorPrefs) : null;
}
