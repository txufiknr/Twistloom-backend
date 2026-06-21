import { CHARACTER_NAMES } from "../config/characters.js";
import { MAX_PAST_INTERACTIONS, MIN_CHARACTER_AGE, MAX_CHARACTER_AGE, MAX_CHARACTERS } from "../config/story.js";
import type { CharacterMemory, CharacterUpdate, CharacterUpdates, RelationshipUpdate, StoryMC, StoryMCCandidate, Injury, InjurySeverity, PastInteraction } from "../types/character.js";
import type { StoryMCState, StoryState } from "../types/story.js";
import type { KnownGender } from "../types/user.js";
import { ucfirst } from "./formatter.js";
import { slugify } from "./text-processing.js";

// ============================================================================
// CHARACTER MEMORY MANAGEMENT SYSTEM
// ============================================================================

/**
 * Calculates the injury severity label based on severity and decay rate
 * @param injury - Injury object with severity and decayPerPage
 * @returns Severity label: 'requires_treatment', 'permanent', 'critical', 'severe', 'moderate', 'mild', or 'none'
 * 
 * @example
 * ```typescript
 * getInjurySeverityLabel({ severity: 0.9, decayPerPage: 0.1 }); // 'critical'
 * getInjurySeverityLabel({ severity: 0.7, decayPerPage: 0.1 }); // 'severe'
 * getInjurySeverityLabel({ severity: 0.5, decayPerPage: 0 }); // 'requires_treatment'
 * getInjurySeverityLabel({ severity: 0.3, decayPerPage: 0.05 }); // 'mild'
 * getInjurySeverityLabel({ severity: 0.1, decayPerPage: 0.05 }); // 'none'
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
 *   narrativeFlags: { potentialTwist: "betrayal" }
 * });
 * ```
 */
export function updateCharacter(existing: CharacterMemory, update: CharacterUpdate, page: number, placeId?: string): CharacterMemory {
  const updated = { ...existing };
  
  // Update basic properties if provided
  if (update.knownName) updated.knownName = update.knownName;
  if (update.recognitionLevel) updated.recognitionLevel = update.recognitionLevel;
  if (update.gender) updated.gender = update.gender;
  if (update.role) updated.role = update.role;
  if (update.bio) updated.bio = update.bio;
  if (update.visualDescription) updated.visualDescription = update.visualDescription;
  if (update.status) updated.status = update.status;
  if (update.secrets) updated.secrets = update.secrets;
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
        relationships: [], // Will be processed later via `relationshipUpdates`
      };
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
}

/**
 * Gets formatted main character information for prompt
 * @param mc - Main character profile
 * @param state - Current story state with inventory and injuries
 * @returns Formatted string with character details, or null if no character data
 * 
 * @example
 * // Basic character without state
 * "Lisa Carter, female, 16 — Shy teenager with social anxiety."
 * 
 * @example
 * // Character with inventory and injuries
 * - Bio: Lisa Carter ("Lisa"), female, 16 — Shy teenager with social anxiety.
 * - Inventory:
 *   - 1x Cellphone (right pants pocket, color: black) - acquired: page 1
 *   - 1x Rugged rope (backpack, color: brown, length: 5-meter) - acquired: page 5 at Haunted House
 * - Injuries:
 *   - Deep cut (left arm, severity: 0.7) - acquired: page 5 at Haunted House
 *     → Consequence (high): Cannot lift heavy objects
 *   - Sprained ankle (right foot, severity: 0.4) - acquired: page 18 at School
 *     → Consequence (medium): Cannot run fast
 */
