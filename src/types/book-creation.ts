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
  creativity: number;
  repetitionControl: number;
  developer: {
    temperature?: number;
    topP?: number;
    seed?: number | null;
    promptAppend?: string;
  };
}