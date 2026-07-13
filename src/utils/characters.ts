import { ACTION_SCORE_CAP, BODY_PART_WEIGHTS, DEFAULT_BODY_PART_IMPACT, FEAR_MENTAL_PENALTY, HEALTH_SCORE_CAP, INJURY_CATEGORY_WEIGHTS, MEMORY_INTEGRITY_MENTAL_PENALTY, MENTAL_SCORE_CAP, MOBILITY_SCORE_CAP, TRAUMA_TAG_MENTAL_WEIGHT } from "../config/characters.js";
import { CHARACTER_NAMES } from "../config/characters.js";
import { MAX_PAST_INTERACTIONS, MIN_CHARACTER_AGE, MAX_CHARACTER_AGE, MAX_CHARACTERS } from "../config/story.js";
import type { CharacterMemory, CharacterUpdate, CharacterUpdates, RelationshipUpdate, StoryMC, StoryMCCandidate, Injury, InjurySeverity, PastInteraction, HealthCondition, HealthStatus, MentalHealthInputs, BodyPartImpact, CharacterPlan } from "../types/character.js";
import type { StoryMCState, StoryState } from "../types/story.js";
import type { KnownGender } from "../types/user.js";
import { ucfirst } from "./formatter.js";
import { getStoryStateInfo } from "./story.js";
import { slugify } from "./text-processing.js";

// ============================================================================
// CHARACTER MEMORY MANAGEMENT SYSTEM
// ============================================================================

/**
 * Calculates the injury severity label based on severity and decay rate.
 *
 * Behaviour when `decayPerPage` is 0 or omitted (no healing):
 * - `severity > 0.5` → `'permanent'`    (structural damage that won't resolve)
 * - `severity ≤ 0.5` → `'requires_treatment'` (stable but needs care to improve)
 *
 * This default is intentional: if the AI doesn't supply a decay rate,
 * the injury is treated as non-healing until explicitly addressed.
 *
 * @param injury - Injury object with severity and decayPerPage
 * @returns Severity label: 'permanent', 'requires_treatment', 'critical',
 *          'severe', 'moderate', 'mild', or 'none'
 *
 * @example
 * ```typescript
 * getInjurySeverityLabel({ severity: 0.9, decayPerPage: 0.1 }); // 'critical'
 * getInjurySeverityLabel({ severity: 0.7, decayPerPage: 0.1 }); // 'severe'
 * getInjurySeverityLabel({ severity: 0.5, decayPerPage: 0 });   // 'requires_treatment'
 * getInjurySeverityLabel({ severity: 0.8, decayPerPage: 0 });   // 'permanent'
 * getInjurySeverityLabel({ severity: 0.3, decayPerPage: 0.05 });// 'mild'
 * ```
 */
export function getInjurySeverityLabel(injury: Injury): InjurySeverity {
  const { severity = 0.5, decayPerPage = 0 } = injury;
  if (decayPerPage === 0) {
    return severity > 0.5 ? 'permanent' : 'requires_treatment';
  }
  if (severity >= 0.8) return 'critical';
  if (severity >= 0.6) return 'severe';
  if (severity >= 0.4) return 'moderate';
  if (severity >= 0.2) return 'mild';
  return 'none';
}

// /**
//  * Creates a new character with default values
//  * 
//  * @param newCharacter - Character creation parameters including name, gender, role, bio, visualDescription, status, narrativeFlags, and relationshipToMC
//  * @returns New character memory structure
//  * 
//  * @example
//  * ```typescript
//  * const character = createCharacter({
//  *   name: "Lina",
//  *   gender: "female",
//  *   role: "best friend",
//  *   bio: "Cheerful but secretive",
//  *   visualDescription: "tall, pale, messy black hair, hollow eyes",
//  *   status: "trusting",
//  *   narrativeFlags: { potentialTwist: "none" },
//  *   relationshipToMC: { type: "friend", context: "Childhood best friend, incredibly loyal." }
//  * });
//  * ```
//  */
// export function createCharacter(
//   newCharacter: NewCharacter
// ): CharacterMemory {
//   const { status, narrativeFlags } = newCharacter;
//   return {
//     ...newCharacter,
//     relationships: [],
//     pastInteractions: [],
//     narrativeFlags: {
//       ...narrativeFlags,
//       potentialTwist: narrativeFlags.potentialTwist || (status === "suspicious" ? "betrayal" : "none")
//     },
//     injuries: [],
//   };
// }

/**
 * Updates an existing character with new information.
 *
 * Merges new interactions with existing ones, maintaining the sliding window.
 * Updates status and narrative flags as provided.
 *
 * @param existing - Current character memory
 * @param update - Update data from AI output
 * @param page - Current story page number
 * @param placeId - Optional place ID for interaction context
 * @returns Updated character memory
 *
 * @example
 * ```typescript
 * const updated = updateCharacter(existing, {
 *   status: "suspicious",
 *   newInteractions: ["Refused to explain what she saw"],
 *   narrativeFlags: { potentialTwist: "betrayal" }
 * }, page);
 * ```
 */
