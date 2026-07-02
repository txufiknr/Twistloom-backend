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
 * Advanced generation options — controls story personality, AI sampling, and
 * developer-level knobs. Mirrors the frontend `AdvancedOptionsConfig` shape.
 */
export interface AdvancedOptionsConfig {
  writingPreset: WritingPreset;
  creativity: number; // TODO: where and how to use this?
  repetitionControl: number; // TODO: where and how to use this?
  developer: {
    temperature?: number;
    topP?: number;
    seed?: number | null; // TODO: where and how to use this?
    promptAppend?: string;
  };
}