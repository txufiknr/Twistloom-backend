export const writingPresets = [
  'default',
  'stine',
  'king',
  'slow-burn',
  'action',
  'cinematic',
  'dialogue',
  'experimental',
] as const;

export type WritingPreset = typeof writingPresets[number];

/**
 * Presets that require an active VIP subscription to select.
 *
 * NOTE: MUST stay in 1:1 synchronization with frontend
 * `Twistloom-web/src/lib/config/story.ts` (`VIP_ONLY_WRITING_PRESETS`).
 */
export const VIP_ONLY_WRITING_PRESETS = [
  'king',
  'action',
  'cinematic',
  'experimental',
] as const;

export type VipWritingPreset = typeof VIP_ONLY_WRITING_PRESETS[number];

/**
 * Returns whether a given writing preset identifier is restricted to VIP users.
 * Keep in 1:1 synchronization with frontend `isWritingPresetVipOnly`.
 */
export function isWritingPresetVipOnly(preset: string): boolean {
  return (VIP_ONLY_WRITING_PRESETS as readonly string[]).includes(preset);
}

/**
 * Advanced generation options — controls story personality, AI sampling, and
 * developer-level knobs. Mirrors the frontend `AdvancedOptionsConfig` shape.
 */
export interface AdvancedOptionsConfig {
  writingPreset: WritingPreset;
  creativity: number;
  repetitionControl: number;
  developer: {
    temperature?: number; // ⚠ Overrides Creativity
    topP?: number; // ⚠ Overrides Creativity
    seed?: number;
    promptAppend?: string;
  };
}