export function updateCharacter(existing: CharacterMemory, update: CharacterUpdate, page: number, placeId?: string): CharacterMemory {
  const updated: CharacterMemory = structuredClone(existing);
  const { updateTraits = [], removeTraits = [], updateSchedules = [], removeSchedules = [] } = update;
  const { traits = [], schedules = [] } = existing;

  // Update basic properties if provided
  if (update.knownName) updated.knownName = update.knownName;
  if (update.recognitionLevel) updated.recognitionLevel = update.recognitionLevel;
  if (update.gender) updated.gender = update.gender;
  if (update.role) updated.role = update.role;
  if (update.bio) updated.bio = update.bio;
  if (update.visualDescription) updated.visualDescription = update.visualDescription;
  if (update.status) updated.status = update.status;
  if (update.secrets) updated.secrets = update.secrets;
  if (update.importance) updated.importance = update.importance;
  if (update.relationshipToMC) updated.relationshipToMC = update.relationshipToMC;

  // Merge past interactions with sliding window
  if (update.newInteractions) {
    updated.pastInteractions = [
      ...existing.pastInteractions,
      ...update.newInteractions.map<PastInteraction>(i => ({ page, interaction: i, placeId }))
    ].slice(-MAX_PAST_INTERACTIONS);
  }

  // Merge narrative flags if provided
  if (update.narrativeFlags) {
    updated.narrativeFlags = {
      ...existing.narrativeFlags,
      ...update.narrativeFlags
    };
  }

  // Update traits if provided
  if (updateTraits.length) {
    updated.traits = [
      ...traits.filter(t => !updateTraits.some(u => u.key === t.key)),
      ...updateTraits
    ];
  }

  // Remove traits
  if (removeTraits.length) {
    updated.traits = [
      ...traits.filter(t => !removeTraits.includes(t.key)),
    ];
  }

  // Update schedules if provided
  if (updateSchedules.length) {
    updated.schedules = [
      ...schedules.filter(s => !updateSchedules.some(u => u.placeId === s.placeId)),
      ...updateSchedules
    ];
  }

  // Remove schedules
  if (removeSchedules.length) {
    updated.schedules = [
      ...schedules.filter(s => !removeSchedules.includes(s.placeId)),
    ];
  }

  // Replace entire injury array if provided
  if (update.injuries?.length) {
    updated.injuries = update.injuries;
  }

  return updated;
}

/**
 * Updates character relationship with new information.
 *
 * Creates new relationships or updates existing ones,
 * maintaining directional connections between characters.
 *
 * @param character - Source character to update
 * @param update - Relationship update data
 * @returns Updated character memory
 *
 * @example
 * ```typescript
 * updateRelationship(lina, { sourceId: "lina", targetId: "raka", status: "afraid", context: "..." });
 * ```
 */
export function updateRelationship(character: CharacterMemory, update: RelationshipUpdate): CharacterMemory {
  const updated: CharacterMemory = structuredClone(character);

  // Find existing relationship to target
  const existingIndex = updated.relationships.findIndex(r => r.targetId === update.targetId);

  if (existingIndex >= 0) {
    // Update existing relationship
    updated.relationships[existingIndex] = {
      ...updated.relationships[existingIndex],
      type: update.type || updated.relationships[existingIndex].type,
      status: update.status || updated.relationships[existingIndex].status,
      context: update.context || updated.relationships[existingIndex].context,
      recognitionLevel: update.recognitionLevel || updated.relationships[existingIndex].recognitionLevel,
    };
  } else if (updated.relationships.length < MAX_CHARACTERS - 1) {
    // Create new relationship
    updated.relationships.push({
      targetId: update.targetId,
      type: update.type || "knows",
      status: update.status || "neutral",
      context: update.context,
      recognitionLevel: update.recognitionLevel,
    });
  }

  return updated;
}

/**
 * Adds or updates characters in the story state.
 *
 * Processes AI output for new characters and updates, maintaining
 * the character dictionary structure.
 *
 * @param state - Current story state (mutated in place)
 * @param characterUpdates - New characters and updates from AI output
 * @param relationshipUpdates - Directional relationship changes to apply
 * @param placeId - Optional place ID providing context for new interactions
 *
 * @example
 * ```typescript
 * processCharacterUpdates(state, output.characterUpdates, output.relationshipUpdates, placeId);
 * ```
 */
export function processCharacterUpdates(
  state: StoryState,
  characterUpdates?: CharacterUpdates,
  relationshipUpdates?: RelationshipUpdate[],
  placeId?: string
): void {
  const { newCharacters = [], updatedCharacters = [] } = characterUpdates || {};

  // Early exit: if no updates to process
  if (!newCharacters.length && !updatedCharacters.length && !relationshipUpdates?.length) return;
  
  // Process character updates if they exist
  const { page } = state;

  // Add new characters
  if (newCharacters.length) {
    for (const character of newCharacters) {
      const characterId = character.characterId;
      state.characters[characterId] = {
        ...character,
        introducedAtPage: page,
        injuries: character.injuries ?? [],
        pastInteractions: character.pastInteractions?.map<PastInteraction>(i => ({ page, interaction: i, placeId })) ?? [],
        relationships: [], // Will be populated via relationshipUpdates
      };
      // Remove any matching planned character entries now that the character
      // has been introduced. Match by `characterId` to avoid removing
      // unrelated plans.
      if (state.plannedCharacters?.length) {
        state.plannedCharacters = state.plannedCharacters.filter(p => p.characterId !== characterId);
      }
    }
  }

  // Update existing characters
  if (updatedCharacters.length) {
    for (const update of updatedCharacters) {
      const updateId = update.characterId;
      const existing = state.characters[updateId];
      if (existing) {
        state.characters[updateId] = updateCharacter(existing, update, page, placeId);
      }
    }
  }

  // Process relationship updates
  if (relationshipUpdates?.length) {
    for (const relUpdate of relationshipUpdates) {
      const sourceCharacter = state.characters[relUpdate.sourceId];
      if (sourceCharacter) {
        state.characters[relUpdate.sourceId] = updateRelationship(sourceCharacter, relUpdate);
      }
    }
  }

  // Clear stale planned characters — no point keeping seeds for characters
  // that can no longer be introduced (late phase or no remaining slots).
  if (state.plannedCharacters?.length) {
    const { isLatePhase } = getStoryStateInfo(state);
    const charactersSlot = MAX_CHARACTERS - Object.keys(state.characters).length;
    if (isLatePhase || charactersSlot <= 0) {
      state.plannedCharacters = [];
    }
  }
}

