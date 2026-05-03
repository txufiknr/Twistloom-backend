import { CHARACTER_NAMES } from "../config/characters.js";
import { MAX_PAST_INTERACTIONS, MIN_CHARACTER_AGE, MAX_CHARACTER_AGE } from "../config/story.js";
import type { CharacterMemory, CharacterUpdate, CharacterUpdates, RelationshipUpdate, StoryMC, StoryMCCandidate, Injury, CharacterCreationParam, InjurySeverity } from "../types/character.js";
import type { StoryState } from "../types/story.js";
import type { KnownGender } from "../types/user.js";
import { ucfirst } from "./formatter.js";

// ============================================================================
// CHARACTER MEMORY MANAGEMENT SYSTEM
// ============================================================================

/**
 * Calculates the injury severity label based on severity and decay rate
 * @param injury - Injury object with severity and decayPerPage
 * @returns Severity label: 'permanent', 'high', 'medium', or 'low'
 * 
 * @example
 * ```typescript
 * getInjurySeverityLabel({ severity: 0.8, decayPerPage: 0.1 }); // 'high'
 * getInjurySeverityLabel({ severity: 0.5, decayPerPage: 0 }); // 'permanent'
 * getInjurySeverityLabel({ severity: 0.3, decayPerPage: 0.05 }); // 'low'
 * ```
 */
export function getInjurySeverityLabel(injury: Injury): InjurySeverity {
  const { severity = 0.5, decayPerPage = 0 } = injury;
  if (decayPerPage === 0) return 'permanent';
  if (severity >= 0.7) return 'high';
  if (severity >= 0.4) return 'medium';
  return 'low';
}

/**
 * Creates a new character with default values
 * 
 * @param newCharacter - Character creation parameters including name, gender, role, bio, visualDescription, status, narrativeFlags, and relationshipToMC
 * @returns New character memory structure
 * 
 * @example
 * ```typescript
 * const character = createCharacter({
 *   name: "Lina",
 *   gender: "female",
 *   role: "best friend",
 *   bio: "Cheerful but secretive",
 *   visualDescription: "tall, pale, messy black hair, hollow eyes",
 *   status: "trusting",
 *   narrativeFlags: { isSuspicious: false, isMissing: false, isDead: false, hasSecret: false, potentialTwist: "none" },
 *   relationshipToMC: "close friend"
 * });
 * ```
 */
