/**
 * Page Reactions — emoji whitelist (server-side authority).
 *
 * This is the SINGLE source of truth the backend validates against before
 * persisting a reaction. The set must stay identical to the frontend's
 * `src/lib/config/reactions.ts`. `emoji` values are STABLE STRING IDS (not the
 * display glyph) so a later visual re-skin is a pure frontend change.
 *
 * Ordered low→high intensity to match the UI row.
 */

export const REACTION_IDS = [
  'shocked',
  'mind-blown',
  'emotional',
  'tense',
  'loved',
  'peak',
] as const;

export type ReactionEmojiId = (typeof REACTION_IDS)[number];

/** True when `value` is one of the accepted reaction ids. */
export function isValidReactionEmoji(value: unknown): value is ReactionEmojiId {
  return typeof value === 'string' && (REACTION_IDS as readonly string[]).includes(value);
}

/** Human-friendly list for validation error messages. */
export function reactionIdList(): string {
  return REACTION_IDS.join(', ');
}