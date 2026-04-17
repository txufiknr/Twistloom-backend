import { MAX_PAST_INTERACTIONS, MIN_CHARACTER_AGE, MAX_CHARACTER_AGE } from "../config/story.js";
import type { CharacterMemory, CharacterStatus, CharacterUpdate, CharacterUpdates, NarrativeFlags, RelationshipUpdate, StoryMC, StoryMCCandidate } from "../types/character.js";
import type { StoryState } from "../types/story.js";
import type { Gender, KnownGender } from "../types/user.js";
import { ucfirst } from "./formatter.js";

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
  characterUpdates?: CharacterUpdates,
  relationshipUpdates?: RelationshipUpdate[],
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
 * const characterText = formatCharactersForPrompt(state.characters);
 * // Output example:
 * // · Lina (best friend) - female, trusting - last seen: page 15 [suspicious: true, secret: true]
 * //   Bio: Quiet girl who knows more than she lets on
 * //   Relationship to MC: childhood friend with hidden agenda
 * //   Recent interactions: shared secret about basement, avoided questions about parents
 * //   Relationships: Tom (rival - hostile), Sarah (mentor - protective)
 * //   Narrative flags: suspicious, has secret, potential twist: betrayal
 * //   Status: healthy, active
 * ```
 */
export function formatCharactersForPrompt(characters: Record<string, CharacterMemory>): string {
  const allCharacters = Object.values(characters);
  
  if (allCharacters.length === 0) {
    return "No characters encountered yet.";
  }

  return allCharacters
    .map(character => {
      const details = [];
      
      // Basic character information
      const statusFlags = [];
      if (character.narrativeFlags.isSuspicious) statusFlags.push('suspicious');
      if (character.narrativeFlags.isMissing) statusFlags.push('missing');
      if (character.narrativeFlags.isDead) statusFlags.push('dead');
      if (character.narrativeFlags.hasSecret) statusFlags.push('secret');
      if (character.narrativeFlags.hasInjury && character.narrativeFlags.hasInjury !== 'none') {
        statusFlags.push(`injured: ${character.narrativeFlags.hasInjury}`);
      }
      
      const flagString = statusFlags.length > 0 ? ` [${statusFlags.join(', ')}]` : '';
      const mainInfo = `· ${character.name} (${character.role}) - ${character.gender}, ${character.status} - last seen: page ${character.lastInteractionAtPage}${flagString}`;
      
      // Bio and relationship
      details.push(`  Bio: ${character.bio}`);
      details.push(`  Relationship to MC: ${character.relationshipToMC}`);
      
      // Recent interactions with context
      if (character.pastInteractions.length > 0) {
        const recentInteractions = character.pastInteractions.slice(-MAX_PAST_INTERACTIONS);
        details.push(`  Recent interactions: ${recentInteractions.join(', ')}`);
      }
      
      // Character relationships to other characters
      if (character.relationships.length > 0) {
        const relationships = character.relationships
          .map(r => `${r.target} (${r.type} - ${r.status})`)
          .join(', ');
        details.push(`  Relationships: ${relationships}`);
      }
      
      // Narrative flags and twist information
      const narrativeInfo = [];
      if (character.narrativeFlags.isSuspicious) narrativeInfo.push('suspicious');
      if (character.narrativeFlags.isMissing) narrativeInfo.push('missing');
      if (character.narrativeFlags.isDead) narrativeInfo.push('dead');
      if (character.narrativeFlags.hasSecret) narrativeInfo.push('has secret');
      if (character.narrativeFlags.hasInjury && character.narrativeFlags.hasInjury !== 'none') {
        narrativeInfo.push(`injured: ${character.narrativeFlags.hasInjury}`);
      }
      
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
    'Dylan', 'Luke', 'Asher', 'Oscar', 'Isaac', 'Parker', 'Nolan', 'Ryan', 'Peter',
    'Miles', 'Ezra', 'Hudson', 'Nathaniel', 'Connor', 'Jeremiah', 'Cameron', 'Santiago',
    'Evan', 'Angel', 'Adrian', 'Xavier', 'Kai', 'Jaxson', 'Easton', 'Everett', 'Glenn',
    'Maverick', 'Silas', 'Carson', 'Luka', 'Rowan', 'Axel', 'Bodhi', 'River',
    'Kai', 'Zen', 'Phoenix', 'Orion', 'Atlas', 'Arlo', 'Sage', 'Wilder', 'Finn',
    'Jasper', 'Cyrus', 'Ronan', 'Zion', 'Apollo', 'Stellan', 'Caspian',
    'Storm', 'Blaze', 'Ace', 'Rex', 'Wolf', 'Fox', 'Hawk', 'Jett', 'Dash', 'Knox'
  ];

  // Male-preferring last names (stronger masculine associations)
  const maleLastNames = [
    'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez',
    'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee', 'Vey',
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

  const femaleNames = [
    'Olivia', 'Emma', 'Ava', 'Sophia', 'Isabella', 'Mia', 'Mira', 'Charlotte', 'Amelia',
    'Harper', 'Evelyn', 'Abigail', 'Emily', 'Elizabeth', 'Sofia', 'Avery', 'Ella', 'Anya',
    'Madison', 'Scarlett', 'Victoria', 'Aria', 'Grace', 'Chloe', 'Camila', 'Penelope',
    'Riley', 'Zoey', 'Nora', 'Hannah', 'Lily', 'Addison', 'Luna', 'Aubrey', 'Ellie',
    'Stella', 'Natalie', 'Zoe', 'Leah', 'Hazel', 'Violet', 'Aurora', 'Savannah',
    'Audrey', 'Brooklyn', 'Bella', 'Claire', 'Skylar', 'Lucy', 'Paisley', 'Everly',
    'Anna', 'Caroline', 'Nova', 'Genesis', 'Emilia', 'Kennedy', 'Samantha', 'Maya',
    'Kinsley', 'Naomi', 'Aaliyah', 'Elena', 'Sarah', 'Ariana', 'Allison', 'Kara',
    'Gabriella', 'Alice', 'Madelyn', 'Cora', 'Ruby', 'Eva', 'Seraphina', 'Lyra', 'Elara',
    'Rose', 'Iris', 'Luna', 'Hazel', 'Ivy', 'Ruby', 'Dawn', 'Skye', 'Wren', 'Clara', 'Carla',
    'Poppy', 'Briar', 'Fern', 'Olive', 'Jade', 'Pearl', 'Celeste', 'Orla', 'Elara',
    'Kehlani', 'Billie', 'Zendaya', 'Remi', 'Nyla', 'Kai', 'Indigo', 'Aurelia', 'Sienna',
    'Calliope', 'Juniper', 'Marlowe', 'Thea', 'Elodie', 'Wrenley', 'Arden', 'Loxley',
    'Sloane', 'Blair', 'Quinn', 'Reese', 'Kensington', 'Presley', 'Rachel', 'Lena',
    'Monroe', 'Harlow', 'Kinslee', 'Ensley', 'Finley', 'Tinsley', 'Brinley', 'Rylie',
    'Oakley', 'Ember', 'Nova', 'Lyra', 'Athena', 'Freya', 'Lilith', 'Persephone',
    'Ophelia', 'Cassia', 'Elara', 'Seraphine', 'Evangeline', 'Genevieve', 'Maxine',
    'Juno', 'Celestia', 'Nebula', 'Solstice', 'Equinox', 'Roche', 'Velvet',
    'Zenith', 'Vesper', 'Liora', 'Zara', 'Amara', 'Idris', 'Clementine', 'Marigold',
    'Primrose', 'Bluebell', 'Snowdrop', 'Lisa', 'Lavender', 'Amanda', 'Yuna'
  ];

  const femaleLastNames = [
    'Rose', 'Hazel', 'Ivy', 'Ruby', 'Dawn', 'Skye', 'Vance',
    'Bloom', 'Winters', 'Summers', 'Bliss', 'Grace', 'Hope', 'Joy', 'Faith', 'Love', 'Star',
    'Angel', 'Dream', 'Moon', 'Sun', 'Cloud', 'Rain', 'Storm', 'Blaze', 'Frost', 'Snow', 'Voss',
    'Meadow', 'Brook', 'River', 'Ocean', 'Wave', 'Breeze', 'Dew', 'Mist', 'Crystal', 'Pearl',
    'Iris', 'Lily', 'Daisy', 'Tulip', 'Violet', 'Poppy', 'Marigold', 'Azalea', 'Camellia', 'Jasmine',
    'Rosewood', 'Moonlight', 'Starlight', 'Sunshine', 'Rainbow', 'Butterfly', 'Phoenix', 'Serenity',
    'Harmony', 'Melody', 'Rhythm', 'Cadence', 'Lyric', 'Sonnet', 'Poem', 'Verse', 'Story', 'Tale',
    'Whisper', 'Echo', 'Silence', 'Calm', 'Peace', 'Zen', 'Bliss', 'Joy', 'Glee', 'Cheer', 'Vera',
    'Sparkle', 'Glitter', 'Shimmer', 'Glimmer', 'Glow', 'Shine', 'Bright', 'Radiant', 'Luminous',
    'Celeste', 'Stella', 'Nova', 'Luna', 'Aurora', 'Orion', 'Vega', 'Lyra', 'Cassiopeia', 'Carinae',
    'Meteora', 'Lynn', 'Nyx', 'Patel', 'Shah', 'Verma', 'Malhotra', 'Agarwal', 'Jain', 'Gabriela',
    'Rosa', 'Maria', 'Sofia', 'Isabella', 'Catalina', 'Valentina', 'Emilia', 'Camila', 'Lucia',
    'Yoon', 'Lim', 'Han', 'Shin', 'Chen', 'Apolonia', 'Cassiopeia', 'Lunaria', 'Stellaria',
    'Garcia', 'Rivera', 'Oliveira', 'Ferreira', 'Costa', 'Almeida', 'Rocha'
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