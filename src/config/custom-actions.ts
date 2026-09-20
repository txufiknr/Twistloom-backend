import type { StoryPhase } from "../types/story.js";

/**
 * Configuration constants for the custom actions system
 */

// ============================================================================
// GATE 0 — Eligibility & Rate Limits
// ============================================================================

/** Max custom-action attempts per page (free retries on rejection) */
export const CUSTOM_ACTION_MAX_ATTEMPTS_PER_PAGE = 3;

/** Max custom-action attempts per hour per user */
export const CUSTOM_ACTION_RATE_LIMIT_PER_HOUR = 10;

/** Story phases where custom actions are disabled */
export const CUSTOM_ACTION_DISABLED_PHASES: StoryPhase[] = ['FINALE'];

// ============================================================================
// GATE 1 — Deterministic Security Filter
// ============================================================================

/** Regex patterns to detect prompt injection / jailbreak attempts */
export const CUSTOM_ACTION_SECURITY_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  /reveal\s+.*(prompt|system|instructions)/i,
  /show\s+.*(system\s*prompt|hidden\s*state|raw\s*json)/i,
  /you\s+are\s+now/i,
  /pretend\s+(you('re|\s+are)|to\s+be)/i,
  /\b(assistant|system|developer)\s*:/i,
  /<\s*(system|assistant|developer)\s*>/i,
  /print\s+(the\s+)?(story\s*)?state/i,
  /reveal\s+(the\s+)?(hidden|viable)\s+ending/i,
] as const;

// ============================================================================
// CREATIVE EXPRESSION WHITELIST ENGINE
// ============================================================================

/**
 * Cross-genre creative whitelist patterns.
 *
 * These regex patterns match standard literary tropes across all fiction genres.
 * When a user action matches a whitelist pattern, it is explicitly recognized as
 * legitimate creative content and MUST NOT be flagged by Gate 1 denylist or Gate 2
 * content_policy rejection — even if individual keywords overlap with real-world
 * harm indicators.
 *
 * The whitelist is checked BEFORE the denylist in runGate1(), so a match short-circuits
 * the security filter entirely. This prevents false positives on:
 * - Fantasy combat ("attack the dragon", "cast a fireball")
 * - Horror investigation ("explore the dark room", "confront the ghost")
 * - Thriller action ("interrogate the suspect", "chase the fleeing figure")
 * - Drama/conflict ("confront the betrayal", "embrace the darkness")
 * - Historical warfare ("charge into battle", "storm the castle")
 */
export const CREATIVE_WHITELIST_PATTERNS: readonly RegExp[] = [
  // --- Fantasy & Sci-Fi ---
  /\b(attack|fight|battle|slay|defeat|confront|challenge|duel)\s+(the\s+)?(dragon|monster|beast|demon|orc|goblin|troll|giant|villain|enemy|foe|dark lord|shadow|creature|alien|robot|cyborg)/i,
  /\b(cast|use|channel|weave|summon)\s+(a\s+)?(spell|magic|enchantment|curse|hex|fireball|lightning|illusion|telekinesis|telepathy)/i,
  /\b(draw|wield|raise|unsheathe)\s+(my\s+)?(sword|blade|dagger|axe|staff|wand|bow|shield|weapon|lightsaber|laser)/i,
  /\b(ride|mount|summon)\s+(the\s+)?(dragon|horse|phoenix|griffin|steed|mount)/i,
  /\b(explore|enter|investigate|traverse|navigate)\s+(the\s+)?(dungeon|cave|labyrinth|ruins|portal|dimension|planet|ship|station|fortress)/i,
  /\b(craft|forge|enchant|imbue|brew)\s+(a\s+)?(potion|elixir|weapon|armor|tome|scroll|artifact|golem)/i,

  // --- Horror & Supernatural ---
  /\b(confront|face|challenge|resist|banish|exorcise)\s+(the\s+)?(ghost|spirit|demon|poltergeist|phantom|wraith|specter|haunting|curse|entity)/i,
  /\b(investigate|explore|search|enter|brave)\s+(the\s+)?(dark|haunted|abandoned|cursed|shadowy)\s+(room|house|mansion|forest|catacombs|tomb|asylum|chapel)/i,
  /\b(escape|flee|run|hide|retreat)\s+(from\s+)?(the\s+)?(monster|creature|shadow|darkness|horror|nightmare|apparition)/i,
  /\b(survive|endure|withstand|resist)\s+(the\s+)?(horror|terror|dread|darkness|madness|corruption|curse|nightmare)/i,
  /\b(stab|slash|strike|shoot|hit|punch|kick|stab|impale)\s+(the\s+)?(zombie|undead|ghoul|vampire|werewolf|creature|monster)/i,

  // --- Thriller & Mystery ---
  /\b(interrogate|question|confront|accuse|expose)\s+(the\s+)?(suspect|witness|traitor|spy|killer|murderer|deceiver|liar)/i,
  /\b(chase|pursue|hunt|track|follow|corner)\s+(the\s+)?(fleeing|escaping|running|suspect|target|prey|criminal|assassin)/i,
  /\b(search|examine|inspect|analyze|investigate)\s+(the\s+)?(clue|evidence|scene|body|witness|crime|murder|disappearance)/i,
  /\b(sneak|infiltrate|stealth|creep|slip|sneak)\s+(into|through|past|toward)\s+(the\s+)?(building|facility|compound|hideout|lair|office|vault)/i,
  /\b(set|lay|prepare)\s+(a\s+)?(trap|ambush|snare|decoy|diversion|distraction)/i,

  // --- Drama & Romance ---
  /\b(confront|challenge|defy|stand\s+up\s+to|resist)\s+(the\s+)?(betrayal|deception|manipulation|cruelty|tyrant|oppressor|authority)/i,
  /\b(confess|reveal|admit|declare|profess)\s+(my\s+)?(love|feelings|secret|truth|identity|past|intentions)/i,
  /\b(embrace|accept|face|confront|welcome)\s+(the\s+)?(darkness|truth|destiny|fate|challenge|journey|change|transformation)/i,
  /\b(betray|deceive|trick|manipulate|outwit)\s+(the\s+)?(enemy|antagonist|villain|guard|captor|opponent)/i,
  /\b(save|rescue|protect|defend|shield|guard)\s+(the\s+)?(child|hostage|village|kingdom|friend|ally|innocent|prisoner)/i,

  // --- Historical & Action ---
  /\b(charge|storm|besiege|assault|attack)\s+(the\s+)?(castle|fortress|gate|wall|army|enemy|position|stronghold)/i,
  /\b(lead|command|rally|unite|mobilize)\s+(the\s+)?(troops|army|allies|rebel|forces|people|resistance)/i,
  /\b(survive|endure|weather|withstand)\s+(the\s+)?(storm|battle|siege|blizzard|famine|plague|earthquake|flood)/i,

  // --- General creative conflict ---
  /\b(draw|ready|raise|unleash)\s+(my\s+)?(weapon|blade|power|magic|full\s+strength)/i,
  /\b(dodge|parry|block|deflect|evade)\s+(the\s+)?(attack|blow|strike|arrow|spell|bolt|projectile)/i,
  /\b(heal|treat|bandage|stabilize|revive)\s+(the\s+)?(wounded|injured|fallen|comrade|ally|friend|companion)/i,
] as const;

/**
 * Checks if a user's custom action text matches any creative whitelist pattern.
 * Returns true if the action is recognized as legitimate creative fiction content.
 */
export function matchesCreativeWhitelist(text: string): boolean {
  const trimmed = text.trim();
  return CREATIVE_WHITELIST_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** Denylist keywords for explicit content heuristic first pass */
export const CUSTOM_ACTION_DENYLIST_KEYWORDS: string[] = [];

/** Minimum characters for a custom action */
export const MIN_CUSTOM_ACTION_CHARS = 3;

/** Maximum characters for a custom action */
export const MAX_CUSTOM_ACTION_CHARS = 60;
export const MAX_CUSTOM_ACTION_CHARS_VIP = 120;

export const getMaxCustomActionChars = (isVip: boolean): number =>
  isVip ? MAX_CUSTOM_ACTION_CHARS_VIP : MAX_CUSTOM_ACTION_CHARS;

/**
 * Valid text pattern — rejects emoji, control characters, and most non-Latin-script noise.
 * Only allows Unicode letters, numbers, spaces, and basic punctuation.
 */
export const CUSTOM_ACTION_VALID_TEXT_PATTERN = /^[\p{L}\p{N}\s.,!?'"-]+$/u;

// ============================================================================
// GATE 2 — AI Interpreter Thresholds
// ============================================================================

/** Minimum plausibility score for 'allow' outcome (0-1) */
export const CUSTOM_ACTION_PLAUSIBILITY_THRESHOLD = 0.5;

/** Minimum progression score for 'allow' outcome (0-1) */
export const CUSTOM_ACTION_PROGRESSION_THRESHOLD = 0.5;

// ============================================================================
// REUSE — Template Pool
// ============================================================================

/** Cost for reusing a cached near-duplicate action (Tier 1) */
export const EXPANDED_COMMUNITY_ACTION_COST = 1;

// ============================================================================
// RATE LIMITING
// ============================================================================

/** Max actions per page — free retries */
export const CUSTOM_ACTION_MAX_ATTEMPTS_PER_PAGE_LIMIT = 3;
