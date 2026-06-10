import { CHARACTER_NAMES } from "../config/characters.js";
import { MAX_PAST_INTERACTIONS, MIN_CHARACTER_AGE, MAX_CHARACTER_AGE, MAX_CHARACTERS } from "../config/story.js";
import type { CharacterMemory, CharacterUpdate, CharacterUpdates, RelationshipUpdate, StoryMC, StoryMCCandidate, Injury, InjurySeverity, PastInteraction } from "../types/character.js";
import type { StoryState } from "../types/story.js";
import type { KnownGender } from "../types/user.js";
import { ucfirst } from "./formatter.js";

// ============================================================================
// CHARACTER MEMORY MANAGEMENT SYSTEM
// ============================================================================

/**
 * Calculates the injury severity label based on severity and decay rate
 * @param injury - Injury object with severity and decayPerPage
 * @returns Severity label: 'permanent', 'critical', 'severe', 'moderate', 'mild', or 'none'
 * 
 * @example
 * ```typescript
 * getInjurySeverityLabel({ severity: 0.9, decayPerPage: 0.1 }); // 'critical'
 * getInjurySeverityLabel({ severity: 0.7, decayPerPage: 0.1 }); // 'severe'
 * getInjurySeverityLabel({ severity: 0.5, decayPerPage: 0 }); // 'permanent'
 * getInjurySeverityLabel({ severity: 0.3, decayPerPage: 0.05 }); // 'mild'
 * getInjurySeverityLabel({ severity: 0.1, decayPerPage: 0.05 }); // 'none'
 * ```
 */
export function getInjurySeverityLabel(injury: Injury): InjurySeverity {
  const { severity = 0.5, decayPerPage = 0 } = injury;
  if (decayPerPage === 0) return 'permanent';
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
//  *   narrativeFlags: { isSuspicious: false, isMissing: false, isDead: false, hasSecret: false, potentialTwist: "none" },
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
//       isSuspicious: narrativeFlags.isSuspicious || status === "suspicious",
//       isMissing: narrativeFlags.isMissing || status === "missing",
//       isDead: narrativeFlags.isDead || status === "dead",
//       hasSecret: narrativeFlags.hasSecret || status === "suspicious" || status === "hostile",
//       potentialTwist: narrativeFlags.potentialTwist || (status === "suspicious" ? "betrayal" : "none")
//     },
//     injuries: [],
//   };
// }

/**
 * Updates an existing character with new information
 * 
 * Merges new interactions with existing ones, maintaining the sliding window.
 * Updates status and narrative flags as provided.
 * 
 * @param existing - Current character memory
 * @param update - Update data from AI output
 * @returns Updated character memory
 * 
 * @example
 * ```typescript
 * const updated = updateCharacter(existing, {
 *   status: "suspicious",
 *   pastInteractions: [{"page": 6, "interaction": "Refused to explain what she saw"}],
 *   narrativeFlags: { isSuspicious: true }
 * });
 * ```
 */
export function updateCharacter(existing: CharacterMemory, update: CharacterUpdate, page: number, place?: string): CharacterMemory {
  const updated = { ...existing };
  
  // Update basic properties if provided
  if (update.name) updated.name = update.name;
  if (update.knownName) updated.knownName = update.knownName;
  if (update.recognitionLevel) updated.recognitionLevel = update.recognitionLevel;
  if (update.gender) updated.gender = update.gender;
  if (update.role) updated.role = update.role;
  if (update.bio) updated.bio = update.bio;
  if (update.visualDescription) updated.visualDescription = update.visualDescription;
  if (update.status) updated.status = update.status;
  if (update.secrets) updated.secrets = update.secrets;
  if (update.relationshipToMC) updated.relationshipToMC = update.relationshipToMC;
  
  // Merge relationships (replace entire array if provided)
  // if (update.relationships) {
  //   updated.relationships = update.relationships;
  // }
  
  // Merge past interactions with sliding window
  if (update.pastInteractions) {
    updated.pastInteractions = [
      ...existing.pastInteractions,
      ...update.pastInteractions.map<PastInteraction>(i => ({ page, interaction: i, place }))
    ].slice(-MAX_PAST_INTERACTIONS);
  }
    
  // Merge narrative flags if provided
  if (update.narrativeFlags) {
    updated.narrativeFlags = {
      ...existing.narrativeFlags,
      ...update.narrativeFlags
    };
  }
  
  // Merge injuries (replace entire array if provided)
  if (update.injuries) {
    updated.injuries = update.injuries;
  }
  
  return updated;
}

/**
 * Updates character relationship with new information
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
 * updateRelationship("Lina", { target: "Raka", status: "fearful" });
 * ```
 */
export function updateRelationship(character: CharacterMemory, update: RelationshipUpdate): CharacterMemory {
  const updated = { ...character };
  
  // Find existing relationship to target
  const existingIndex = updated.relationships.findIndex(r => r.target === update.target);
  
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
      target: update.target,
      type: update.type || "knows",
      status: update.status || "neutral",
      context: update.context,
      recognitionLevel: update.recognitionLevel,
    });
  }
  
  return updated;
}

