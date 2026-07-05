import { MIN_TEMPERATURE, MAX_TEMPERATURE, MIN_TOP_P, MAX_TOP_P, MIN_TOP_K, MAX_TOP_K, MIN_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS } from "../config/story.js";
import type { AIChatConfig } from "../types/ai-chat.js";
import type { AdvancedOptionsConfig } from "../types/book-creation.js";

/**
 * The target temperature range derived from the creativity slider (0–1).
 *
 * When a user adjusts `creativity` in the frontend, it maps linearly
 * into this range.  These constants **must** stay in sync with
 * `src/lib/utils/ai-sampling.ts` in the frontend project.
 */
const TEMPERATURE_RANGE = { min: 0.75, max: 1.15 } as const;

/**
 * The target top-p range derived from the creativity slider (0–1).
 *
 * Same contract as {@link TEMPERATURE_RANGE}; keep in sync with
 * `src/lib/utils/ai-sampling.ts` in the frontend.
 */
const TOP_P_RANGE = { min: 0.88, max: 0.98 } as const;

// ---------------------------------------------------------------------------
// Interpolation helpers
// ---------------------------------------------------------------------------

/**
 * Linearly interpolates between `min` and `max` by factor `t`.
 *
 * @param min - Lower bound of the range
 * @param max - Upper bound of the range
 * @param t   - Interpolation factor, typically clamped to [0, 1]
 * @returns The interpolated value: `min + (max - min) * t`
 *
 * @example
 * ```typescript
 * lerp(0, 10, 0.5) // → 5
 * lerp(0.75, 1.15, 0.8) // → 1.07
 * ```
 */
export function lerp(min: number, max: number, t: number): number {
  return min + (max - min) * t;
}

/**
 * Inverse of {@link lerp}: given a `value` inside [`min`, `max`], returns
 * the factor `t` that would produce that value.
 *
 * The result is clamped to [0, 1].
 *
 * @param min   - Lower bound of the range
 * @param max   - Upper bound of the range
 * @param value - The value to reverse-map into [min, max]
 * @returns A factor in [0, 1] representing where `value` lies in the range
 *
 * @example
 * ```typescript
 * inverseLerp(0.75, 1.15, 0.95) // → 0.5
 * inverseLerp(0.88, 0.98, 0.93) // → 0.5
 * ```
 */