/**
 * Gets formatted main character information for AI prompt injection.
 *
 * Outputs a compact MC status block including bio, health, mobility, action
 * capability, mental state, inventory, and injuries.
 *
 * @param params.mc - Main character profile
 * @param params.state - Current MC state with inventory, injuries, and healthStatus
 * @returns Formatted string ready for prompt inclusion, or null if no data
 * 
 * @example
 * // Basic character without state
 * "Lisa Carter, female, 16 — Shy teenager with social anxiety."
 *
 * @example
 * // Character with inventory and injuries
 * - Bio: Lisa Carter ("Lisa"), female, 16 — Shy teenager with social anxiety.
 * - Condition: wounded
 * - Health: 58%
 * - Mobility: 34%
 * - Action Capability: 62%
 * - Mental State: 71%
 * - Inventory:
 *   - 1x Cellphone (right pants pocket, color: black) - acquired: page 1
 *   - 1x Rugged rope (backpack, color: brown, length: 1m) - acquired: page 5 at Haunted House
 * - Injuries:
 *   - Deep cut (left arm, cut, severity: 0.7) - acquired: page 5 at Haunted House
 *     → Consequence (severe): Cannot lift heavy objects
 *   - Sprained ankle (right foot, exhaustion, severity: 0.4) - acquired: page 18 at School
 *     → Consequence (medium): Cannot run fast
 */
export function getMainCharacterInfo(params: {
  mc?: StoryMCCandidate | null,
  state?: StoryMCState
}): string | null {
  const { mc, state } = params;
  const { inventory = [], injuries = [], healthStatus } = state ?? {};
  const mcInfo: string[] = [];

  // Format main character's bio
  if (mc && !Object.values(mc).every((i) => i === undefined)) {
    const info = [`${mc.name}${mc.knownName ? ` ("${mc.knownName}")` : ''}`, mc.gender, mc.age].filter(Boolean).join(', ');
    mcInfo.push(`- Bio: ${info}${mc.bio ? ` — ${mc.bio}` : ''}`);
  }

  // Format main character's health status across all four axes.
  // When healthStatus is absent (e.g. no injuries yet), defaults communicate
  // a fully healthy MC to the AI rather than omitting the section entirely.
  const {
    condition       = 'healthy',
    healthPercent   = 100,
    mobilityPercent = 100,
    actionPercent   = 100,
    mentalPercent   = 100,
  } = healthStatus ?? {};

  mcInfo.push(`- Condition: ${condition}`);
  mcInfo.push(`- Health (Physical vitality): ${healthPercent}%`);
  mcInfo.push(`- Mobility (Flee/escape capability): ${mobilityPercent}%`);
  mcInfo.push(`- Action (Tool/hand use): ${actionPercent}%`);
  mcInfo.push(`- Mental State (Psychological integrity): ${mentalPercent}%`);

  // Format inventory items with detailed nested information
  if (inventory.length) {
    const inventoryList = inventory.map(item => {
      const parts = [];
      parts.push(`${item.amount}x`);
      parts.push(item.name);

      const traitEntries = item.traits?.map(t => `${t.key}: ${t.value}`) ?? [];
      const itemInfo = [item.where, ...traitEntries].filter(Boolean);

      let inventoryLine = `  - ${parts.join(' ')}`;
      if (itemInfo.length) inventoryLine += ` (${itemInfo.join(', ')})`;

      if (item.pageAcquired) inventoryLine += ` - acquired: page ${item.pageAcquired}`;
      return inventoryLine;
    });

    const inventoryDetails = `\n${inventoryList.join('\n')}`;
    mcInfo.push(`- Inventory: ${inventoryDetails}`);
  }

  // Format detailed injury information with nested bullet points
  if (injuries.length) {
    const injuryList = injuries.map(injury => {
      const parts = [];
      const injuryLocation = [injury.bodyPart, injury.category, injury.severity ? `severity: ${injury.severity}` : ''].filter(Boolean).join(', ');
      if (injury.description) parts.push(injury.description);
      if (injuryLocation) parts.push(`(${injuryLocation})`);
      if (injury.pageAcquired) parts.push(`- acquired: page ${injury.pageAcquired}${injury.placeId ? ` at ${injury.placeId}` : ''}`);

      let injuryLine = `  - ${parts.join(' ')}`;
      if (injury.consequences) {
        const injurySeverity = getInjurySeverityLabel(injury);
        injuryLine += `\n    → Consequences (${injurySeverity}): ${injury.consequences}`;
      }
      return injuryLine;
    });

    const injuryDetails = `\n${injuryList.join('\n')}`;
    mcInfo.push(`- Injuries: ${injuryDetails}`);
  }

  return mcInfo.length ? mcInfo.join('\n') : null;
}