/**
 * Adds or updates characters in the story state
 * 
 * Processes AI output for new characters and updates, maintaining
 * character dictionary structure.
 * 
 * @param state - Current story state
 * @param newCharacters - Array of new characters to add
 * @param characterUpdates - Array of character updates to apply
 * 
 * @example
 * ```typescript
 * processCharacterUpdates(state, output);
 * ```
 */
export function processCharacterUpdates(
  state: StoryState,
  characterUpdates?: CharacterUpdates,
  relationshipUpdates?: RelationshipUpdate[],
  place?: string
): void {
  if (!characterUpdates && !relationshipUpdates) return;
  
  // Process character updates if they exist
  if (characterUpdates) {
    const { newCharacters = [], updatedCharacters = [] } = characterUpdates;
    const { page } = state;
  
    // Add new characters
    for (const character of newCharacters) {
      state.characters[character.name] = {
        ...character,
        introducedAtPage: page,
        injuries: character.injuries,
        pastInteractions: character.pastInteractions?.map<PastInteraction>(i => ({ page, interaction: i, place })) ?? [],
        relationships: [], // Will be processed later via `relationshipUpdates`
      };
    }
    
    // Update existing characters
    for (const update of updatedCharacters) {
      if (!update.name) continue;
      const existing = state.characters[update.name];
      if (existing) {
        state.characters[update.name] = updateCharacter(existing, update, page, place);
      }
    }
  }

  // Process relationship updates
  if (relationshipUpdates && relationshipUpdates.length > 0) {
    for (const relUpdate of relationshipUpdates) {
      const sourceCharacter = state.characters[relUpdate.source];
      if (sourceCharacter) {
        state.characters[relUpdate.source] = updateRelationship(sourceCharacter, relUpdate);
      }
    }
  }
}

/**
 * Formats characters for prompt injection with comprehensive narrative context
 * 
 * Creates a rich, detailed string representation of characters including narrative flags,
 * twist potential, relationships, and psychological state for inclusion in AI prompts.
 * 
 * @param characters - Record of character memories
 * @returns Formatted string for prompt inclusion
 * 
 * @example
 * ```typescript
 * const characterText = formatCharactersForPrompt(book.mc, state);
 * ```
 * 
 * Output example:
 * · Sarah Chen (MC) - 28 years old, female
 *   Bio: Shy librarian with hidden past and mysterious family connections
 * 
 * · Tom Martinez (friend) - male, healthy, active
 *   Bio: Former military medic, now works as security guard
 *   Visual description: Tall, muscular build with military haircut and tired eyes
 *   Introduced at page: 5
 *   Relationship to MC: protective friend with secret knowledge
 *   Recent interactions:
 *     - Page 12: Helped treat Sarah's arm injury
 *     - Page 8: Warned about basement dangers
 *     - Page 5: Shared military medical training
 *   Relationships:
 *     - Lisa (rival - hostile)
 *     - Sarah (friend - protective)
 *   Narrative flags: has secret, potential twist: knows about Sarah's past
 *   Status: healthy, active
 * 
 * · Lisa Park (mentor) - female, suspicious [suspicious, secret]
 *   Bio: Quiet girl who knows more than she lets on
 *   Visual description: Small frame, dark hair always in ponytail, avoids eye contact
 *   Introduced at page: 5
 *   Relationship to MC: childhood friend with hidden agenda
 *   Recent interactions:
 *     - Page 15: First meeting here, seemed nervous
 *     - Page 10: Avoided questions about parents
 *     - Page 3: Shared secret about basement
 *   Relationships:
 *     - Tom (rival - hostile)
 *     - Sarah (mentor - protective)
 *   Narrative flags: missing, potential twist: not actually dead
 *   Status: disappeared
 */