export function getMainCharacterInfo(params: {
  mc?: StoryMCCandidate | null,
  state?: StoryMCState
}): string | null {
  const { mc, state } = params;
  const { inventory = [], injuries = [] } = state ?? {};
  const mcInfo: string[] = [];

  // Format main character's bio
  if (mc && !Object.values(mc).every((i) => i === undefined)) {
    const info = [`${mc.name}${mc.knownName ? ` ("${mc.knownName}")` : ''}`, mc.gender, mc.age].filter(Boolean).join(', ');
    mcInfo.push(`- Bio: ${info}${mc.bio ? ` — ${mc.bio}` : ''}`);
  }

  // Format inventory items with detailed nested information
  if (inventory.length) {
    const inventoryList = inventory.map(item => {
      const parts = [];
      parts.push(`${item.amount}x`);
      parts.push(item.name);
      
      // TODO: make DRY (traitEntries)
      const traitEntries = item.traits?.map(t => `${t.key}: ${t.value}`) ?? [];
      const details = [item.where, ...traitEntries].filter(Boolean);
      
      let inventoryLine = `  - ${parts.join(' ')}`;
      if (details.length) inventoryLine += ` (${details.join(', ')})`;
      
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
      const injuryLocation = [injury.bodyPart, injury.severity ? `severity: ${injury.severity}` : ''].filter(Boolean).join(', ');
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
 * Formats characters for prompt injection with comprehensive narrative context
 * 
 * Creates a rich, detailed string representation of characters utilizing a clean 
 * separation of physical state, emotional relationship, and plot mechanics.
 * 
 * @param mc - Main character profile
 * @param characters - Record of character memories
 * @returns Formatted string for prompt inclusion
 * 
 * @example
 * ```typescript
 * const characterText = formatCharactersForPrompt(book.mc, state.characters);
 * ```
 * 
 * Output example:
 * · Sarah Chen (MC) - 28 years old, female
 *   - Bio: Shy librarian with hidden past and mysterious family connections
 *   - Known as: Sarah
 * 
 * · Tom Martinez (schoolmate) - male [trusting] - [ID: tom_martinez]
 *   - Real name: "Tom Martinez" (Recognition: full_name_known)
 *   - Bio: Former military medic, now works as security guard
 *   - Visual description: Tall, muscular build with military haircut and tired eyes
 *   - Introduced at page: 5
 *   - Relationship to MC: (friend - trusting - full_name_known) protective friend with secret knowledge
 *   - Recent interactions:
 *     → Page 12: Helped treat Sarah's arm injury
 *     → Page 8: Warned about basement dangers
 *   - Relationships:
 *     → lisa_park: (rival - hostile - full_name_known) Doesn't trust her motives
 *   - Narrative mechanics: potential twist: none
 *   - Physical state: healthy, active
 * 
 * · Lisa (teacher) - female [suspicious, has secret, missing] - [ID: lisa_park]
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
 */
export function formatCharactersForPrompt(mc: StoryMC, characters: Record<string, CharacterMemory>): string {
  const mcDetails = [];
  if (mc.bio) mcDetails.push(`  - Bio: ${mc.bio}`);
  if (mc.knownName) mcDetails.push(`  - Known as: ${mc.knownName}`);

  const mcMainInfo = `· ${mc.name} (MC) - ${mc.age} years old, ${mc.gender}`;
  const mcInfo = mcDetails.length ? `${mcMainInfo}\n${mcDetails.join('\n')}` : mcMainInfo;

  // Exclude character with same name as MC's, it's him/herself
  // Keep keys so we can display character ID (record key)
  const sideCharacters = characters ? Object.entries(characters).filter(([, c]) => c.realName !== mc.name) : [];

  // Early return: still no side characters yet
  if (!sideCharacters.length) return mcInfo;

  // Sort side characters by most recent interaction or introduction.
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
      const { knownName, realName, recognitionLevel, role, gender, status, bio, visualDescription, introducedAtPage, pastInteractions, secrets, relationships, relationshipToMC, narrativeFlags, injuries } = character;
      const useDifferentReference = knownName !== realName;
      const nameUnknown = useDifferentReference && ['never_seen', 'seen', 'alias_known'].includes(recognitionLevel);

      // 1. Resolve Physical Status (SSOT for narrative physical presence)
      let physicalStatusDisplay = 'healthy, active';
      if (status === 'dead') physicalStatusDisplay = 'deceased';
      else if (status === 'missing') physicalStatusDisplay = 'disappeared';
      else if (injuries?.filter(i => i.severity).length) physicalStatusDisplay = 'injured';

      // 2. Resolve Header Tags (Emotional state and quick-glance flags)
      const headerTags = [];
      if (relationshipToMC?.status) headerTags.push(relationshipToMC.status); // e.g. "suspicious", "trusting"
      if (secrets?.length) headerTags.push('has secret');
      if (status === 'dead' || status === 'missing') headerTags.push(status); // Add extreme physical states to header

      const flagString = headerTags.length ? ` [${headerTags.join(', ')}]` : '';
      const mainInfo = `· ${knownName} (${role}) - ${gender}${flagString} - [ID: ${id}]`;
      
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
          if (injury.bodyPart) injuryParts.push(`Location: ${injury.bodyPart}`);
          if (injury.severity !== undefined) injuryParts.push(`Severity: ${injury.severity}`);
          if (injury.consequences) injuryParts.push(`Consequences (${getInjurySeverityLabel(injury)}): ${injury.consequences}`);
          if (injury.pageAcquired) injuryParts.push(`Acquired: page ${injury.pageAcquired}`);
          
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

/**
 * Generates a compact, deterministic character ID from a character name.
 *
 * The first name is preserved in full, while each subsequent name
 * contributes only its initial. Name parts are normalized via
 * {@link slugify} before the ID is constructed.
 *
 * Examples:
 * - "Lisa Park" → "lisa_p"
 * - "John Ronald Reuel Tolkien" → "john_r_r_t"
 * - "Crème Brûlée Smith" → "creme_b_s"
 *
 * @param name - Character name to convert into an ID.
 * @returns A deterministic, normalized character ID.
 */
export function generateCharacterId(name: string): string {
  const parts = name.trim().split(/\s+/).map(part => slugify(part)).filter(Boolean);
  const [first = "", ...rest] = parts;
  return [first, ...rest.map(part => part[0])].join("_");
}