/**
 * Formats characters for prompt injection with comprehensive narrative context.
 *
 * Creates a rich, detailed string representation of characters with clean
 * separation of physical state, emotional relationship, and plot mechanics.
 *
 * @param mc - Main character profile
 * @param characters - Record of character memories keyed by character ID
 * @returns Formatted string for prompt inclusion
 *
 * @example
 * ```
 * · Sarah Chen (MC) - 28 years old, female
 *   - Bio: Shy librarian with hidden past and mysterious family connections
 *   - Known as: Sarah
 * 
 * · Tom Martinez (security guard, major) - male [trusting] - [ID: tom_m]
 *   - Real name: "Tom Martinez" (Recognition: full_name_known)
 *   - Bio: Former military medic
 *   - Visual description: Tall, muscular build with military haircut and tired eyes
 *   - Introduced at page: 5
 *   - Relationship to MC: (friend - trusting - full_name_known) protective, has secret knowledge
 *   - Recent interactions:
 *     → Page 12: Helped treat Sarah's arm injury
 *     → Page 8: Warned about basement dangers
 *   - Relationships:
 *     → lisa_park: (rival - hostile - full_name_known) Doesn't trust her motives
 *   - Narrative mechanics: potential twist: none
 *   - Physical state: healthy, active
 *   - Schedules:
 *     → Available: night | Place: basement | If missed: Can't buy tickets
 * 
 * · Lisa (teacher, supporting) - female [suspicious, has secret, missing] - [ID: lisa_park]
 *   - Real name: "Lisa Park" (Recognition: first_name_known)
 *   - Bio: Quiet girl who knows more than she lets on
 *   - Visual description: Small frame, dark hair always in ponytail, avoids eye contact
 *   - Introduced at page: 5
 *   - Relationship to MC: (mentor - suspicious - first_name_known) childhood friend with hidden agenda
 *   - Secrets (spoiler, don't reveal too early):
 *     → She knows what happened in the basement 10 years ago
 *   - Recent interactions:
 *     → Page 15: First meeting here, seemed nervous
 *   - Narrative mechanics: potential twist: identity
 *   - Physical state: disappeared
 *   - Traits:
 *     → skills: teaching, gardening
 *     → favorite food: pizza
 */