export function createCharacter(
  newCharacter: CharacterCreationParam
): CharacterMemory {
  const { status, narrativeFlags } = newCharacter;
  return {
    ...newCharacter,
    relationships: [],
    pastInteractions: [],
    narrativeFlags: {
      ...narrativeFlags,
      isSuspicious: narrativeFlags.isSuspicious || status === "suspicious",
      isMissing: narrativeFlags.isMissing || status === "missing",
      isDead: narrativeFlags.isDead || status === "dead",
      hasSecret: narrativeFlags.hasSecret || status === "suspicious" || status === "hostile",
      potentialTwist: narrativeFlags.potentialTwist || (status === "suspicious" ? "betrayal" : "none")
    },
    injuries: [],
  };
}

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
export function updateCharacter(existing: CharacterMemory, update: CharacterUpdate): CharacterMemory {
  const updated = { ...existing };
  
  // Update basic properties if provided
  if (update.name) updated.name = update.name;
  if (update.gender) updated.gender = update.gender;
  if (update.role) updated.role = update.role;
  if (update.bio) updated.bio = update.bio;
  if (update.visualDescription) updated.visualDescription = update.visualDescription;
  if (update.status) updated.status = update.status;
  if (update.relationshipToMC) updated.relationshipToMC = update.relationshipToMC;
  
  // Merge relationships (replace entire array if provided)
  if (update.relationships) {
    updated.relationships = update.relationships;
  }
  
  // Merge past interactions with sliding window
  if (update.pastInteractions) {
    updated.pastInteractions = [
      ...existing.pastInteractions,
      ...update.pastInteractions
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
 * updateRelationship(lina, {
 *   target: "Raka",
 *   status: "fearful"
 * });
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
      status: update.status
    };
  } else {
    // Create new relationship (limit to max 3)
    if (updated.relationships.length < 3) {
      updated.relationships.push({
        target: update.target,
        type: update.type || "knows",
        status: update.status
      });
    }
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
): void {
  if (!characterUpdates && !relationshipUpdates) return;
  
  // Process character updates if they exist
  if (characterUpdates) {
    const { newCharacters = [], updatedCharacters = [] } = characterUpdates;
  
    // Add new characters
    for (const character of newCharacters) {
      state.characters[character.name] = character;
    }
    
    // Update existing characters
    for (const update of updatedCharacters) {
      if (!update.name) continue;
      const existing = state.characters[update.name];
      if (existing) {
        state.characters[update.name] = updateCharacter(existing, update);
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
 *   Relationship to MC: childhood friend with hidden agenda
 *   Recent interactions:
 *     - Page 15: First meeting here, seemed nervous
 *     - Page 10: Avoided questions about parents
 *     - Page 3: Shared secret about basement
 *   Relationships:
 *     - Tom (rival - hostile)
 *     - Sarah (mentor - protective)
 *   Narrative flags: suspicious, has secret, potential twist: betrayal
 *   Status: healthy, active
 * 
 * · Mr. Henderson (stranger) - male, missing [missing]
 *   Bio: Elderly caretaker of the abandoned mansion
 *   Visual description: Frail old man with trembling hands and cloudy eyes
 *   Relationship to MC: mysterious figure with knowledge of mansion history
 *   Recent interactions:
 *     - Page 18: Last seen near basement entrance
 *     - Page 14: Gave cryptic warning about "them"
 *     - Page 7: Told story about previous disappearances
 *   Relationships:
 *     - Sarah (stranger - neutral)
 *   Narrative flags: missing, potential twist: not actually dead
 *   Status: disappeared
 */
export function formatCharactersForPrompt(mc: StoryMC, state?: StoryState): string {
  const mcDetails = [];
  if (mc.bio) mcDetails.push(`  Bio: ${mc.bio}`);

  const mcMainInfo = `· ${mc.name} (MC) - ${mc.age} years old, ${mc.gender}`;
  const mcInfo = mcDetails.length > 0 ? `${mcMainInfo}\n${mcDetails.join('\n')}` : mcMainInfo;

  const { characters = {} } = state || {};
  const sideCharacters = characters 
    // Exclude character with same name as MC's, it's him/herself
    ? Object.values(characters).filter(character => character.name !== mc.name)
    : [];
  
  if (sideCharacters.length === 0) {
    return mcInfo;
  }

  const sideCharactersFormatted = sideCharacters
    .map(character => {
      // Basic character information
      const statusFlags = [];
      if (character.narrativeFlags.isSuspicious) statusFlags.push('suspicious');
      if (character.narrativeFlags.isMissing) statusFlags.push('missing');
      if (character.narrativeFlags.isDead) statusFlags.push('dead');
      if (character.narrativeFlags.hasSecret) statusFlags.push('secret');
      
      const flagString = statusFlags.length > 0 ? ` [${statusFlags.join(', ')}]` : '';
      const mainInfo = `· ${character.name} (${character.role}) - ${character.gender}, ${character.status}${flagString}`;
      const details = [];
      
      // Basic information
      details.push(`  Bio: ${character.bio}`);
      details.push(`  Visual description: ${character.visualDescription}`);
      details.push(`  Relationship to MC: ${character.relationshipToMC}`);
      
      // Recent interactions with nested bullets
      if (character.pastInteractions.length > 0) {
        const recentInteractions = character.pastInteractions
          .sort((a, b) => a.page - b.page)
          .slice(-MAX_PAST_INTERACTIONS);
        details.push(`  Recent interactions:`);
        recentInteractions.forEach((i) => {
          details.push(`    - Page ${i.page}: ${i.interaction}`);
        });
      }
      
      // Character relationships with nested bullets
      if (character.relationships.length > 0) {
        details.push(`  Relationships:`);
        character.relationships.forEach(r => {
          details.push(`    - ${r.target} (${r.type} - ${r.status})`);
        });
      }
      
      // Detailed injuries section
      if (character.injuries && character.injuries.length > 0) {
        details.push(`  Injuries:`);
        character.injuries.forEach((injury: Injury, index: number) => {
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
      if (character.narrativeFlags.isSuspicious) narrativeInfo.push('suspicious');
      if (character.narrativeFlags.isMissing) narrativeInfo.push('missing');
      if (character.narrativeFlags.isDead) narrativeInfo.push('dead');
      if (character.narrativeFlags.hasSecret) narrativeInfo.push('has secret');
      
      if (character.narrativeFlags.potentialTwist && character.narrativeFlags.potentialTwist !== 'none') {
        narrativeInfo.push(`potential twist: ${character.narrativeFlags.potentialTwist}`);
      }
      
      if (narrativeInfo.length > 0) {
        details.push(`  Narrative flags: ${narrativeInfo.join(', ')}`);
      }
      
      // Character status details
      const statusDetails = [];
      if (character.status === 'dead') {
        statusDetails.push('deceased');
      } else if (character.status === 'missing') {
        statusDetails.push('disappeared');
      } else if (character.status === 'injured') {
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
  let lastNamePool: string[];
  
  if (useGenderSpecific) {
    lastNamePool = gender === 'male' ? maleLastNames : femaleLastNames;
  } else {
    lastNamePool = neutralLastNames;
  }
  
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
  
  const fullName = `${randomName} ${randomLastName}`;
  
  // Age generation based on story config
  const age = candidate?.age ?? Math.floor(Math.random() * (MAX_CHARACTER_AGE - MIN_CHARACTER_AGE + 1)) + MIN_CHARACTER_AGE;

  return {
    name: fullName,
    age,
    gender,
    bio: generateRandomCharacterBio(gender),
  };
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