export function formatCharactersForPrompt(mc: StoryMC, state?: StoryState): string {
  const mcDetails = [];
  if (mc.bio) mcDetails.push(`  Bio: ${mc.bio}`);

  const mcMainInfo = `· ${mc.name} (MC) - ${mc.age} years old, ${mc.gender}`;
  const mcInfo = mcDetails.length > 0 ? `${mcMainInfo}\n${mcDetails.join('\n')}` : mcMainInfo;

  const { characters = {} } = state || {};

  // Exclude character with same name as MC's, it's him/herself
  const sideCharacters = characters ? Object.values(characters).filter(character => character.name !== mc.name) : [];
  
  // Early return: still no side characters yet
  if (!sideCharacters.length) return mcInfo;

  const sideCharactersFormatted = sideCharacters
    .map(character => {
      const { name, knownName, recognitionLevel, role, gender, status, bio, visualDescription, introducedAtPage, pastInteractions, secrets, relationships, relationshipToMC, narrativeFlags, injuries } = character;

      // Basic character information
      const statusFlags = [];
      if (narrativeFlags.isSuspicious) statusFlags.push('suspicious');
      if (narrativeFlags.isMissing) statusFlags.push('missing');
      if (narrativeFlags.isDead) statusFlags.push('dead');
      if (narrativeFlags.hasSecret) statusFlags.push('secret');
      
      const flagString = statusFlags.length > 0 ? ` [${statusFlags.join(', ')}]` : '';
      const mainInfo = `· ${knownName ?? name} (${role}) - ${gender}, ${status}${flagString}`;
      const relationshipToMCStatus = [relationshipToMC.type, relationshipToMC.status, relationshipToMC.recognitionLevel].filter(Boolean).join(' - ');
      const details = [];
      
      // Basic information
      if (knownName && knownName !== name) details.push(`  Real name: "${name}" (Recognition: ${recognitionLevel})`);
      details.push(`  Bio: ${bio}`);
      details.push(`  Visual description: ${visualDescription}`);
      details.push(`  Introduced at page: ${introducedAtPage || '-'}`);
      details.push(`  Relationship to MC: ${relationshipToMCStatus ? `(${relationshipToMCStatus}) ` : ''}${relationshipToMC.context}`);

      // Character secrets with nested bullets (spoiler for AI, not shown to player)
      if (secrets.length) {
        details.push(`  Secrets (spoiler, don't reveal too early):`);
        secrets.forEach((secret) => {
          details.push(`    - ${secret}`);
        });
      }

      // Recent interactions with nested bullets
      if (pastInteractions.length) {
        const recentInteractions = pastInteractions.sort((a, b) => a.page - b.page).slice(-MAX_PAST_INTERACTIONS);
        details.push(`  Recent interactions:`);
        recentInteractions.forEach((i) => {
          details.push(`    - Page ${i.page}: ${i.interaction}`);
        });
      }
      
      // Character relationships with nested bullets
      if (relationships.length) {
        details.push(`  Relationships:`);
        relationships.forEach(r => {
          const relationshipStatus = [r.type, r.status, r.recognitionLevel].filter(Boolean).join(' - ');
          details.push(`    - ${r.target}: ${relationshipStatus ? `(${relationshipStatus}) ` : ''}${r.context}`);
        });
      }
      
      // Detailed injuries section
      if (injuries?.length) {
        details.push(`  Injuries:`);
        injuries.forEach((injury: Injury, index: number) => {
          const injuryParts = [];
          const severityLabel = getInjurySeverityLabel(injury);
          if (injury.description) injuryParts.push(injury.description);
          if (injury.bodyPart) injuryParts.push(`Location: ${injury.bodyPart}`);
          if (injury.severity) injuryParts.push(`Severity: ${injury.severity}`);
          if (injury.consequences) injuryParts.push(`Consequences (${severityLabel}): ${injury.consequences}`);
          if (injury.pageAcquired) injuryParts.push(`Acquired: page ${injury.pageAcquired}`);
          
          const injuryInfo = injuryParts.length > 0 ? ` (${injuryParts.join(', ')})` : '';
          details.push(`    - Injury ${index + 1}${injuryInfo}`);
        });
      }
      
      // Narrative flags (excluding injuries which are now separate)
      const narrativeInfo = [];
      if (narrativeFlags.isSuspicious) narrativeInfo.push('suspicious');
      if (narrativeFlags.isMissing) narrativeInfo.push('missing');
      if (narrativeFlags.isDead) narrativeInfo.push('dead');
      if (narrativeFlags.hasSecret) narrativeInfo.push('has secret');
      
      if (narrativeFlags.potentialTwist && narrativeFlags.potentialTwist !== 'none') {
        narrativeInfo.push(`potential twist: ${narrativeFlags.potentialTwist}`);
      }
      
      if (narrativeInfo.length > 0) {
        details.push(`  Narrative flags: ${narrativeInfo.join(', ')}`);
      }
      
      // Character status details
      const statusDetails = [];
      if (status === 'dead') {
        statusDetails.push('deceased');
      } else if (status === 'missing') {
        statusDetails.push('disappeared');
      } else if (status === 'injured') {
        statusDetails.push('injured');
      } else {
        statusDetails.push('healthy, active');
      }
      
      details.push(`  Status: ${statusDetails.join(', ')}`);
      
      return `${mainInfo}\n${details.join('\n')}`;
    })
    .join('\n\n');

  return `${mcInfo}\n\n${sideCharactersFormatted}`;
}

