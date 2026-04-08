import { MAX_PAST_INTERACTIONS } from "../config/story.js";
import type { CharacterMemory, CharacterStatus, CharacterUpdate, CharacterUpdates, NarrativeFlags, RelationshipUpdate, StoryMC, StoryMCCandidate } from "../types/character.js";
import type { StoryState } from "../types/story.js";
import type { Gender } from "../types/user.js";

// ============================================================================
// CHARACTER MEMORY MANAGEMENT SYSTEM
// ============================================================================

/**
 * Creates a new character with default values
 * 
 * @param name - Character's unique name identifier
 * @param gender - Character's gender (male/female/unknown)
 * @param role - Character's role in the story
 * @param bio - Brief 1-sentence character description
 * @param status - Initial relationship status
 * @param relationshipToMC - Relationship to main character
 * @param currentPage - Current page number for tracking
 * @returns New character memory structure
 * 
 * @example
 * ```typescript
 * const character = createCharacter("Lina", "best friend", "Cheerful but secretive", "trusting", "close friend", 3);
 * ```
 */
export function createCharacter(
  name: string,
  gender: Gender,
  role: string,
  bio: string,
  status: CharacterStatus,
  narrativeFlags: NarrativeFlags,
  relationshipToMC: string,
  currentPage: number
): CharacterMemory {
  return {
    name,
    gender,
    role,
    bio,
    status,
    relationshipToMC,
    relationships: [],
    pastInteractions: [],
    lastInteractionAtPage: currentPage,
    narrativeFlags: {
      ...narrativeFlags,
      isSuspicious: narrativeFlags.isSuspicious || status === "suspicious",
      isMissing: narrativeFlags.isMissing || status === "missing",
      isDead: narrativeFlags.isDead || status === "dead",
      hasSecret: narrativeFlags.hasSecret || status === "suspicious" || status === "hostile",
      potentialTwist: narrativeFlags.potentialTwist || (status === "suspicious" ? "betrayal" : "none")
    },
    // places: []
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
 *   pastInteractions: ["Refused to explain what she saw"],
 *   lastInteractionAtPage: 6,
 *   narrativeFlags: { isSuspicious: true }
 * });
 * ```
 */
export function updateCharacter(existing: CharacterMemory, update: CharacterUpdate): CharacterMemory {
  const updated = { ...existing };
  
  // Update status if provided
  if (update.status) {
    updated.status = update.status;
  }
  
  // Merge past interactions with sliding window
  if (update.pastInteractions) {
    updated.pastInteractions = [
      ...existing.pastInteractions,
      ...update.pastInteractions
    ].slice(-MAX_PAST_INTERACTIONS);
  }
  
  // Update last interaction page if provided
  if (update.lastInteractionAtPage !== undefined) {
    updated.lastInteractionAtPage = update.lastInteractionAtPage;
  }
  
  // Merge narrative flags if provided
  if (update.narrativeFlags) {
    updated.narrativeFlags = {
      ...existing.narrativeFlags,
      ...update.narrativeFlags
    };
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
  characterUpdates?: CharacterUpdates
): void {
  // Process character updates if they exist
  if (!characterUpdates) return;

  // Add new characters
  for (const character of characterUpdates.newCharacters) {
    state.characters[character.name] = character;
  }
  
  // Update existing characters
  for (const update of characterUpdates.updatedCharacters) {
    const existing = state.characters[update.name];
    if (existing) {
      state.characters[update.name] = updateCharacter(existing, update);
    }
  }

  // Process relationship updates
  const { relationshipUpdates } = characterUpdates;
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
 * Formats characters for prompt injection
 * 
 * Creates a compact, readable string representation of relevant characters
 * for inclusion in AI prompts.
 * 
 * @param state - Current story state
 * @returns Formatted string for prompt inclusion
 * 
 * @example
 * ```typescript
 * const characterText = formatCharactersForPrompt(state);
 * // Returns: "Lina (best friend) - trusting - last seen: 3\n..."
 * ```
 */
export function formatCharactersForPrompt(characters: Record<string, CharacterMemory>): string {
  const allCharacters = Object.values(characters);
  
  if (allCharacters.length === 0) {
    return "No characters encountered yet.";
  }

  return allCharacters
    .map(character => {
      const mainInfo = `• ${character.name} (${character.role}) - ${character.gender} - ${character.status} - last seen: page ${character.lastInteractionAtPage}`;
      const bio = `  Bio: ${character.bio}`;
      const relationship = `  Relationship to MC: ${character.relationshipToMC}`;
      
      // Format recent interactions if any exist
      const interactions = character.pastInteractions.length > 0 
        ? `  Recent interactions: ${character.pastInteractions.slice(-3).join(', ')}`
        : '';
      
      // Format relationships if any exist
      const relationships = character.relationships.length > 0
        ? `  Relationships: ${character.relationships.map(r => `${r.target} (${r.type} - ${r.status})`).join(', ')}`
        : '';
      
      // Note: CharacterPlaceRelation fields are commented out, so we can't display places
      const details = [bio, relationship, interactions, relationships]
        .filter(Boolean)
        .join('\n');
      
      return `${mainInfo}\n${details}`;
    })
    .join('\n\n');
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
  // Random name pools by gender
  const maleNames = [
    'James', 'Michael', 'David', 'Robert', 'John', 'William', 'Richard', 'Joseph', 'Thomas',
    'Charles', 'Christopher', 'Daniel', 'Matthew', 'Anthony', 'Mark', 'Steven', 'Paul',
    'Kevin', 'Brian', 'George', 'Timothy', 'Jason', 'Edward', 'Jeffrey', 'Ryan',
    'Jacob', 'Gary', 'Nicholas', 'Eric', 'Jonathan', 'Stephen', 'Larry', 'Justin',
    'Scott', 'Brandon', 'Benjamin', 'Samuel', 'Gregory', 'Alexander', 'Patrick', 'Raymond',
    'Jack', 'Dennis', 'Jerry', 'Tyler', 'Aaron', 'Jose', 'Adam', 'Nathan', 'Henry',
    'Zachary', 'Douglas', 'Peter', 'Kyle', 'Austin', 'Walter', 'Harold', 'Jeremy', 'Ethan',
    'Frank', 'Carl', 'Keith', 'Roger', 'Gerald', 'Christian', 'Terry', 'Sean', 'Arthur',
    'Austin', 'Noah', 'Mason', 'Elijah', 'Brendan', 'Tristan', 'Cameron', 'Dylan'
  ];

  const femaleNames = [
    'Sarah', 'Jessica', 'Ashley', 'Emily', 'Samantha', 'Amanda', 'Melissa', 'Deborah',
    'Stephanie', 'Jennifer', 'Elizabeth', 'Lauren', 'Rebecca', 'Michelle', 'Kimberly',
    'Lisa', 'Rachel', 'Heather', 'Betty', 'Dorothy', 'Nancy', 'Karen', 'Sharon',
    'Kelly', 'Nicole', 'Patricia', 'Cynthia', 'Kathleen', 'Angela', 'Brenda', 'Pamela',
    'Emma', 'Olivia', 'Cynthia', 'Isabella', 'Sophia', 'Charlotte', 'Mia', 'Amelia',
    'Harper', 'Evelyn', 'Abigail', 'Emily', 'Elizabeth', 'Sofia', 'Avery', 'Ella'
  ];

  const lastNames = [
    'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez',
    'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor',
    'Moore', 'Jackson', 'Martin', 'Lee', 'Thompson', 'White', 'Harris', 'Sanchez',
    'Clark', 'Ramirez', 'Lewis', 'Robinson', 'Walker', 'Young', 'Allen', 'King', 'Wright',
    'Scott', 'Torres', 'Nguyen', 'Hill', 'Flores', 'Green', 'Adams', 'Baker', 'Gonzalez',
    'Nelson', 'Carter', 'Mitchell', 'Perez', 'Roberts', 'Turner', 'Phillips', 'Campbell',
    'Parker', 'Evans', 'Edwards', 'Collins', 'Stewart', 'Sanchez', 'Morris', 'Rogers',
    'Reed', 'Cook', 'Morgan', 'Bell', 'Murphy', 'Bailey', 'Rivera', 'Cooper', 'Richardson'
  ];

  // Generate or use provided values
  const gender = candidate?.gender ?? (Math.random() > 0.5 ? 'male' : 'female');
  const namePool = gender === 'male' ? maleNames : femaleNames;
  const randomName = candidate?.name ?? namePool[Math.floor(Math.random() * namePool.length)];
  const randomLastName = lastNames[Math.floor(Math.random() * lastNames.length)];
  const fullName = `${randomName} ${randomLastName}`;
  
  // Age generation based on story context (young adult range for thriller stories)
  const age = candidate?.age ?? Math.floor(Math.random() * 15) + 20; // 20-35 range

  return {
    name: fullName,
    age,
    gender
  };
}