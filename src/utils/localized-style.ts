/**
 * Language-specific tone and style constraints for the LLM system prompt.
 *
 * ## Background
 *
 * Drafted 2026-08 in response to a recurring quality problem: smaller/weaker
 * models in the nine-provider waterfall default to formal, "textbook
 * translation" register when writing non-English prose — e.g. Indonesian
 * output using "saya" and Bahasa Baku phrasing instead of the informal,
 * novelistic "aku" register a psychological thriller needs. See
 * TODO-stylistic-constraints-gemini.md for the original request/answer this
 * was drafted from.
 *
 * The first draft of this function was written directly into utils/story.ts
 * but never imported anywhere — dead code, exported but unreachable from any
 * actual generation call. This module is the live version: wired into the
 * user-turn prompt builders in utils/prompt.ts — `formatNextPageNarrativePrompt`
 * (unconditionally, both Turn A and Turn B) and `buildBookCreationPrompt`
 * (first page) — rather than the system prompt. That placement is
 * deliberate: `buildPresetSystemPrompt` is kept 100% static given
 * `(type, preset)` alone so it stays a single shared prompt-cache entry
 * across every language/book on the platform; per-language content lives in
 * the user turn instead, which was already fully dynamic (state, context)
 * and therefore never cached anyway. See `buildPresetSystemPrompt`'s JSDoc
 * for the full caching rationale.
 *
 * ## Design
 *
 * Two layers, concatenated:
 * 1. A universal baseline — evocative/novelistic tone, sensory language,
 *    varied sentence rhythm — applied to EVERY language, since "sounds like
 *    an AI assistant" is a failure mode independent of which language is
 *    being written.
 * 2. Language-specific negative constraints for languages where the base
 *    model's training data skews formal — naming the exact formal
 *    construction to avoid (e.g. Indonesian "saya", Japanese desu/masu)
 *    gives the model a concrete anti-pattern rather than a vague "be more
 *    casual" instruction, which is what makes this effective on cheaper/
 *    weaker models, not just top-tier ones.
 *
 * Unsupported language codes still get the universal baseline — there is no
 * "no constraints at all" case, only "baseline only" vs "baseline + overrides".
 */

/**
 * Returns the localized style constraint block for a given story language.
 *
 * @param languageCode - ISO 639-1 language code (e.g. 'en', 'id', 'es') —
 * matches `Book.language` / `StoryOutline.language`'s stored format.
 * @returns The style constraint prompt block. Always includes the universal
 * baseline; appends language-specific overrides when `languageCode` matches
 * a known case (currently id/es/fr/ja/ko/pt/de). Unknown/unsupported codes
 * (including 'en', which needs no anti-formality override) fall back to the
 * baseline alone — this is intentional, not a gap: every language benefits
 * from "write like a novelist," only some need a specific formality flag
 * fought back.
 *
 * @example
 * // Universal baseline + Indonesian overrides (forbids "saya", requires "aku")
 * getLocalizedStyleConstraints('id');
 *
 * @example
 * // Universal baseline only — no German-specific override defined (yet)
 * getLocalizedStyleConstraints('de');
 */
export function getLocalizedStyleConstraints(languageCode: string): string {
  const universalBaseline = `CRITICAL TONE & LOCALIZATION CONSTRAINTS:
- LITERARY PROSE: Write in a highly evocative, novelistic style suitable for a gritty thriller. STRICTLY AVOID formal, academic, standard, or "AI-sounding" rigid vocabulary.
- INFORMAL POV: The narrative voice must feel deeply personal and emotive. Never sound like a formal translator or assistant.
- SENSORY LANGUAGE: Favor visceral, concrete imagery over abstract description. Let the reader feel the cold, smell the decay, hear the silence.
- SENTENCE RHYTHM: Vary sentence length for pacing. Short punchy sentences for tension. Longer flowing sentences for dread. Never monotonous.`;

  let localizedOverrides = '';

  switch (languageCode.toLowerCase()) {
    case 'id':
      localizedOverrides = `
- INDONESIAN OVERRIDES: You are STRICTLY FORBIDDEN from using "Bahasa Baku" (formal Indonesian). Never use rigid phrasing like "Identik dengan saya" or "Saya merasa". You MUST use "aku" for first-person pronouns — never use "saya". Use contemporary novelistic Indonesian with visceral, poetic phrasing. Favor metaphorical expressions over literal descriptions. Use informal contractions and sentence fragments when they serve the emotional rhythm.`;
      break;

    case 'es':
      localizedOverrides = `
- SPANISH OVERRIDES: Use informal, visceral phrasing. Default to "tú" for internal monologue and casual dialogue — never "usted" unless the specific character dynamic demands formal address. Avoid sterile, textbook Spanish. Use regional idioms and concrete sensory language over abstract literary constructions.`;
      break;

    case 'fr':
      localizedOverrides = `
- FRENCH OVERRIDES: Write in modern, gritty literary style. Default to "tu" for internal thoughts and casual dialogue — avoid the formal "vous" unless contextually required. Use concrete, visceral imagery. Avoid bureaucratic or overly polite phrasing. Favor short, punchy sentences for tension over complex subordinate clauses.`;
      break;

    case 'ja':
      localizedOverrides = `
- JAPANESE OVERRIDES: AVOID polite/formal forms (Desu/Masu). Use casual, dramatic forms (Da/De aru) appropriate for psychological thriller inner monologue. First-person pronouns: use "boku" or "ore" for male MC, "watashi" or "atashi" for female MC — never the overly formal "watakushi". Use gritty, concrete imagery over abstract literary constructions.`;
      break;

    case 'ko':
      localizedOverrides = `
- KOREAN OVERRIDES: Use casual/dramatic verb endings (-다, -어/아) for internal monologue — avoid formal (-입니다/합니다) unless in formal dialogue. First-person: use "나" for casual narration, "나는" for emphasis — never the formal "저". Use visceral, concrete sensory language over abstract descriptions.`;
      break;

    case 'pt':
      localizedOverrides = `
- PORTUGUESE OVERRIDES: Use informal Brazilian Portuguese register. Default to "você" for second person — avoid "o senhor/a senhora". Use contractions (pra, pro) in dialogue. Favor visceral, concrete imagery over formal literary constructions. Use short sentences for tension.`;
      break;

    case 'de':
      localizedOverrides = `
- GERMAN OVERRIDES: Use "du" for internal monologue — never "Sie" unless formal dialogue is contextually required. Favor concrete, sensory language over abstract philosophical constructions. Use sentence fragments and em dashes for tension. Avoid overly complex compound sentences that slow pacing.`;
      break;

    // Add more languages as Twistloom expands. Each case should name the
    // specific formal construction to forbid (a pronoun, a verb register)
    // rather than a generic "be informal" — see module JSDoc above for why
    // that specificity is what makes this effective on weaker models.
  }

  return `${universalBaseline}${localizedOverrides}`.trim();
}
