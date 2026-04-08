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
        ? `  Recent interactions: ${character.pastInteractions.slice(-MAX_PAST_INTERACTIONS).join(', ')}`
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
  // Random name pools by gender with Gen-Z appropriate names
  const maleNames = [
    'Liam', 'Noah', 'Oliver', 'Elijah', 'Lucas', 'Mason', 'Logan', 'Ethan', 'Aiden',
    'James', 'Benjamin', 'William', 'Jacob', 'Michael', 'Caleb', 'Daniel', 'Jackson',
    'Sebastian', 'Jack', 'Owen', 'Grayson', 'Julian', 'Levi', 'Mateo', 'Josiah',
    'Henry', 'Theodore', 'Wyatt', 'Gabriel', 'Samuel', 'Carter', 'Jayden', 'John',
    'Dylan', 'Luke', 'Asher', 'Oscar', 'Isaac', 'Parker', 'Nolan', 'Ryan',
    'Miles', 'Ezra', 'Hudson', 'Nathaniel', 'Connor', 'Jeremiah', 'Cameron', 'Santiago',
    'Evan', 'Angel', 'Adrian', 'Xavier', 'Kai', 'Jaxson', 'Easton', 'Everett',
    'Maverick', 'Silas', 'Carson', 'Luka', 'Rowan', 'Axel', 'Bodhi', 'River',
    'Kai', 'Zen', 'Phoenix', 'Orion', 'Atlas', 'Arlo', 'Sage', 'Wilder', 'Finn',
    'Jasper', 'Cyrus', 'Ronan', 'Koa', 'Zion', 'Apollo', 'Stellan', 'Caspian',
    'Storm', 'Blaze', 'Ace', 'Rex', 'Wolf', 'Fox', 'Hawk', 'Jett', 'Dash', 'Knox'
  ];

  const femaleNames = [
    'Olivia', 'Emma', 'Ava', 'Sophia', 'Isabella', 'Mia', 'Charlotte', 'Amelia',
    'Harper', 'Evelyn', 'Abigail', 'Emily', 'Elizabeth', 'Sofia', 'Avery', 'Ella',
    'Madison', 'Scarlett', 'Victoria', 'Aria', 'Grace', 'Chloe', 'Camila', 'Penelope',
    'Riley', 'Zoey', 'Nora', 'Hannah', 'Lily', 'Addison', 'Luna', 'Aubrey', 'Ellie',
    'Stella', 'Natalie', 'Zoe', 'Leah', 'Hazel', 'Violet', 'Aurora', 'Savannah',
    'Audrey', 'Brooklyn', 'Bella', 'Claire', 'Skylar', 'Lucy', 'Paisley', 'Everly',
    'Anna', 'Caroline', 'Nova', 'Genesis', 'Emilia', 'Kennedy', 'Samantha', 'Maya',
    'Willow', 'Kinsley', 'Naomi', 'Aaliyah', 'Elena', 'Sarah', 'Ariana', 'Allison',
    'Gabriella', 'Alice', 'Madelyn', 'Cora', 'Ruby', 'Eva', 'Seraphina', 'Lyra',
    'Iris', 'Luna', 'Willow', 'Hazel', 'Ivy', 'Ruby', 'Sage', 'Dawn', 'Skye', 'Wren',
    'Poppy', 'Briar', 'Fern', 'Olive', 'Jade', 'Pearl', 'Celeste', 'Orla', 'Elara',
    'Kehlani', 'Billie', 'Zendaya', 'Remi', 'Nyla', 'Kai', 'Indigo', 'Aurelia', 'Sienna',
    'Calliope', 'Juniper', 'Marlowe', 'Thea', 'Elodie', 'Wrenley', 'Arden', 'Loxley',
    'Sloane', 'Blair', 'Quinn', 'Reese', 'Rowan', 'Sutton', 'Kensington', 'Presley',
    'Monroe', 'Harlow', 'Kinslee', 'Ensley', 'Finley', 'Tinsley', 'Brinley', 'Rylie',
    'Oakley', 'Ember', 'Nova', 'Lyra', 'Athena', 'Freya', 'Lilith', 'Persephone',
    'Ophelia', 'Cassia', 'Elara', 'Seraphine', 'Evangeline', 'Genevieve', 'Maxine',
    'Juno', 'Calypso', 'Andromeda', 'Celestia', 'Nebula', 'Solstice', 'Equinox',
    'Zenith', 'Vesper', 'Liora', 'Zara', 'Amara', 'Idris', 'Clementine', 'Marigold',
    'Primrose', 'Bluebell', 'Snowdrop', 'Lisa', 'Lavender', 'Amanda', 'Yuna'
  ];

  const femaleLastNames = [
    'Rose', 'Willow', 'Hazel', 'Ivy', 'Ruby', 'Sage', 'Dawn', 'Skye',
    'Bloom', 'Winters', 'Summers', 'Bliss', 'Grace', 'Hope', 'Joy', 'Faith', 'Love', 'Star',
    'Angel', 'Dream', 'Moon', 'Sun', 'Cloud', 'Rain', 'Storm', 'Blaze', 'Frost', 'Snow',
    'Meadow', 'Brook', 'River', 'Ocean', 'Wave', 'Breeze', 'Dew', 'Mist', 'Crystal', 'Pearl',
    'Iris', 'Lily', 'Daisy', 'Tulip', 'Violet', 'Poppy', 'Marigold', 'Azalea', 'Camellia', 'Jasmine',
    'Rosewood', 'Moonlight', 'Starlight', 'Sunshine', 'Rainbow', 'Butterfly', 'Phoenix', 'Serenity',
    'Harmony', 'Melody', 'Rhythm', 'Cadence', 'Lyric', 'Sonnet', 'Poem', 'Verse', 'Story', 'Tale',
    'Whisper', 'Echo', 'Silence', 'Calm', 'Peace', 'Zen', 'Bliss', 'Joy', 'Glee', 'Cheer', 'Vera',
    'Sparkle', 'Glitter', 'Shimmer', 'Glimmer', 'Glow', 'Shine', 'Bright', 'Radiant', 'Luminous',
    'Celeste', 'Stella', 'Nova', 'Luna', 'Aurora', 'Orion', 'Vega', 'Lyra', 'Cassiopeia', 'Carinae',
    'Meteora', 'Lynn', 'Nyx',
    'Rosa', 'Maria', 'Sofia', 'Isabella', 'Catalina', 'Valentina', 'Emilia', 'Camila', 'Lucia', 'Gabriela',
    'Yoon', 'Lim', 'Han', 'Shin', 'Chen', 'Apolonia', 'Cassiopeia', 'Lunaria', 'Stellaria',
    'Patel', 'Shah', 'Verma', 'Malhotra', 'Agarwal', 'Jain',
    'Garcia', 'Rivera', 'Oliveira', 'Ferreira', 'Costa', 'Almeida', 'Rocha'
  ];

  // Male-preferring last names (stronger masculine associations)
  const maleLastNames = [
    'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez',
    'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee',
    'Thompson', 'White', 'Harris', 'Clark', 'Ramirez', 'Lewis', 'Robinson', 'Walker',
    'Young', 'Allen', 'King', 'Wright', 'Scott', 'Torres', 'Nguyen', 'Hill', 'Flores',
    'Green', 'Adams', 'Baker', 'Gonzalez', 'Nelson', 'Carter', 'Mitchell', 'Perez',
    'Roberts', 'Turner', 'Phillips', 'Campbell', 'Parker', 'Evans', 'Edwards', 'Collins',
    'Stewart', 'Sanchez', 'Morris', 'Rogers', 'Reed', 'Cook', 'Morgan', 'Bell', 'Murphy',
    'Bailey', 'Cooper', 'Richardson', 'Cox', 'Howard', 'Ward', 'Torres', 'Peterson', 'Gray',
    'Ramirez', 'James', 'Watson', 'Brooks', 'Kelly', 'Sanders', 'Price', 'Bennett', 'Wood',
    'Barnes', 'Ross', 'Henderson', 'Coleman', 'Jenkins', 'Perry', 'Powell', 'Long', 'Patterson',
    'Hughes', 'Flores', 'Washington', 'Butler', 'Simmons', 'Foster', 'Gonzalez', 'Bryant', 'Alexander',
    'Russell', 'Griffin', 'Diaz', 'Hayes', 'Myers', 'Ford', 'Hamilton', 'Graham', 'Sullivan', 'Wallace'
  ];

  // Gender-neutral last names (modern and Gen-Z appropriate)
  const neutralLastNames = [
    'Stone', 'Wolf', 'Fox', 'Hawk', 'Raven', 'Crow', 'Phoenix', 'Falcon', 'Eagle', 'Hawk',
    'River', 'Brook', 'Stone', 'Rock', 'Cliff', 'Ridge', 'Peak', 'Summit', 'Valley', 'Meadow',
    'Wolf', 'Bear', 'Lion', 'Tiger', 'Eagle', 'Hawk', 'Falcon', 'Raven', 'Crow', 'Phoenix',
    'Storm', 'Blaze', 'Frost', 'Ice', 'Snow', 'Rain', 'Thunder', 'Lightning', 'Shadow', 'Night',
    'Star', 'Moon', 'Sun', 'Sky', 'Cloud', 'Wind', 'Earth', 'Fire', 'Water', 'Spirit',
    'Silver', 'Gold', 'Bronze', 'Copper', 'Steel', 'Iron', 'Crystal', 'Diamond', 'Ruby', 'Jade',
    'Rowan', 'Sage', 'Wren', 'Linden', 'Indigo', 'Marlowe', 'August', 'Sawyer', 'Robin', 'Taylor',
    'Morgan', 'Casey', 'Drew', 'Jamie', 'Jordan', 'Taylor', 'Logan', 'Casey', 'Dakota', 'River',
    'August', 'Sage', 'Wren', 'Linden', 'Indigo', 'Marlowe', 'Rowan', 'Robin', 'Taylor', 'Morgan'
  ];

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
  
  const randomName = candidate?.name ?? namePool[Math.floor(Math.random() * namePool.length)];
  const randomLastName = lastNamePool[Math.floor(Math.random() * lastNamePool.length)];
  const fullName = `${randomName} ${randomLastName}`;
  
  // Age generation based on story context (young adult range for thriller stories)
  const age = candidate?.age ?? Math.floor(Math.random() * 15) + 20; // 20-35 range

  return {
    name: fullName,
    age,
    gender,
    bio: '',
  };
}