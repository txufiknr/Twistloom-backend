import type { KnownGender } from "./user.js";

/**
 * Star Tier rating for collected narrative characters.
 *
 * In Twistloom, Star Tier represents not merely rarity or drop probability,
 * but fundamental narrative value:
 * - 5★: "Complex Catalysts & Apex Minds" — extraordinary intellect (IQ 150+), supreme
 *   narrative influence, deep subconscious trauma, signature plot twists, and
 *   captivating aesthetic presence / charisma.
 * - 4★: "Grounded Specialists & Compelling Archetypes" — hyper-competent domain experts,
 *   quirky specialists, sharp-witted survivors, and distinct atmospheric personalities.
 */
export type StarTier = 4 | 5;

/** Origin source of the cast template. */
export type CastSourceType = 'platform' | 'creator' | 'licensed' | 'community';

/** Discovery visibility in public catalog queries. */
export type CastDiscoveryVisibility = 'public' | 'unlisted' | 'campaign_only';

/** Template lifecycle publication status. */
export type CastStatus = 'draft' | 'in_review' | 'published' | 'suspended' | 'withdrawn';

/**
 * Pronoun declension set for dynamic prompt and narrative injection.
 */
export interface CastPronouns {
  subject: string;
  object: string;
  possessiveAdjective: string;
  possessivePronoun?: string;
  reflexive?: string;
}

/**
 * Multi-dimensional value metrics quantifying a character's narrative impact.
 *
 * Rather than combat statistics, these measure psychological weight,
 * cognitive acuity, personal magnetism, and plot disruption capability.
 */
export interface CastHighValueMetrics {
  /** Cognitive acuity, deductive reasoning, analytical mastery (Scale 1-100; 5★ typically 90-100 / IQ 150+). */
  intellect: number;
  /** Kinetic capability, tactical lethality, or systemic authority (Scale 1-100). */
  power: number;
  /** Charm, aesthetic elegance, handsomeness/prettiness, hypnotic presence (Scale 1-100). */
  magnetism: number;
  /** Psychological endurance against horror, panic, and gaslighting (Scale 1-100). */
  resilience: number;
  /** Societal, organizational, or black-market reach (Scale 1-100). */
  influence: number;
  /** Summary of why this character commands immense narrative value in any book. */
  valueSummary: string;
}

/**
 * Unique idiosyncratic personal traits, linguistic habits, and quirks.
 */
export interface CastDistinctCharacteristics {
  /** Distinct cadence, dialect, rhythmic delivery, or professional vocabulary. */
  languageStyle: string;
  /** Signature slang terms, idioms, or recurring catchphrases. */
  slangAndCatchphrases: string[];
  /** Eccentric personal hobbies, obsessive habits, or sensory fixations. */
  hobbiesAndQuirks: string[];
  /** Visual signature, color palette, aroma, or distinguishing talisman. */
  aestheticMotif: string;
}

/**
 * Voice guidelines and authentic dialogue samples for the AI prose engine.
 */
export interface CastVoice {
  /** High-level summary of voice tone and acoustic texture. */
  summary: string;
  /** Rules the LLM must follow when authoring dialogue or monologue for this character. */
  styleDirectives: string[];
  /** Illustrative dialogue lines demonstrating voice, slang, and perspective. */
  exampleLines: string[];
}

/**
 * Deep psychological profile used for narrative tension and character consistency.
 */
export interface CastPsychologicalProfile {
  /** Core yearning or primary objective. */
  motivation: string;
  /** Destructive habit, cognitive bias, or moral vulnerability. */
  flaw: string;
  /** Primal existential, situational, or psychological dread. */
  fear: string;
  /** Formative wound, memory overwrite, or haunting guilt. */
  trauma: string;
  /** Moral lines the character refuses to cross (or eagerly crosses). */
  moralBoundaries: string[];
  /** Hidden truth or confidential background unknown to casual acquaintances. */
  secret: string;
}

/**
 * Precise prompt injection payloads for the Pen AI engine.
 */
export interface CastPromptInjections {
  /** System prompt modifier injected when character is MC or scene focus. */
  systemDirective: string;
  /** Specific negative constraints and guardrails for dialogue generation. */
  dialogueGuardrails: string[];
  /** Guideline for rendering the character's thoughts and internal monologue. */
  internalMonologueStyle: string;
}

/**
 * Dramatic narrative revelation triggered at high tension.
 */
export interface CastSignatureTwist {
  /** Narrative condition or threshold that unlocks the twist. */
  triggerCondition: string;
  /** Dramatic revelation or escalation injected into the story branch. */
  revelation: string;
  /** Tension score percentage (0-100) at which this twist naturally activates. */
  tensionThreshold: number;
}

/**
 * Full static definition for one cast template (SSOT in `config/cast.ts`).
 */
export interface CastTemplateRule {
  /** Unique stable catalog identifier (e.g., 'cast_mara_reyes_5s'). */
  id: string;
  /** URL-friendly slug (e.g., 'mara-reyes'). */
  slug: string;
  /** Star tier classification: 5★ (Catalyst) or 4★ (Specialist). */
  starTier: StarTier;
  /** Full formal display name. */
  name: string;
  /** Common short name or callsign used in story state. */
  knownName: string;
  /** Narrative epithet / title (e.g., 'The Memory Broker'). */
  title: string;
  /** Character archetype / role classification. */
  archetype: string;
  /** Character gender. */
  gender: KnownGender;
  /** Age in years. */
  age: number;
  /** Grammatical pronouns. */
  pronouns: CastPronouns;
  /** One-line conceptual hook. */
  premise: string;
  /** Comprehensive narrative backstory and world origin. */
  biography: string;
  /** High-fidelity image generation prompt for avatar/portrait generation. */
  imagePrompt: string;
  /** High-value narrative and cognitive metrics. */
  highValueMetrics: CastHighValueMetrics;
  /** Distinct language, slang, hobbies, and quirks. */
  distinctCharacteristics: CastDistinctCharacteristics;
  /** Deep psychological profile and vulnerabilities. */
  psychologicalProfile: CastPsychologicalProfile;
  /** Voice directives and sample dialogue lines. */
  voice: CastVoice;
  /** System prompt and dialogue guardrails for AI generation. */
  promptInjections: CastPromptInjections;
  /** High-tension plot catalyst revelation. */
  signatureTwist: CastSignatureTwist;
  /** Active story objectives. */
  goals: string[];
  /** Specific thematic fears. */
  fears: string[];
  /** Character flaws. */
  flaws: string[];
  /** Core competencies and strengths. */
  strengths: string[];
  /** Behavioral boundaries. */
  boundaries: string[];
  /** Hooks for introducing the character into new scenes. */
  narrativeHooks: string[];
  /** Keywords that activate lore injection in Pen drafts. */
  triggerKeywords: string[];
  /** Compatible genres and tonal themes. */
  compatibilityTags: string[];
  /** Content warnings and sensitivity advisories. */
  contentWarnings: string[];
  /** Source ownership class. */
  sourceType: CastSourceType;
  /** Catalog visibility. */
  discoveryVisibility: CastDiscoveryVisibility;
  /** Current release status. */
  status: CastStatus;
  /** Semantic version of this template configuration. */
  version: number;
}