/**
 * Generates random character profile when not provided
 * 
 * @param partial - Optional partial character data to merge with random values
 * @returns Complete character profile with random values for missing fields
 * 
 * Behavior:
 * - Generates realistic random names based on gender
 * - Creates appropriate age ranges for different story contexts
 * - Ensures character diversity and believability
 * 
 * Example:
 * ```typescript
 * const randomMC = generateRandomCharacter({ gender: 'female' });
 * // Returns: { name: 'Sarah Chen', age: 28, gender: 'female' }
 * 
 * const completeMC = generateRandomCharacter({ name: 'Marcus', gender: 'male' });
 * // Returns: { name: 'Marcus', age: 35, gender: 'male' }
 * ```
 */
export function generateRandomCharacter(candidate?: StoryMCCandidate): StoryMC {
  const { maleNames, femaleNames, maleLastNames, femaleLastNames, neutralLastNames } = CHARACTER_NAMES;

  // Generate or use provided values
  const gender = candidate?.gender ?? (Math.random() > 0.5 ? 'male' : 'female');
  const namePool = gender === 'male' ? maleNames : femaleNames;
  
  // Choose last name pool: 70% gender-specific, 30% neutral for variety
  const useGenderSpecific = Math.random() < 0.7;
  const lastNamePool = useGenderSpecific
    ? (gender === 'male' ? maleLastNames : femaleLastNames)
    : neutralLastNames;
  
  // Generate random name and last name with retry logic to prevent duplicates
  const randomName = candidate?.name ?? namePool[Math.floor(Math.random() * namePool.length)];
  let randomLastName = lastNamePool[Math.floor(Math.random() * lastNamePool.length)];
  
  // Retry if first and last name are the same (e.g., "Parker Parker", "Rose Rose")
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
    let index;
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