export function formatCharactersForPrompt(mc: StoryMC, characters: Record<string, CharacterMemory>, recalledInteractions?: Record<string, string>): string {
  const mcDetails = [];
  if (mc.bio) mcDetails.push(`  - Bio: ${mc.bio}`);
  if (mc.knownName) mcDetails.push(`  - Known as: ${mc.knownName}`);

  const mcMainInfo = `· ${mc.name} (MC) - ${mc.age} years old, ${mc.gender}`;
  const mcInfo = mcDetails.length ? `${mcMainInfo}\n${mcDetails.join('\n')}` : mcMainInfo;

  // Exclude characters with the same name as the MC (that's the MC themselves)
  const sideCharacters = characters
    ? Object.entries(characters).filter(([, c]) => c.realName !== mc.name)
    : [];

  // Early return: still no side characters yet
  if (!sideCharacters.length) return mcInfo;

  // Sort by most recent interaction or introduction page (most recent first)
  sideCharacters.sort((a, b) => {
    const latest = (ch: CharacterMemory) => {
      const pages = (ch.pastInteractions || []).map((pi: PastInteraction) => pi.page).filter(Boolean);
      const maxPast = pages.length ? Math.max(...pages) : undefined;
      return (maxPast ?? ch.introducedAtPage ?? 0);
    };
    return latest(b[1]) - latest(a[1]);
  });

  const sideCharactersFormatted = sideCharacters
    .map(([id, character]) => {
      const {
        knownName, realName, recognitionLevel, role, gender, status,
        bio, visualDescription, introducedAtPage, pastInteractions, importance,
        secrets, relationships, relationshipToMC, narrativeFlags, injuries, traits, schedules
      } = character;

      const useDifferentReference = knownName !== realName;
      const nameUnknown = useDifferentReference && ['never_seen', 'seen', 'alias_known'].includes(recognitionLevel);

      // 1. Resolve Physical Status (SSOT for narrative physical presence)
      let physicalStatusDisplay = 'healthy, active';
      if (status === 'dead') physicalStatusDisplay = 'deceased';
      else if (status === 'missing') physicalStatusDisplay = 'disappeared';
      else if (injuries?.filter(i => i.severity).length) physicalStatusDisplay = 'injured';

      // 2. Resolve Header Tags (quick-glance emotional state flags)
      const headerTags = [];
      if (relationshipToMC?.status) headerTags.push(relationshipToMC.status); // e.g. "suspicious", "trusting"
      if (secrets?.length) headerTags.push('has secret');
      if (status === 'dead' || status === 'missing') headerTags.push(status); // Add extreme physical states to header

      const roleString = [role, importance].filter(Boolean).join(', ');
      const mainInfo = buildCharacterHeader(knownName, roleString, gender, id, headerTags);

      const details = [];
      
      // Basic information
      if (useDifferentReference) details.push(`  - Real name: "${realName}" (Recognition: ${recognitionLevel}${nameUnknown ? ` - Don't spoil unless revealed` : ''})`);
      details.push(`  - Bio: ${bio}`);
      details.push(`  - Visual description: ${visualDescription}`);
      details.push(`  - Introduced at page: ${introducedAtPage}`);
      
      // Relationship to MC
      const relationshipToMCStatus = [relationshipToMC.type, relationshipToMC.status, relationshipToMC.recognitionLevel].filter(Boolean).join(' - ');
      details.push(`  - Relationship to MC: ${relationshipToMCStatus ? `(${relationshipToMCStatus}) ` : ''}${relationshipToMC.context}`);

      // Character secrets with nested bullets (spoiler for AI, not shown to player)
      if (secrets?.length) {
        details.push(`  - Secrets (spoiler, don't reveal too early):`);
        secrets.forEach((secret) => {
          details.push(`    → ${secret}`);
        });
      }

      // Recent interactions with nested bullets
      if (pastInteractions?.length) {
        const recentInteractions = pastInteractions.sort((a, b) => a.page - b.page).slice(-MAX_PAST_INTERACTIONS);
        details.push(`  - Recent interactions:`);
        const interactionsByPage = recentInteractions.reduce<Record<number, string[]>>((acc, interaction) => {
          acc[interaction.page] = acc[interaction.page] || [];
          acc[interaction.page].push(interaction.interaction);
          return acc;
        }, {});

        Object.keys(interactionsByPage)
          .map(Number)
          .sort((a, b) => a - b)
          .forEach((page) => {
            const interactionsText = interactionsByPage[page].join(' ');
            details.push(`    → Page ${page}: ${interactionsText}`);
          });
      }

      // pgvector semantic memory (Use Case 2): interactions that have
      // scrolled out of the live MAX_PAST_INTERACTIONS window above, surfaced
      // only when semantically relevant to the current scene. Never
      // duplicates what "Recent interactions" already shows in full.
      const recalled = recalledInteractions?.[id];
      if (recalled) {
        details.push(`  - Earlier interactions (recalled):`);
        details.push(`    → ${recalled}`);
      }
      
      // Character relationships with nested bullets
      if (relationships?.length) {
        details.push(`  - Relationships:`);
        relationships.forEach(r => {
          const relStatus = [r.type, r.status, r.recognitionLevel].filter(Boolean).join(' - ');
          details.push(`    → ${r.targetId}: ${relStatus ? `(${relStatus}) ` : ''}${r.context}`);
        });
      }
      
      // Detailed injuries section
      if (injuries?.length) {
        details.push(`  - Injuries:`);
        injuries.forEach((injury: Injury) => {
          const injuryParts: string[] = [];
          if (injury.category) injuryParts.push(injury.category);
          if (injury.bodyPart) injuryParts.push(`location: ${injury.bodyPart}`);
          if (injury.severity !== undefined) injuryParts.push(`severity: ${injury.severity}`);
          if (injury.consequences) injuryParts.push(`consequences (${getInjurySeverityLabel(injury)}): ${injury.consequences}`);
          if (injury.pageAcquired) injuryParts.push(`acquired: page ${injury.pageAcquired}`);
          details.push(`    → ${injury.description}${injuryParts.length ? ` (${injuryParts.join(', ')})` : ''}`);
        });
      }
      
      // Narrative mechanics (Strictly plot planning constraints now)
      const narrativeInfo = [];
      if (narrativeFlags?.potentialTwist && narrativeFlags.potentialTwist !== 'none') {
        narrativeInfo.push(`potential twist: ${narrativeFlags.potentialTwist}`);
      }
      if (narrativeInfo.length) {
        details.push(`  - Narrative mechanics: ${narrativeInfo.join(', ')}`);
      }
      
      // Concluding Physical Status
      details.push(`  - Physical state: ${physicalStatusDisplay}`);

      // Schedules with descriptive formatting
      if (schedules?.length) {
        details.push(`  - Schedules:`);
        schedules.forEach(s => {
          const parts = [`Available: ${s.availabilityWindow}`, `Place: ${s.placeId}`];
          if (s.missedConsequence) parts.push(`If missed: ${s.missedConsequence}`);
          details.push(`    → ${parts.join(' | ')}`);
        });
      }

      // Traits with nested bullets
      if (traits?.length) {
        details.push(`  - Traits:`);
        traits.forEach((trait) => {
          details.push(`    → ${trait.key}: ${trait.value}`);
        });
      }

      return `${mainInfo}\n${details.join('\n')}`;
    })
    .join('\n\n');

  return `${mcInfo}\n\n${sideCharactersFormatted}`;
}

/**
 * Shared helper: builds the header line used by both introduced and planned
 * character formatters.
 *
 * @param knownName - Display name shown in the header
 * @param roleString - Role + importance joined (e.g. `"security guard, major"`)
 * @param gender - Character gender
 * @param id - Unique character ID
 * @param headerTags - Optional quick-glance flags (status, secrets, etc.)
 * @returns Formatted header line
 *
 * @example
 * ```typescript
 * buildCharacterHeader("Tom", "security guard, major", "male", "tom_m");
 * // → · Tom (security guard, major) - male - [ID: tom_m]
 *
 * buildCharacterHeader("Lisa", "teacher, supporting", "female", "lisa_park", ["suspicious", "has secret"]);
 * // → · Lisa (teacher, supporting) - female [suspicious, has secret] - [ID: lisa_park]
 * ```
 */
function buildCharacterHeader(knownName: string, roleString: string, gender: string, id: string, headerTags?: string[]): string {
  const flagString = headerTags?.length ? ` [${headerTags.join(', ')}]` : '';
  return `· ${knownName} (${roleString}) - ${gender}${flagString} - [ID: ${id}]`;
}

/**
 * Formats planned characters (not yet introduced) for prompt injection.
 *
 * Provides a concise overview of characters that are scheduled for future
 * introduction, including their planned narrative context.
 *
 * @param characterPlans - Array of planned character entries
 * @returns Formatted string ready for prompt inclusion
 *
 * @example
 * ```
 * · Sarah Chen (major) - female - [ID: sarah_c]
 *   - Real name: "Sarah Chen"
 *   - Bio: Shy librarian with hidden past and mysterious family connections
 *   - Visual description: Tall, pale, messy black hair, hollow eyes
 *   - Planned introduction: At the library, when MC comes looking for answers
 *
 * · Tom Martinez (security guard, major) - male - [ID: tom_m]
 *   - Real name: "Tom Martinez"
 *   - Bio: Former military medic
 *   - Visual description: Tall, muscular build with military haircut and tired eyes
 *   - Planned introduction: During the blackout scene at the warehouse
 */
export function formatPlannedCharactersForPrompt(characterPlans: CharacterPlan[]): string {
  if (!characterPlans.length) return 'No planned characters.';

  return characterPlans
    .map((plan) => {
      const { characterId, knownName, realName, gender, role, bio, visualDescription, importance, plannedIntroduction, storyPurpose } = plan;

      const roleString = [role, importance].filter(Boolean).join(', ');
      const mainInfo = buildCharacterHeader(knownName, roleString, gender, characterId);

      const details: string[] = [];

      if (realName && realName !== knownName) {
        details.push(`  - Real name: "${realName}"`);
      }
      if (bio) details.push(`  - Bio: ${bio}`);
      if (visualDescription) details.push(`  - Visual description: ${visualDescription}`);
      if (storyPurpose) details.push(`  - Story purpose: ${storyPurpose}`);
      if (plannedIntroduction) details.push(`  - Planned introduction: ${plannedIntroduction}`);

      return details.length ? `${mainInfo}\n${details.join('\n')}` : mainInfo;
    })
    .join('\n\n');
}

/**
 * Generates a random character profile when one is not explicitly provided.
 * 
 * Behavior:
 * - Generates realistic random names based on gender
 * - Creates appropriate age ranges for different story contexts
 * - Ensures character diversity and believability
 *
 * @param candidate - Optional partial character data to merge with random values
 * @returns Complete character profile with random values for any missing fields
 *
 * @example
 * ```typescript
 * const randomMC = generateRandomCharacter({ gender: 'female' });
 * // Returns: { name: 'Sarah Chen', age: 28, gender: 'female', bio: '...' }
 *
 * const completeMC = generateRandomCharacter({ name: 'Marcus', gender: 'male' });
 * // Returns: { name: 'Marcus Johnson', age: 35, gender: 'male', bio: '...' }
 * ```
 */
export function generateRandomCharacter(candidate?: StoryMCCandidate): StoryMC {
  const { maleNames, femaleNames, maleLastNames, femaleLastNames, neutralLastNames } = CHARACTER_NAMES;

  // Generate or use provided values
  const gender = candidate?.gender ?? (Math.random() > 0.5 ? 'male' : 'female');
  const namePool = gender === 'male' ? maleNames : femaleNames;

  // Choose last name: 70% gender-specific, 30% neutral for variety
  const useGenderSpecific = Math.random() < 0.7;
  const lastNamePool = useGenderSpecific
    ? (gender === 'male' ? maleLastNames : femaleLastNames)
    : neutralLastNames;
  
  // Generate random name and last name with retry logic to prevent duplicates
  const randomName = candidate?.name ?? namePool[Math.floor(Math.random() * namePool.length)];
  let randomLastName = lastNamePool[Math.floor(Math.random() * lastNamePool.length)];

  // Retry if first and last name are identical (e.g., "Parker Parker")
  let attempts = 0;
  const maxAttempts = 10;
  while (randomName === randomLastName && attempts < maxAttempts) {
    randomLastName = lastNamePool[Math.floor(Math.random() * lastNamePool.length)];
    attempts++;
  }

  const name = `${randomName} ${randomLastName}`;
  const age = candidate?.age ?? Math.floor(Math.random() * (MAX_CHARACTER_AGE - MIN_CHARACTER_AGE + 1)) + MIN_CHARACTER_AGE;
  const bio = candidate?.bio ?? generateRandomCharacterBio(gender);

  return { name, age, gender, bio };
}

function generateRandomCharacterBio(gender: KnownGender): string {
  // Personality trait pools by gender
  const maleTraits = [
    'analytical', 'logical', 'competitive', 'ambitious', 'confident', 'strategic',
    'independent', 'reserved', 'practical', 'disciplined', 'loyal', 'protective'
  ];

  const femaleTraits = [
    'empathetic', 'intuitive', 'creative', 'adaptable', 'diplomatic', 'patient',
    'nurturing', 'expressive', 'collaborative', 'harmonious', 'perceptive'
  ];

  const neutralTraits = [
    'balanced', 'versatile', 'thoughtful', 'reliable', 'open-minded', 'curious',
    'flexible', 'resilient', 'observant', 'fair-minded', 'authentic'
  ];
  
  // Characteristic pools
  const characteristics = [
    'quick-witted', 'detail-oriented', 'methodical', 'spontaneous', 'cautious',
    'adventurous', 'reserved', 'idealistic', 'pragmatic', 'competitive',
    'easygoing', 'serious', 'playful', 'conscientious', 'independent'
  ];

  const appearanceDetails = [
    'is tall and lean', 'is short and muscular', 'has average height with distinctive features',
    'has striking eyes', 'has unusual hair color', 'has subtle scars', 'has elegant hands',
    'has weathered appearance', 'has youthful energy', 'has mature presence', 'has distinctive voice'
  ];

  const behavioralQuirks = [
    'taps fingers when thinking', 'hums when focused', 'always early', 'collects unusual objects',
    'talks to themselves', 'excellent listener', 'remembers small details',
    'dislikes sudden noises', 'has specific routine', 'overly polite', 'secretly creative'
  ];

  const backgroundHints = [
    'mysterious past', 'privileged upbringing', 'struggled in youth', 'traveled extensively',
    'formal training', 'self-taught skills', 'family tragedy', 'hidden talent',
    'unusual hobby', 'secret ambition', 'complex relationships', 'survivor mindset'
  ];
  
  // Select appropriate pools
  const genderSpecificTraits = gender === 'male' ? maleTraits : femaleTraits;
  const traitPool = [...genderSpecificTraits, ...neutralTraits];
  
  // Generate 3-5 random traits
  const numTraits = Math.floor(Math.random() * 3) + 3; // 3-5 traits
  const selectedTraits: string[] = [];
  const usedIndices = new Set<number>();

  for (let i = 0; i < numTraits && i < traitPool.length; i++) {
    let index: number;
    do {
      index = Math.floor(Math.random() * traitPool.length);
    } while (usedIndices.has(index));
    selectedTraits.push(traitPool[index]);
    usedIndices.add(index);
  }
  
  // Generate other characteristics
  const characteristic = characteristics[Math.floor(Math.random() * characteristics.length)];
  const appearance = appearanceDetails[Math.floor(Math.random() * appearanceDetails.length)];
  const quirk = behavioralQuirks[Math.floor(Math.random() * behavioralQuirks.length)];
  const background = backgroundHints[Math.floor(Math.random() * backgroundHints.length)];
  
  // Build bio based on gender and traits with proper grammar
  const subject = gender === 'male' ? 'He' : 'She';
  const possessive = gender === 'male' ? 'His' : 'Her';
  
  // Build trait sentence with proper comma placement (optimized for small arrays)
  let traitSentence: string;
  if (selectedTraits.length === 1) {
    traitSentence = `${selectedTraits[0]}.`;
  } else if (selectedTraits.length === 2) {
    traitSentence = `${selectedTraits[0]} and ${selectedTraits[1]}.`;
  } else {
    traitSentence = `${selectedTraits.slice(0, -1).join(', ')}, and ${selectedTraits[selectedTraits.length - 1]}.`;
  }
  
  // Build characteristic sentence with proper grammar and meaning
  const characteristicSentence = `${subject} is ${characteristic} and ${appearance}.`;
  
  // Build quirk sentence with proper grammar
  const quirkSentence = `${subject} ${quirk}.`;
  
  // Build background sentence with proper grammar
  const backgroundSentence = `${possessive} background suggests ${background}.`;

  return `${ucfirst(traitSentence)} ${characteristicSentence} ${quirkSentence} ${backgroundSentence}`;
}

/**
 * Generates a compact, deterministic character ID from a character name.
 *
 * The first name is preserved in full, while each subsequent name part
 * contributes only its initial. All parts are normalized via {@link slugify}.
 *
 * @example
 * - "Lisa Park"              → "lisa_p"
 * - "John Ronald Reuel Tolkien" → "john_r_r_t"
 * - "Crème Brûlée Smith"    → "creme_b_s"
 *
 * @param name - Character name to convert into an ID.
 * @returns A deterministic, normalized character ID.
 */
export function generateCharacterId(name: string): string {
  const parts = name.trim().split(/\s+/).map(part => slugify(part)).filter(Boolean);
  const [first = "", ...rest] = parts;
  return [first, ...rest.map(part => part[0])].join("_");
}

// ============================================================================
// HEALTH STATUS CALCULATION
// ============================================================================

/**
 * Resolves per-dimension impact weights for a given body part string.
 *
 * Resolution order:
 * 1. Exact, case-insensitive key lookup (fastest path; e.g. `"leg"`)
 * 2. Substring scan over all keys, longest key first, to match compound
 *    descriptors the AI might produce: `"left knee"` → `knee`,
 *    `"lower back"` → `back`, `"ring finger"` → `finger`.
 *    Longest-key-first prevents a shorter sibling key from winning when a
 *    more specific one exists (e.g. `"forearm"` matches `"arm"` correctly
 *    because no `"forearm"` key exists, but `"shoulder blade"` won't
 *    accidentally match `"arm"` through `"shoulder"` — `"shoulder"` is longer).
 * 3. {@link DEFAULT_BODY_PART_IMPACT} for unrecognised strings.
 *
 * @param bodyPart - Raw body part string from the injury (may be compound or omitted).
 * @returns Per-dimension impact weights for use in {@link getInjuryScores}.
 */
function getBodyPartImpact(bodyPart?: string): BodyPartImpact {
  if (!bodyPart) return DEFAULT_BODY_PART_IMPACT;
  const normalized = bodyPart.trim().toLowerCase();

  // 1. Exact match
  if (normalized in BODY_PART_WEIGHTS) return BODY_PART_WEIGHTS[normalized];

  // 2. Substring scan — longest key first so more specific keys win ties
  const sortedKeys = Object.keys(BODY_PART_WEIGHTS).sort((a, b) => b.length - a.length);
  for (const key of sortedKeys) {
    if (normalized.includes(key)) return BODY_PART_WEIGHTS[key];
  }

  return DEFAULT_BODY_PART_IMPACT;
}

/**
 * Per-dimension damage scores for a single injury.
 *
 * Computation per axis:
 * - `health`   = severity × category.physical × bodyPart.health
 * - `mobility` = severity × category.physical × bodyPart.mobility
 * - `action`   = severity × category.physical × bodyPart.action
 * - `mental`   = severity × category.mental   × bodyPart.trauma
 *
 * Physical axes share `category.physical` because a fracture is categorically
 * more limiting than a bruise across all physical dimensions, regardless of
 * body part. The mental axis uses `category.mental` independently to let
 * each category carry its own psychological weight — a burn and a cut of the
 * same severity on the same body part inflict very different mental damage.
 */
type InjuryScores = { health: number; mobility: number; action: number; mental: number };

function getInjuryScores(injury: Injury): InjuryScores {
  const severity     = injury.severity ?? 0.5;
  const catImpact    = INJURY_CATEGORY_WEIGHTS[injury.category ?? 'bruise'] ?? INJURY_CATEGORY_WEIGHTS.bruise;
  const partImpact   = getBodyPartImpact(injury.bodyPart);

  return {
    health:   severity * catImpact.physical * partImpact.health,
    mobility: severity * catImpact.physical * partImpact.mobility,
    action:   severity * catImpact.physical * partImpact.action,
    mental:   severity * catImpact.mental   * partImpact.trauma,
  };
}

/** Clamps a floating-point percentage to a whole integer in [0, 100]. */
function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** Derives the narrative condition label from the overall health percentage. */
function deriveCondition(healthPercent: number): HealthCondition {
  if (healthPercent >= 85) return 'healthy';
  if (healthPercent >= 65) return 'injured';
  if (healthPercent >= 40) return 'critical';
  if (healthPercent >= 15) return 'incapacitated';
  return 'dying';
}

/**
 * Derives the MC's complete {@link HealthStatus} from active injuries and
 * optional psychological context from `StoryState`.
 *
 * Produces four independently-scaled 0–100 percentages (higher = better):
 *
 * | Stat             | Primary drivers                                              |
 * |------------------|--------------------------------------------------------------|
 * | `healthPercent`  | Injury severity × category.physical × bodyPart.health        |
 * | `mobilityPercent`| Lower-body and back injuries (knee:3.0 mobility weight)      |
 * | `actionPercent`  | Upper-limb injuries (shoulder/hand/wrist: 1.5–1.8 weight)    |
 * | `mentalPercent`  | Psychological injuries + memory integrity + trauma tags + fear|
 *
 * `condition` is derived from `healthPercent` thresholds:
 * `≥85 healthy | ≥65 injured | ≥40 critical | ≥15 incapacitated | <15 dying`
 *
 * ── mentalInputs ────────────────────────────────────────────────────────────
 * When omitted, `mentalPercent` reflects only injury-based psychological trauma
 * (an underestimate — no memory integrity, fear, or trauma tag contribution).
 * Always pass `mentalInputs` when `StoryState` is available at the call site.
 *
 * ── Call-site update required in story.ts ───────────────────────────────────
 * Replace the existing call in `applyStateDelta`:
 * ```ts
 * // Before:
 * newState.healthStatus = calculateHealthStatus(newState.injuries);
 *
 * // After:
 * newState.healthStatus = calculateHealthStatus(newState.injuries, {
 *   traumaTagCount:  newState.traumaTags.length,
 *   memoryIntegrity: newState.memoryIntegrity,
 *   fearLevel:       newState.flags.fear,
 * });
 * ```
 * Also add the same call at the end of `advanceStoryState`, AFTER `updateFlags`,
 * so the AI receives an up-to-date status block for the upcoming generation:
 * ```ts
 * updatedState.healthStatus = calculateHealthStatus(updatedState.injuries ?? [], {
 *   traumaTagCount:  updatedState.traumaTags.length,
 *   memoryIntegrity: updatedState.memoryIntegrity,
 *   fearLevel:       updatedState.flags.fear,
 * });
 * ```
 * This also fixes a latent bug where `decayInjuries()` was never followed
 * by a `healthStatus` recalculation, leaving the status stale until the next
 * AI-authored injury delta arrived.
 *
 * ── Calibration ─────────────────────────────────────────────────────────────
 * Tune the `*_SCORE_CAP` constants above this function to adjust overall
 * difficulty feel without touching the per-injury weight tables.
 *
 * @param injuries - MC's active injury array (pre-healed/pre-decayed).
 * @param mentalInputs - Psychological context from `StoryState`. Optional but recommended.
 * @returns Fully populated {@link HealthStatus}.
 */
export function calculateHealthStatus(injuries: Injury[], mentalInputs?: MentalHealthInputs): HealthStatus {
  let healthScore   = 0;
  let mobilityScore = 0;
  let actionScore   = 0;
  let mentalScore   = 0;

  for (const injury of injuries) {
    const scores = getInjuryScores(injury);
    healthScore   += scores.health;
    mobilityScore += scores.mobility;
    actionScore   += scores.action;
    mentalScore   += scores.mental;
  }

  // Apply structural psychological context when available.
  // Without these, mentalPercent only captures injury-based trauma — an
  // optimistic reading that misses memory corruption, accumulated fear,
  // and the cumulative weight of unresolved trauma events.
  if (mentalInputs) {
    const { traumaTagCount, memoryIntegrity, fearLevel } = mentalInputs;
    mentalScore += MEMORY_INTEGRITY_MENTAL_PENALTY[memoryIntegrity] ?? 0;
    mentalScore += traumaTagCount * TRAUMA_TAG_MENTAL_WEIGHT;
    mentalScore += FEAR_MENTAL_PENALTY[fearLevel] ?? 0;
  }

  const healthPercent   = clampPercent(100 - (healthScore   / HEALTH_SCORE_CAP)   * 100);
  const mobilityPercent = clampPercent(100 - (mobilityScore / MOBILITY_SCORE_CAP) * 100);
  const actionPercent   = clampPercent(100 - (actionScore   / ACTION_SCORE_CAP)   * 100);
  const mentalPercent   = clampPercent(100 - (mentalScore   / MENTAL_SCORE_CAP)   * 100);

  return {
    condition: deriveCondition(healthPercent),
    healthPercent,
    mobilityPercent,
    actionPercent,
    mentalPercent,
  };
}