export function inverseLerp(min: number, max: number, value: number): number {
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

// ---------------------------------------------------------------------------
// Creativity ↔ sampling round-trip  (frontend–backend contract)
// ---------------------------------------------------------------------------

/**
 * Converts a user-facing `creativity` value (0–1) into the corresponding
 * `temperature` and `topP` sampling parameters.
 *
 * This is the **forward** mapping used by the frontend's AI configuration
 * panel.  The backend guarantees it produces the exact same values so that
 * sampling is deterministic from the same creativity slider position.
 *
 * @param creativity - Normalised creativity level in [0, 1]
 * @returns An object with `temperature` and `topP` ready for the AI pipeline
 *
 * @example
 * ```typescript
 * creativityToSampling(0.5)
 * // → { temperature: 0.95, topP: 0.93 }
 * ```
 */
export function creativityToSampling(creativity: number): {
  temperature: number;
  topP: number;
} {
  return {
    temperature: lerp(TEMPERATURE_RANGE.min, TEMPERATURE_RANGE.max, creativity),
    topP: lerp(TOP_P_RANGE.min, TOP_P_RANGE.max, creativity),
  };
}

/**
 * Reverse-maps `temperature` and `topP` back to the single `creativity`
 * value that would produce them via {@link creativityToSampling}.
 *
 * The weighted blend (70% temperature / 30% topP) reflects the heuristic
 * that temperature dominates the creative feel.  This is useful when
 * reading existing AI configs that were stored without an explicit
 * creativity field.
 *
 * @param temperature - Current sampling temperature (expected range 0.75–1.15)
 * @param topP        - Current top-p value (expected range 0.88–0.98)
 * @returns A normalised creativity value in [0, 1]
 *
 * @example
 * ```typescript
 * samplingToCreativity(0.95, 0.93)
 * // → ~0.50
 * ```
 */
export function samplingToCreativity(
  temperature: number,
  topP: number,
): number {
  const temperatureFactor = inverseLerp(
    TEMPERATURE_RANGE.min,
    TEMPERATURE_RANGE.max,
    temperature,
  );
  const topPFactor = inverseLerp(
    TOP_P_RANGE.min,
    TOP_P_RANGE.max,
    topP,
  );
  return temperatureFactor * 0.7 + topPFactor * 0.3;
}

// ---------------------------------------------------------------------------
// Backend advanced-options pipeline
// ---------------------------------------------------------------------------

/**
 * Validates (and silently clamps) AI sampling parameters against the
 * global minimum/maximum bounds defined in the config.
 *
 * All AI configs that enter the generation pipeline should pass through
 * this function so that downstream provider-adapters never receive
 * out-of-range values.
 *
 * @param config - The AI chat config to validate (mutated in place)
 * @returns The same config reference after clamping
 */
export function validateAIConfig(config: AIChatConfig): AIChatConfig {
  if (config.temperature < MIN_TEMPERATURE) {
    console.warn(
      "[validateAIConfig] ⚠️ Temperature too low, clamping to",
      MIN_TEMPERATURE,
    );
    config.temperature = MIN_TEMPERATURE;
  } else if (config.temperature > MAX_TEMPERATURE) {
    console.warn(
      "[validateAIConfig] ⚠️ Temperature too high, clamping to",
      MAX_TEMPERATURE,
    );
    config.temperature = MAX_TEMPERATURE;
  }

  if (config.topP < MIN_TOP_P) {
    console.warn(
      "[validateAIConfig] ⚠️ topP too low, clamping to",
      MIN_TOP_P,
    );
    config.topP = MIN_TOP_P;
  } else if (config.topP > MAX_TOP_P) {
    console.warn(
      "[validateAIConfig] ⚠️ topP too high, clamping to",
      MAX_TOP_P,
    );
    config.topP = MAX_TOP_P;
  }

  if (config.topK < MIN_TOP_K) {
    console.warn(
      "[validateAIConfig] ⚠️ topK too low, clamping to",
      MIN_TOP_K,
    );
    config.topK = MIN_TOP_K;
  } else if (config.topK > MAX_TOP_K) {
    console.warn(
      "[validateAIConfig] ⚠️ topK too high, clamping to",
      MAX_TOP_K,
    );
    config.topK = MAX_TOP_K;
  }

  if (config.maxOutputToken < MIN_OUTPUT_TOKENS) {
    console.warn(
      "[validateAIConfig] ⚠️ maxOutputToken too low, clamping to",
      MIN_OUTPUT_TOKENS,
    );
    config.maxOutputToken = MIN_OUTPUT_TOKENS;
  } else if (config.maxOutputToken > MAX_OUTPUT_TOKENS) {
    console.warn(
      "[validateAIConfig] ⚠️ maxOutputToken too high, clamping to",
      MAX_OUTPUT_TOKENS,
    );
    config.maxOutputToken = MAX_OUTPUT_TOKENS;
  }

  return config;
}

/**
 * Resolves user-facing advanced generation options into the normalised
 * sampling configuration consumed by the AI generation pipeline.
 *
 * **Resolution order:**
 * 1. User-friendly controls (`creativity`, `repetitionControl`) are mapped
 *    to provider-agnostic sampling values.
 * 2. Explicit developer overrides (`developer.temperature`, `developer.topP`,
 *    `developer.seed`) replace the derived values when present.
 *
 * This keeps the user-experience simple while still allowing power-users
 * to precisely control model sampling.  The returned config is intentionally
 * provider-neutral; provider adapters are responsible for translating these
 * values into the parameters supported by each LLM API.
 *
 * **Frontend alignment:**
 * - `temperature` & `topP` are derived using the same `lerp` calls and
 *   the same range constants as `creativityToSampling()` in the frontend.
 * - If `developer.temperature` / `developer.topP` is provided, it acts as
 *   a direct override (the frontend treats this as "manual mode").
 *
 * @param config - The advanced options configuration from the user
 * @returns An object containing the resolved sampling parameters
 *
 * @example
 * ```typescript
 * // Default (creativity = 0.5, repetitionControl = 0.5)
 * mapAdvancedOptionsConfig({ writingPreset: "default", creativity: 0.5, repetitionControl: 0.5, developer: {} })
 * // → { frequencyPenalty: 0.65, temperature: 0.95, topP: 0.93, seed: undefined }
 *
 * // Developer override
 * mapAdvancedOptionsConfig({ writingPreset: "default", creativity: 0.5, repetitionControl: 0.5, developer: { temperature: 1.2 } })
 * // → { frequencyPenalty: 0.65, temperature: 1.2, topP: 0.93, seed: undefined }
 * ```
 */
export function mapAdvancedOptionsConfig(
  config: AdvancedOptionsConfig,
): Omit<AIChatConfig, "topK" | "maxOutputToken"> {
  const creativity =
    typeof config.creativity === "number" ? config.creativity : 0.5;
  const repetitionControl =
    typeof config.repetitionControl === "number" ? config.repetitionControl : 0.5;
  const developer = config.developer || {};

  return {
    frequencyPenalty: lerp(0, 1.3, repetitionControl),
    temperature: developer.temperature ?? lerp(0.75, 1.15, creativity),
    topP: developer.topP ?? lerp(0.88, 0.98, creativity),
    seed: developer.seed ?? undefined,
  };
}

/**
 * Merges advanced options (creativity, repetitionControl, temperature, topP,
 * seed) into a base AI chat config.
 *
 * Returns a new object — the original `config` is never mutated.
 *
 * **Resolution chain:**
 * 1. Start with a shallow copy of `config`.
 * 2. Call {@link mapAdvancedOptionsConfig} to resolve user-friendly controls
 *    and developer overrides.
 * 3. Overlay the resolved values onto the copy.
 * 4. Run {@link validateAIConfig} to clamp everything to safe bounds.
 *
 * @param config          - The base AI chat configuration
 * @param advancedOptions - Optional user-facing advanced options
 * @returns A new AI chat configuration with all adjustments applied
 *
 * @example
 * ```typescript
 * const base: AIChatConfig = { temperature: 0.9, topP: 0.92, topK: 40, maxOutputToken: 2000 };
 * applyAdvancedOptions(base, { writingPreset: "default", creativity: 0.8, repetitionControl: 0.3, developer: {} });
 * // → { temperature: 1.07, topP: 0.96, topK: 40, maxOutputToken: 2000, frequencyPenalty: 0.39 }
 * ```
 */
export function applyAdvancedOptions(
  config: AIChatConfig,
  advancedOptions?: AdvancedOptionsConfig,
): AIChatConfig {
  if (!advancedOptions) return { ...config };

  const mapped = mapAdvancedOptionsConfig(advancedOptions);
  const result = { ...config, ...mapped };

  return validateAIConfig(result);
}
