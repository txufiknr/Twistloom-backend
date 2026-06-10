import { MAX_ACTION_HISTORY, MAX_CHARACTERS, MAX_DOMINANT_TRAITS, MAX_FUTURE_NOTES, MAX_PLACES, MAX_TRAUMA_TAGS } from "../config/story.js";
import { HIDDEN_STATE_DEFAULTS, STORY_STATE_DEFAULTS } from "../schema/story.js";
import { storyPhases, plotFlagTypes } from "../types/story.js";
import { processCharacterUpdates } from "./characters.js";
import { processPlaceUpdates } from "./places.js";
import { deepEqualSimple } from "../utils/parser.js";
import type { StoryState, PsychologicalProfile, Archetype, StabilityLevel, ManipulationAffinity, EndingType, HiddenState, EndingPlanType, EndingPlan, ProfileShiftType, ProfileShift, StoryStateInfo, StoryPhase, FinalePhase, StateDelta, StoryGeneration, FlagLevel, PlotFlag, TagUpdates, StateDeltaGeneration, TagItem, FutureNote, FactUpdate, FutureNoteGeneration, Action, PsychologicalStateDelta, InitialPlotFlag, StoryScene } from "../types/story.js";
import type { Injury, InventoryItem } from "../types/character.js";
import type { ThreadUpdates, StoryThread } from "../types/thread.js";
import type { CandidateGenerationPage } from "../types/candidate-generation.js";

/**
 * Extract state delta from generated page for database storage
 * 
 * Takes the AI-generated page content and extracts the state changes
 * to be stored in the database for state reconstruction.
 * 
 * @param generation - AI-generated page with state updates
 * @returns StateDelta object for database storage
 * 
 * @example
 * ```typescript
 * const delta = extractStateDelta(generatedPage);
 * ```
 */
export function extractStateDelta(generation: StoryGeneration, expectedPageNumber: number, futureNoteKeys: string[]): StateDelta {
  if (expectedPageNumber === 1) return {};
  const { place, futureNoteUpdates } = generation;

  const stateDelta: StateDelta = {
    flagUpdates: generation.flagUpdates,
    traumaTagUpdates: generation.traumaTagUpdates,
    futureNoteUpdates: futureNoteUpdates ? {
      ...futureNoteUpdates,
      add: mapFutureNoteWithKey(futureNoteUpdates.add, expectedPageNumber, futureNoteKeys),
    } satisfies TagUpdates<FutureNote> : undefined,
    factUpdates: generation.factUpdates,
    characterUpdates: generation.characterUpdates,
    relationshipUpdates: generation.relationshipUpdates,
    placeUpdates: generation.placeUpdates,
    threadUpdates: generation.threadUpdates,
    viableEnding: generation.viableEnding,
    isMajorEvent: generation.addPlotFlags?.some(p => p.isMajorEvent),
    contextHistory: generation.contextHistory,
    addPlotFlags: generation.addPlotFlags,
    // Tag with current place for context
    inventory: generation.inventory?.map(inventory => inventory.pageAcquired === expectedPageNumber ? ({ ...inventory, place }) : inventory),
    injuries: generation.injuries?.map(injury => injury.pageAcquired === expectedPageNumber ? ({ ...injury, place }) : injury),
  } satisfies Record<keyof StateDeltaGeneration | 'isMajorEvent', unknown>;

  return stateDelta;
}

export function mapFutureNoteWithKey(notes: FutureNoteGeneration[] | undefined, expectedPageNumber: number, futureNoteKeys: string[]): FutureNote[] {
  return notes?.map(note => {
    const tag = note.tag || 'other';
    const key = generateUniqueId(tag, futureNoteKeys);
    futureNoteKeys.push(key);
    return { ...note, addedAtPage: expectedPageNumber, key };
  }) ?? [];
}

/**
 * Calculates psychological state deltas between base and new state
 * 
 * This function compares two story states and extracts the differences
 * in psychological profile, hidden state, memory integrity, and difficulty.
 * 
 * @param baseState - Base story state before updates
 * @param newState - Updated story state after applying AI updates
 * @returns Partial state delta with psychological changes
 * 
 * @example
 * ```typescript
 * const psychologicalDeltas = calculatePsychologicalDeltas(baseState, updatedState);
 * // Returns: { psychologicalProfileUpdates, hiddenStateUpdates, ... }
 * ```
 */
export function calculatePsychologicalDeltas(baseState: StoryState, newState: StoryState): PsychologicalStateDelta {
  const deltas: PsychologicalStateDelta = {};

  // Check for psychological profile changes
  if (!deepEqualSimple(baseState.psychologicalProfile, newState.psychologicalProfile)) {
    const profileUpdates: Partial<PsychologicalProfile> = {};
    
    // Compare each property with explicit typing
    if (baseState.psychologicalProfile.archetype !== newState.psychologicalProfile.archetype) {
      profileUpdates.archetype = newState.psychologicalProfile.archetype;
    }
    if (baseState.psychologicalProfile.stability !== newState.psychologicalProfile.stability) {
      profileUpdates.stability = newState.psychologicalProfile.stability;
    }
    if (!deepEqualSimple(baseState.psychologicalProfile.dominantTraits, newState.psychologicalProfile.dominantTraits)) {
      profileUpdates.dominantTraits = newState.psychologicalProfile.dominantTraits;
    }
    if (baseState.psychologicalProfile.manipulationAffinity !== newState.psychologicalProfile.manipulationAffinity) {
      profileUpdates.manipulationAffinity = newState.psychologicalProfile.manipulationAffinity;
    }
    
    if (Object.keys(profileUpdates).length) {
      deltas.psychologicalProfileUpdates = profileUpdates;
    }
  }

  // Check for hidden state changes
  if (!deepEqualSimple(baseState.hiddenState, newState.hiddenState)) {
    const hiddenUpdates: Partial<HiddenState> = {};
    
    // Compare each property with explicit typing
    if (baseState.hiddenState.truthLevel !== newState.hiddenState.truthLevel) {
      hiddenUpdates.truthLevel = newState.hiddenState.truthLevel;
    }
    if (baseState.hiddenState.threatProximity !== newState.hiddenState.threatProximity) {
      hiddenUpdates.threatProximity = newState.hiddenState.threatProximity;
    }
    if (baseState.hiddenState.realityStability !== newState.hiddenState.realityStability) {
      hiddenUpdates.realityStability = newState.hiddenState.realityStability;
    }
    if (!deepEqualSimple(baseState.hiddenState.endingPlan, newState.hiddenState.endingPlan)) {
      hiddenUpdates.endingPlan = newState.hiddenState.endingPlan;
    }
    if (!deepEqualSimple(baseState.hiddenState.profileShift, newState.hiddenState.profileShift)) {
      hiddenUpdates.profileShift = newState.hiddenState.profileShift;
    }
    
    if (Object.keys(hiddenUpdates).length) {
      deltas.hiddenStateUpdates = hiddenUpdates;
    }
  }

  // Check for memory integrity changes
  if (baseState.memoryIntegrity !== newState.memoryIntegrity) {
    deltas.memoryIntegrity = newState.memoryIntegrity;
  }

  // Check for difficulty changes
  if (baseState.difficulty !== newState.difficulty) {
    deltas.difficulty = newState.difficulty;
  }

  if (Object.keys(deltas).length) {
    console.log(`[calculatePsychologicalDeltas] ✅ Calculated psychological state delta:`, deltas);
  } else {
    console.warn(`[calculatePsychologicalDeltas] ⚠️ No psychological state update`);
  }

  return deltas;
}

/**
 * Applies AI-generated state delta to story state
 * 
 * This function applies incremental changes from a StateDelta (extracted from
 * AI-generated page content) to a StoryState, producing a new state with all
 * updates applied. This is used after page generation to apply the AI's
 * creative updates to the advanced story state.
 * 
 * Typical usage flow:
 * 1. User selects action on page N
 * 2. `advanceStoryState` advances state from page N to page N+1 (deterministic)
 * 3. AI generates page N+1 based on advanced state
 * 4. `applyStateDelta` applies AI's updates to the advanced state (creative)
 * 5. Result becomes the final state for page N+1
 * 
 * This function is also used for reconstructing story states from stored deltas
 * when loading previously generated pages.
 * 
 * @param baseState - Base story state to apply delta to (typically the advanced state from `advanceStoryState`)
 * @param stateDelta - State delta containing AI-generated incremental changes
 * @returns New story state with delta applied
 * 
 * @example
 * ```typescript
 * // After generating page 2, apply AI's updates
 * const advancedState = await advanceStoryState(currentState, actionedPage);
 * const generatedPage = await generatePage(advancedState);
 * const stateDelta = extractStateDelta(generatedPage);
 * const finalState = applyStateDelta(advancedState, stateDelta);
 * // finalState now includes both user-driven and AI-driven changes
 * ```
 */
export function applyStateDelta(baseState: StoryState, stateDelta: StateDelta, scene?: StoryScene): StoryState {
  const {
    flagUpdates,
    traumaTagUpdates,
    futureNoteUpdates,
    addPlotFlags,
    factUpdates,
    characterUpdates,
    relationshipUpdates,
    placeUpdates,
    threadUpdates,
    viableEnding,
    isMajorEvent,
    contextHistory,
    inventory,
    injuries,
    psychologicalProfileUpdates,
    hiddenStateUpdates,
    memoryIntegrity,
    difficulty,
  } = stateDelta;

  // Explicitly copy every mutable array/object field so that
  // in-place mutations by processXxx helpers never bleed back into baseState.
  // Without these explicit copies, `{ ...baseState }` only creates a shallow
  // object clone — all array/object values remain the same references.
  const newState: StoryState = {
    ...baseState,
    // ── mutable arrays ──────────────────────────────────────────────────────
    plotFlags:      [...baseState.plotFlags],
    traumaTags:     [...baseState.traumaTags],
    futureNotes:    [...baseState.futureNotes],
    threads:        [...baseState.threads],
    actionsHistory: [...baseState.actionsHistory],
    injuries:       [...baseState.injuries],
    inventory:      [...baseState.inventory],
    // ── mutable record objects ───────────────────────────────────────────────
    characters:     { ...baseState.characters },
    places:         { ...baseState.places },
    // ── scalar delta overrides ───────────────────────────────────────────────
    flags:          { ...baseState.flags },
    isMajorEvent:   isMajorEvent ?? baseState.isMajorEvent,
    contextHistory: contextHistory || baseState.contextHistory,
    viableEnding: viableEnding ? { text: viableEnding.text || baseState.viableEnding?.text, type: viableEnding.type || baseState.viableEnding?.type } : baseState.viableEnding,
    psychologicalProfile: psychologicalProfileUpdates ? { ...baseState.psychologicalProfile, ...psychologicalProfileUpdates } : baseState.psychologicalProfile,
    hiddenState: hiddenStateUpdates ? { ...baseState.hiddenState, ...hiddenStateUpdates } : baseState.hiddenState,
    memoryIntegrity: memoryIntegrity ?? baseState.memoryIntegrity,
    difficulty: difficulty ?? baseState.difficulty,
  };

  // Mutating helpers are now safe: they operate on freshly-copied arrays/objects
  processTraumaTagUpdates(newState, traumaTagUpdates);
  processFutureNoteUpdates(newState, futureNoteUpdates);
  processPlotFlagUpdates(newState, addPlotFlags, scene);
  processFactUpdates(newState, factUpdates);
  processCharacterUpdates(newState, characterUpdates, relationshipUpdates, scene?.place);
  processPlaceUpdates(newState, placeUpdates, scene);
  processThreadUpdates(newState, threadUpdates);

  // Apply flag updates — each update contains a `type` and `level`.
  if (flagUpdates?.length) {
    newState.flags = { ...newState.flags };
    for (const flagUpdate of flagUpdates) {
      newState.flags[flagUpdate.type] = flagUpdate.level;
    }
  }

  // Apply inventory updates (full replacements, remove which has amount of 0)
  if (inventory?.length) newState.inventory = cleanUpInventory(inventory);
  // Apply injury updates (full replacements, remove which has severity of 0)
  if (injuries?.length) newState.injuries = removeHealedInjuries(injuries);

  return newState;
}

/**
 * Cleans up inventory by removing items with zero amount
 * @param inventory 
 * @returns 
 */
export function cleanUpInventory(inventory: InventoryItem[]): InventoryItem[] {
  return inventory.filter(item => item.amount !== 0);
}

// ============================================================================
// INJURY DECAY SYSTEM
// ============================================================================

/**
 * Applies decay to injuries based on their decay rate
 * 
 * @param injuries - Array of injuries to decay
 * @returns Array of injuries with updated severity, filtered out if healed
 */
function decayInjuries(injuries: Injury[]): Injury[] {
  const healedInjuries = injuries.map(injury => {
    // Permanent injury (no change)
    if (!injury.severity || !injury.decayPerPage || injury.decayPerPage === 0) return injury;
    
    // Return updated injury, or mark as healed if severity reaches 0
    const newSeverity = Math.max(0, injury.severity - injury.decayPerPage);
    return { ...injury, severity: newSeverity };
  });

  // Remove fully healed injuries
  return removeHealedInjuries(healedInjuries);
}

function removeHealedInjuries(injuries: Injury[]): Injury[] {
  return injuries.filter(injury => !injury.severity || injury.severity > 0);
}

/**
 * Advances story state to prepare for next page generation based on user's selected action
 *
 * This function takes the story state for the current page (page N) and advances it
 * to prepare for generating the next page (page N+1). It handles deterministic,
 * user-driven progression: incrementing page number, recording the selected action
 * in history, updating psychological flags based on action type, escalating hidden
 * state (threat proximity, reality stability), decaying injuries, and updating
 * psychological profiles.
 *
 * Note: This function does NOT apply AI-generated state deltas. AI updates are
 * applied separately via `applyStateDelta` after the next page is generated.
 *
 * @param state - Story state for the current page (page N) to be advanced
 * @param actionedPage - Current page with the user's selected action
 * @returns Promise resolving to advanced story state ready for page N+1 generation
 *
 * @example
 * ```typescript
 * // User is on page 1 and selects action A
 * const currentState = await getStoryStateWithBranch(bookId, page1Id);
 * const advancedState = await advanceStoryState(currentState, {
 *   page: 1,
 *   actions: [{ type: 'explore', text: 'Investigate the noise' }],
 *   selectedAction: { type: 'explore', hint: { text: 'Something lurks inside' } }
 * });
 * // advancedState.page is now 2, action recorded in history, flags updated
 * // This advancedState is used as base for generating page 2
 * ```
 */
export async function advanceStoryState(state: StoryState, actionedPage: Pick<CandidateGenerationPage, 'page' | 'actions' | 'action'>): Promise<StoryState> {
  // Find the index of selected action to get the letter
  const { actions: allActions, action, page } = actionedPage;
  const selectedIndex = allActions.findIndex(action => action.text === action.text);
  const selectedLetter = String.fromCharCode(65 + selectedIndex); // A, B, C, etc.

  console.log(`[advanceStoryState] ⚡ Advancing story state from page ${page} for selecting: ${selectedLetter}. ${action.text} (type: ${action.type})`);
  const updatedState = structuredClone(state);

  // Increment page number
  updatedState.page++;

  // Sanity check to ensure page number was incremented correctly
  if (updatedState.page !== page + 1) {
    console.error(`[advanceStoryState] ❌ Page number mismatch after incrementing. Expected: ${page + 1}, Actual: ${updatedState.page}`);
    updatedState.page = page + 1;
  }

  // Remove any items which has zero amount
  if (updatedState.inventory && updatedState.inventory.length > 0) {
    updatedState.inventory = cleanUpInventory(updatedState.inventory);
  }

  // Apply injury decay to MC injuries
  if (updatedState.injuries && updatedState.injuries.length > 0) {
    updatedState.injuries = decayInjuries(updatedState.injuries);
  }

  // Apply injury decay to all characters
  Object.values(updatedState.characters).forEach(character => {
    if (character.injuries && character.injuries.length > 0) {
      character.injuries = decayInjuries(character.injuries);
    }
  });

  // Update psychological flags based on action type
  updateFlags(updatedState, actionedPage.action);

  // Escalate story tension and hidden state
  updateHiddenState(updatedState);

  // Update psychological profile based on new state
  updatePsychologicalProfile(updatedState);

  // Update advanced ending systems (profile shifts, fake endings)
  updateAdvancedEndingSystems(updatedState);

  return updatedState;
}

/**
 * Generates a unique key by appending an incrementing numeric suffix.
 * @param key - The base string (e.g., "location")
 * @param existingKeys - Array of keys that already exist
 * @returns A unique string guaranteed not to be in existingKeys (e.g., "location_1")
 */
export function generateUniqueId(key: string, existingKeys: string[]): string {
  const existingSet = new Set(existingKeys);
  let counter = 1;
  
  while (true) {
    const candidateId = `${key}_${counter}`;
    if (!existingSet.has(candidateId)) {
      return candidateId;
    }
    counter++;
  }
}

/**
 * Updates psychological flags using multi-factor analysis
 * 
 * Uses sophisticated scoring system considering action type, story progress,
 * current psychological state, trauma accumulation, and hidden state.
 * Implements hysteresis to prevent flag oscillation and ensures gradual
 * progression that reflects the MC's deteriorating mental state.
 * 
 * PSYCHOLOGICAL PROGRESSION:
 * As pages increase: MC becomes less reliable, flags become more volatile,
 * trust erodes, fear intensifies, guilt accumulates, curiosity warps.
 * 
 * @param state - Current story state
 * @param action - User action with type classification
 */
function updateFlags(state: StoryState, action?: Action): void {
  if (!action) return;

  const pageProgress = state.page / state.maxPage;
  const traumaCount = state.traumaTags.length;
  const isLatePhase = pageProgress > 0.7;
  const isEarlyPhase = pageProgress < 0.3;
  const difficultyModifier = state.difficulty === 'nightmare' ? 0.2 : 0;

  // ========================
  // TRUST FLAG CALCULATION
  // ========================
  let trustScore = getFlagScore(state.flags.trust);
  
  // Base action influence
  switch (action.type) {
    case "social": trustScore += 0.3; break;     // Social builds trust
    case "explore": trustScore += 0.1; break;    // Exploration builds some trust
    case "protect": trustScore += 0.4; break;    // Protecting others strongly builds trust
    case "heal": trustScore += 0.3; break;       // Healing builds trust
    case "create": trustScore += 0.1; break;     // Creation builds some trust
    case "dialogue": trustScore += 0.2; break;   // Dialogue builds trust
    case "risk": trustScore -= 0.4; break;       // Risky actions damage trust
    case "escape": trustScore -= 0.3; break;     // Escape shows distrust
    case "ignore": trustScore -= 0.2; break;     // Ignoring erodes trust
    case "attack": trustScore -= 0.3; break;     // Attack damages trust
    case "deceive": trustScore -= 0.5; break;    // Deception severely damages trust
    case "custom": trustScore += 0.05; break;    // Custom actions have minimal trust impact
    case "other": trustScore += 0.05; break;     // Other actions have minimal trust impact
  }

  // Context modifiers
  if (state.hiddenState.truthLevel === 'mostly_false') trustScore -= 0.3;
  if (state.flags.fear === 'high') trustScore -= 0.2;
  if (traumaCount > 5) trustScore -= 0.1;
  if (isLatePhase) trustScore -= 0.15; // Trust erodes faster in late phase
  trustScore -= difficultyModifier;

  // Apply hysteresis and update
  state.flags.trust = updateFlagWithHysteresis(state.flags.trust, trustScore, 0.15);

  // ========================
  // FEAR FLAG CALCULATION
  // ========================
  let fearScore = getFlagScore(state.flags.fear);
  
  // Base action influence
  switch (action.type) {
    case "escape": fearScore += 0.4; break;      // Escape increases fear
    case "risk": fearScore += 0.3; break;        // Risk increases fear
    case "attack": fearScore += 0.2; break;      // Attack can create fear
    case "explore": fearScore += 0.2; break;     // Exploration can be scary
    case "ignore": fearScore += 0.1; break;      // Ignoring creates fear
    case "deceive": fearScore += 0.2; break;     // Deception creates fear
    case "social": fearScore -= 0.1; break;      // Social reduces fear slightly
    case "protect": fearScore -= 0.1; break;     // Protecting reduces fear
    case "heal": fearScore -= 0.2; break;        // Healing reduces fear
    case "create": fearScore -= 0.1; break;      // Creation reduces fear
    case "dialogue": fearScore -= 0.05; break;   // Dialogue reduces fear
    case "custom": fearScore += 0.05; break;     // Custom actions have minimal fear impact
    case "other": fearScore += 0.05; break;      // Other actions have minimal fear impact
  }

  // Context modifiers
  if (state.hiddenState.threatProximity === 'immediate') fearScore += 0.4;
  if (state.hiddenState.threatProximity === 'near') fearScore += 0.2;
  if (state.hiddenState.realityStability === 'broken') fearScore += 0.3;
  if (state.memoryIntegrity === 'corrupted') fearScore += 0.2;
  if (isLatePhase) fearScore += 0.2; // Fear intensifies in late phase
  fearScore += difficultyModifier;

  // Apply hysteresis and update
  state.flags.fear = updateFlagWithHysteresis(state.flags.fear, fearScore, 0.1);

  // ========================
  // GUILT FLAG CALCULATION
  // ========================
  let guiltScore = getFlagScore(state.flags.guilt);
  
  // Base action influence
  switch (action.type) {
    case "deceive": guiltScore += 0.4; break;     // Deception creates strong guilt
    case "attack": guiltScore += 0.3; break;      // Attack creates guilt
    case "risk": guiltScore += 0.3; break;        // Risky actions create guilt
    case "ignore": guiltScore += 0.3; break;      // Ignoring creates guilt
    case "escape": guiltScore += 0.1; break;      // Escape can create guilt
    case "social": guiltScore += 0.2; break;      // Social interactions create guilt
    case "protect": guiltScore -= 0.1; break;     // Protecting reduces guilt
    case "heal": guiltScore -= 0.2; break;        // Healing reduces guilt
    case "create": guiltScore -= 0.1; break;      // Creation reduces guilt
    case "dialogue": guiltScore += 0.05; break;   // Dialogue can create guilt
    case "explore": guiltScore -= 0.1; break;     // Exploration reduces guilt
    case "custom": guiltScore += 0.05; break;     // Custom actions have minimal guilt impact
    case "other": guiltScore += 0.05; break;      // Other actions have minimal guilt impact
  }

  // Context modifiers
  if (state.flags.trust === 'low') guiltScore += 0.2;
  if (state.flags.fear === 'high') guiltScore += 0.1;
  if (traumaCount > 3) guiltScore += 0.1;
  if (!isEarlyPhase) guiltScore += 0.1; // Guilt accumulates after early phase
  guiltScore += difficultyModifier * 0.5;

  // Apply hysteresis and update
  state.flags.guilt = updateFlagWithHysteresis(state.flags.guilt, guiltScore, 0.12);

  // ========================
  // CURIOSITY FLAG CALCULATION
  // ========================
  let curiosityScore = getFlagScore(state.flags.curiosity);
  
  // Base action influence
  switch (action.type) {
    case "explore": curiosityScore += 0.4; break;   // Exploration drives curiosity
    case "risk": curiosityScore += 0.3; break;      // Risk requires curiosity
    case "create": curiosityScore += 0.3; break;    // Creation drives curiosity
    case "dialogue": curiosityScore += 0.2; break;  // Dialogue creates curiosity
    case "social": curiosityScore += 0.1; break;    // Social creates curiosity
    case "ignore": curiosityScore += 0.2; break;    // Ignoring increases curiosity
    case "deceive": curiosityScore += 0.1; break;   // Deception requires curiosity
    case "protect": curiosityScore += 0.05; break;  // Protecting creates some curiosity
    case "heal": curiosityScore += 0.1; break;      // Healing creates curiosity
    case "attack": curiosityScore += 0.05; break;   // Attack creates minimal curiosity
    case "escape": curiosityScore -= 0.2; break;    // Escape reduces curiosity
    case "custom": curiosityScore += 0.1; break;    // Custom actions create curiosity
    case "other": curiosityScore += 0.05; break;    // Other actions create minimal curiosity
  }

  // Context modifiers
  if (state.flags.trust === 'high') curiosityScore += 0.1;
  if (state.flags.fear === 'high') curiosityScore += 0.2; // Fear drives curiosity
  if (state.threads.length > 2) curiosityScore += 0.1; // Active threads boost curiosity
  if (isLatePhase) curiosityScore -= 0.15; // Curiosity diminishes in late phase
  if (isEarlyPhase) curiosityScore += 0.2; // Curiosity high in early phase

  // Apply hysteresis and update
  state.flags.curiosity = updateFlagWithHysteresis(state.flags.curiosity, curiosityScore, 0.1);
}

/**
 * Converts flag level to numeric score for calculations
 * 
 * @param flag - Flag level (low/medium/high)
 * @returns Numeric score (0.0-1.0)
 */
function getFlagScore(flag: FlagLevel): number {
  switch (flag) {
    case 'low': return 0.0;
    case 'medium': return 0.5;
    case 'high': return 1.0;
  }
}

/**
 * Updates flag level with hysteresis to prevent oscillation
 * 
 * Uses different thresholds for increasing vs decreasing to create
 * stability and prevent rapid flag changes between pages.
 * 
 * @param currentLevel - Current flag level
 * @param newScore - Calculated new score (0.0-1.0)
 * @param hysteresis - Hysteresis factor (0.0-0.3, higher = more stability)
 * @returns Updated flag level
 */
function updateFlagWithHysteresis(
  currentLevel: FlagLevel,
  newScore: number,
  hysteresis: number
): FlagLevel {
  // Apply hysteresis thresholds
  const thresholds = {
    // Increasing thresholds (higher score needed to level up)
    toMedium: 0.5 + hysteresis,
    toHigh: 0.85 + hysteresis,
    // Decreasing thresholds (lower score needed to level down)
    toLow: 0.25 - hysteresis,
    toMediumDown: 0.6 - hysteresis,
  };

  switch (currentLevel) {
    case 'low':
      if (newScore >= thresholds.toHigh) return 'high';
      if (newScore >= thresholds.toMedium) return 'medium';
      return 'low';
    
    case 'medium':
      if (newScore >= thresholds.toHigh) return 'high';
      if (newScore <= thresholds.toLow) return 'low';
      return 'medium';
    
    case 'high':
      if (newScore <= thresholds.toLow) return 'low';
      if (newScore <= thresholds.toMediumDown) return 'medium';
      return 'high';
  }
}

/**
 * Generic helper to process array updates from AI-generated content
 * 
 * Handles both removing then adding items from an array based on the TagUpdates structure.
 * 
 * @param targetArray - The array to update (passed by reference)
 * @param updates - TagUpdates object with add and remove arrays
 * @param maxItems - Optional maximum number of items to keep (keeps last N items)
 * 
 * @example
 * ```typescript
 * processTagUpdates(state.traumaTags, updates, MAX_TRAUMA_TAGS);
 * processTagUpdates(state.inventory, updates);
 * ```
 */
function processTagUpdates<T extends TagItem>(
  targetArray: T[],
  updates?: TagUpdates<T>,
  maxItems?: number,
): void {
  if (!updates) return;

  const isSameItem = (a: TagItem, b: TagItem): boolean => {
    if (typeof a === 'string' && typeof b === 'string') return a === b;
    if (typeof a === 'object' && typeof b === 'object') return a.key === b.key;
    return false;
  };

  // 1. Remove specified items
  if (updates.remove && updates.remove.length > 0) {
    targetArray.splice(
      0,
      targetArray.length,
      ...targetArray.filter(item => !updates.remove!.some(r => isSameItem(item, r))),
    );
  }

  // 2. Add new items (avoid duplicates)
  if (updates.add && updates.add.length > 0) {
    for (const item of updates.add) {
      if (!targetArray.some(existing => isSameItem(existing, item))) {
        targetArray.push(item);
      }
    }

    // Keep only the last maxItems if specified
    if (maxItems && targetArray.length > maxItems) {
      targetArray.splice(0, targetArray.length, ...targetArray.slice(-maxItems));
    }
  }
}

/**
 * Processes trauma tag updates from AI-generated content
 * 
 * Handles both adding and removing trauma tags based on the TagUpdates structure.
 * Maintains the MAX_TRAUMA_TAGS limit when adding new tags.
 * 
 * @param state - Current story state to update
 * @param updates - TagUpdates object with add and remove arrays
 * 
 * @example
 * ```typescript
 * processTraumaTagUpdates(state, {
 *   add: ["heard a voice", "saw something move"],
 *   remove: ["old trauma"]
 * });
 * ```
 */
export function processTraumaTagUpdates(state: StoryState, updates?: TagUpdates<string>): void {
  processTagUpdates(state.traumaTags, updates, MAX_TRAUMA_TAGS);
}

export function processFutureNoteUpdates(state: StoryState, updates?: TagUpdates<FutureNote>): void {
  processTagUpdates(state.futureNotes, updates, MAX_FUTURE_NOTES);
}

/**
 * Processes plot flag updates from AI-generated content
 * 
 * Adds a single plot flag to track important story developments and discoveries.
 * Plot flags are appended to maintain chronological order of plot progression.
 * Validates that the plot flag type is one of the allowed types.
 * 
 * @param state - Current story state to update
 * @param addPlotFlags - Optional PlotFlag objects with page, fact, and type
 * 
 * @example
 * ```typescript
 * processPlotFlagUpdates(state, {
 *   page: 15,
 *   fact: "Discovered the hidden basement key",
 *   type: "clue_found"
 * });
 * ```
 */
export function processPlotFlagUpdates(state: StoryState, addPlotFlags?: InitialPlotFlag[], scene?: StoryScene): void {
  if (!addPlotFlags?.length) return;

  const { place, timeOfDay } = scene ?? {};

  for (const addPlotFlag of addPlotFlags) {
    // Validate / normalise type
    const validType = plotFlagTypes.includes(addPlotFlag.type as any) ? addPlotFlag.type : "other";
    const normalized: PlotFlag = { ...addPlotFlag, page: state.page, place, timeOfDay, type: validType };
  
    // Guard against duplicates (same page + type + fact).
    // This mirrors the deduplication in processTagUpdates and provides a safety
    // net against double-application from retries or repeated reconstruction.
    const isDuplicate = state.plotFlags.some(f => f.page === normalized.page && f.type === normalized.type && f.fact === normalized.fact);
    if (isDuplicate) return;
  
    state.plotFlags.push(normalized);
    if (normalized.isMajorEvent) state.isMajorEvent = true;
  }
}

/**
 * Applies fact updates to the story state's fact history.
 *
 * Each fact key maintains a chronological history of changes.
 * If a key already exists, the new fact is appended to its history.
 * Otherwise a new history array is created for that key.
 *
 * Consecutive duplicate values are ignored to avoid bloating
 * the history with unchanged state updates.
 *
 * @example
 * inventory.silver_key.owner: [
 *   { page: 5, value: "Sarah" },
 *   { page: 33, value: "John" }
 * ]
 * relationship.sarah.john: [
 *   { page: 8, value: "friends" },
 *   { page: 22, value: "distrust" }
 * ]
 *
 * @param state - Mutable story state.
 * @param factUpdates - Fact changes extracted from the newly generated page.
 */
export function processFactUpdates(
  state: StoryState,
  factUpdates?: FactUpdate[]
): void {
  if (!factUpdates?.length) return;

  for (const { key, ...factHistory } of factUpdates) {
    const history = state.factsHistory[key];
    if (!history) { state.factsHistory[key] = [factHistory]; continue; }

    const latestFact = history.at(-1);
    if (!latestFact) { history.push(factHistory); continue; }

    // Same page -> replace
    if (latestFact.page === factHistory.page) { history[history.length - 1] = factHistory; continue; }

    // Skip unchanged state
    if (latestFact.value === factHistory.value) continue;

    history.push(factHistory);
  }
}

/**
 * Processes thread updates from AI-generated content
 * 
 * Handles creation of new threads, updates to existing threads, clue additions,
 * and thread closures based on AI-generated thread updates.
 * 
 * @param state - Current story state to update
 * @param threadUpdates - Thread updates from AI generation
 */
export function processThreadUpdates(state: StoryState, threadUpdates?: ThreadUpdates): void {
  if (!threadUpdates) return;

  // Create new threads
  if (threadUpdates.newThreads?.length) {
    for (const newThread of threadUpdates.newThreads) {
      const thread: StoryThread = {
        title: newThread.title,
        question: newThread.question,
        priority: newThread.priority,
        status: 'open',
        truth: newThread.truth,
        introducedAt: state.page,
        lastUpdatedAt: state.page,
        importance: newThread.importance ?? 0.5,
        urgency: 0.3, // Start with low urgency
        clues: [],
        falseClues: [],
      };
      state.threads.push(thread);
    }
  }

  // Update existing threads
  if (threadUpdates.updateThreads?.length) {
    for (const update of threadUpdates.updateThreads) {
      const existingThread = state.threads.find(t => t.title === update.title);
      if (existingThread) {
        if (update.status) existingThread.status = update.status;
        if (update.priority) existingThread.priority = update.priority;
        if (update.truth) existingThread.truth = update.truth;
        if (update.importance !== undefined) existingThread.importance = update.importance;
        if (update.urgency !== undefined) existingThread.urgency = update.urgency;
        if (update.resolution) existingThread.resolution = update.resolution;
        existingThread.lastUpdatedAt = state.page;
      }
    }
  }

  // Add clues to existing threads
  if (threadUpdates.addClues?.length) {
    for (const clueUpdate of threadUpdates.addClues) {
      const existingThread = state.threads.find(t => t.title === clueUpdate.thread);
      if (existingThread) {
        if (clueUpdate.isFalse) {
          existingThread.falseClues.push(clueUpdate.clue);
        } else {
          existingThread.clues.push(clueUpdate.clue);
        }
        existingThread.lastUpdatedAt = state.page;
        // Increase urgency when clues are added
        existingThread.urgency = Math.min(1.0, existingThread.urgency + 0.1);
      }
    }
  }

  // Close/resolve threads
  if (threadUpdates.closeThreads?.length) {
    for (const thread of threadUpdates.closeThreads) {
      const existingThread = state.threads.find(t => t.title === thread);
      if (existingThread) {
        existingThread.status = 'closed';
        existingThread.lastUpdatedAt = state.page;
      }
    }
  }
}

/**
 * Updates hidden story state based on progression and difficulty
 * 
 * Escalates threat proximity, reality stability, memory integrity,
 * and difficulty based on page progression and current state.
 * Uses multi-factor analysis to determine all state properties dynamically.
 * 
 * PSYCHOLOGICAL PROGRESSION:
 * As pages increase: MC becomes less reliable, perception more distorted, reality less stable
 * 
 * @param state - Current story state to update
 */
function updateHiddenState(state: StoryState): void {
  const pageProgress = state.page / state.maxPage;
  const traumaCount = state.traumaTags.length;
  const majorEventCount = state.actionsHistory.filter(a => a.type === 'attack' || a.type === 'ignore').length;

  // ========================
  // TRUTH LEVEL CALCULATION
  // ========================
  let truthScore = 1.0; // Start at 100% truth
  
  // Reduce truth based on progress (up to 60% reduction)
  truthScore -= pageProgress * 0.6;
  
  // Reduce truth based on trauma (up to 30% reduction)
  truthScore -= Math.min(traumaCount * 0.1, 0.3);
  
  // Reduce truth based on major events (up to 20% reduction)
  truthScore -= Math.min(majorEventCount * 0.05, 0.2);

  // Ensure score doesn't go below 0
  truthScore = Math.max(0, truthScore);

  // Convert score to truth level
  if (truthScore >= 0.7) {
    state.hiddenState.truthLevel = "mostly_true";
  } else if (truthScore >= 0.4) {
    state.hiddenState.truthLevel = "partially_true";
  } else {
    state.hiddenState.truthLevel = "mostly_false";
  }

  // ========================
  // THREAT PROXIMITY CALCULATION
  // ========================
  let threatScore = pageProgress * 0.4; // 40% from progress
  threatScore += (state.difficulty === 'nightmare' ? 0.3 : 0.2); // 20-30% from difficulty
  threatScore += Math.min(traumaCount * 0.05, 0.2); // Up to 20% from trauma
  threatScore += Math.min(majorEventCount * 0.1, 0.3); // Up to 30% from major events
  threatScore = Math.min(threatScore, 1.0); // Cap at 1.0

  // Convert score to threat proximity
  if (threatScore >= 0.7) {
    state.hiddenState.threatProximity = "immediate";
  } else if (threatScore >= 0.4) {
    state.hiddenState.threatProximity = "near";
  } else {
    state.hiddenState.threatProximity = "distant";
  }

  // ========================
  // REALITY STABILITY CALCULATION
  // ========================
  let stabilityScore = 1.0;
  
  // Reduce stability based on truth level
  if (state.hiddenState.truthLevel === 'mostly_false') stabilityScore -= 0.4;
  else if (state.hiddenState.truthLevel === 'partially_true') stabilityScore -= 0.2;
  
  // Reduce stability based on memory integrity
  if (state.memoryIntegrity === 'corrupted') stabilityScore -= 0.3;
  else if (state.memoryIntegrity === 'fragmented') stabilityScore -= 0.15;
  
  // Reduce stability based on major events
  stabilityScore -= Math.min(majorEventCount * 0.08, 0.25);
  
  // Reduce stability based on progress
  stabilityScore -= pageProgress * 0.2;
  
  stabilityScore = Math.max(0, stabilityScore);

  // Convert score to reality stability
  if (stabilityScore <= 0.3) {
    state.hiddenState.realityStability = "broken";
  } else if (stabilityScore <= 0.6) {
    state.hiddenState.realityStability = "slipping";
  } else {
    state.hiddenState.realityStability = "stable";
  }

  // ========================
  // MEMORY INTEGRITY CALCULATION
  // ========================
  let memoryScore = 1.0;
  
  // Reduce memory based on truth level
  if (state.hiddenState.truthLevel === 'mostly_false') memoryScore -= 0.3;
  else if (state.hiddenState.truthLevel === 'partially_true') memoryScore -= 0.15;
  
  // Reduce memory based on trauma
  memoryScore -= Math.min(traumaCount * 0.08, 0.4);
  
  // Reduce memory based on progress
  memoryScore -= pageProgress * 0.3;
  
  // Reduce memory based on major events
  memoryScore -= Math.min(majorEventCount * 0.06, 0.2);
  
  memoryScore = Math.max(0, memoryScore);

  // Convert score to memory integrity
  if (memoryScore <= 0.3) {
    state.memoryIntegrity = "corrupted";
  } else if (memoryScore <= 0.6) {
    state.memoryIntegrity = "fragmented";
  } else {
    state.memoryIntegrity = "stable";
  }

  // ========================
  // DIFFICULTY CALCULATION
  // ========================
  let difficultyScore = pageProgress * 0.3; // 30% from progress
  difficultyScore += (1.0 - truthScore) * 0.4; // 40% from truth degradation
  difficultyScore += traumaCount * 0.05; // 5% per trauma
  difficultyScore += majorEventCount * 0.03; // 3% per major event
  difficultyScore = Math.min(difficultyScore, 1.0); // Cap at 1.0

  // Convert score to difficulty
  if (difficultyScore >= 0.8) {
    state.difficulty = "nightmare";
  } else if (difficultyScore >= 0.5) {
    state.difficulty = "high";
  } else if (difficultyScore >= 0.3) {
    state.difficulty = "medium";
  } else {
    state.difficulty = "low";
  }
}

/**
 * Derives psychological profile from current story state using deterministic rules
 * 
 * This function analyzes the MC's behavior patterns, flags, and actions to
 * create a structured psychological profile for adaptive narrative manipulation.
 * 
 * @param state - Current story state with flags and actions
 * @returns Derived psychological profile for the MC
 * 
 * @example
 * ```typescript
 * const profile = derivePsychologicalProfile(state);
 * // Returns: { archetype: "the_paranoid", stability: "cracking", ... }
 * ```
 */
export function derivePsychologicalProfile(state: StoryState): PsychologicalProfile {
  const { flags, actionsHistory, traumaTags, difficulty } = state;
  
  // Determine archetype based on dominant behavioral patterns
  let archetype: Archetype = "the_explorer";
  let dominantTraits: string[] = [];
  let manipulationAffinity: ManipulationAffinity = "fear";
  
  // Explorer: High curiosity, low fear
  if (flags.curiosity === "high" && flags.fear !== "high") {
    archetype = "the_explorer";
    dominantTraits = ["curious", "investigative"];
    manipulationAffinity = "confusion";
  }
  
  // Paranoid: High fear + low trust
  else if (flags.fear === "high" && flags.trust === "low") {
    archetype = "the_paranoid";
    dominantTraits = ["fearful", "suspicious", "cautious"];
    manipulationAffinity = "fear";
  }
  
  // Risk Taker: High curiosity + high fear (brave but scared)
  else if (flags.curiosity === "high" && flags.fear === "high") {
    archetype = "the_risk_taker";
    dominantTraits = ["bold", "impulsive", "conflicted"];
    manipulationAffinity = "control_loss";
  }
  
  // Guilty: High guilt + trauma related to past actions
  else if (flags.guilt === "high" && traumaTags.some(tag => 
    tag.includes("abandoned") || tag.includes("hurt") || tag.includes("failed"))) {
    archetype = "the_guilty";
    dominantTraits = ["remorseful", "self-blaming", "haunted"];
    manipulationAffinity = "guilt";
  }
  
  // Avoider: High fear + low curiosity
  else if (flags.fear === "high" && flags.curiosity === "low") {
    archetype = "the_avoider";
    dominantTraits = ["cautious", "hesitant", "safety-seeking"];
    manipulationAffinity = "control_loss";
  }
  
  // Denier: Inconsistent patterns + memory issues
  else if (state.memoryIntegrity !== "stable" && flags.trust === "medium") {
    archetype = "the_denier";
    dominantTraits = ["rationalizing", "avoidant", "conflicted"];
    manipulationAffinity = "confusion";
  }
  
  // Determine stability based on multiple factors
  let stability: StabilityLevel = "stable";
  
  const instabilityFactors = [
    flags.fear === "high",
    flags.guilt === "high", 
    state.memoryIntegrity === "corrupted",
    state.hiddenState.realityStability === "broken",
    traumaTags.length >= MAX_TRAUMA_TAGS - 1,
    difficulty === "nightmare"
  ].filter(Boolean).length;
  
  if (instabilityFactors >= 4) {
    stability = "unstable";
  } else if (instabilityFactors >= 2) {
    stability = "cracking";
  }
  
  // Add secondary traits based on recent actions
  if (actionsHistory.length > 0) {
    const recentActions = actionsHistory.slice(-MAX_ACTION_HISTORY); // Increased window for better analysis
    
    // Fear-based behaviors
    if (recentActions.some(d => d.type === 'escape')) {
      dominantTraits.push("fearful");
    }
    
    // Social behaviors
    if (recentActions.some(d => d.type === 'social')) {
      dominantTraits.push("social");
    }
    
    // Curiosity and investigation
    if (recentActions.some(d => d.type === 'explore')) {
      dominantTraits.push("curious");
    }
    
    // Aggressive behaviors
    if (recentActions.some(d => d.type === 'attack')) {
      dominantTraits.push("aggressive");
    }
    
    // Leadership behaviors
    if (recentActions.some(d => d.type === 'protect')) {
      dominantTraits.push("leader");
    }
    
    // Deceptive behaviors
    if (recentActions.some(d => d.type === 'deceive')) {
      dominantTraits.push("deceptive");
    }
    
    // Risk-taking behaviors
    if (recentActions.some(d => d.type === 'risk')) {
      dominantTraits.push("risk_taker");
    }
    
    // Passive behaviors
    if (recentActions.some(d => d.type === 'ignore')) {
      dominantTraits.push("passive");
    }
    
    // Creative behaviors
    if (recentActions.some(d => d.type === 'create')) {
      dominantTraits.push("creative");
    }
    
    // Hopeful behaviors
    if (recentActions.some(d => d.type === 'heal')) {
      dominantTraits.push("hopeful");
    }
  }
  
  // Add difficulty-based traits
  if (difficulty === "nightmare") {
    dominantTraits.push("overwhelmed");
  } else if (difficulty === "high") {
    dominantTraits.push("stressed");
  }
  
  // Limit traits to most relevant ones
  dominantTraits = dominantTraits.slice(0, MAX_DOMINANT_TRAITS);
  
  return {
    archetype,
    stability,
    dominantTraits,
    manipulationAffinity,
  };
}

/**
 * Updates psychological profile based on current state progression
 * 
 * This function should be called after major state changes to ensure
 * the profile reflects the MC's current psychological state.
 * 
 * @param state - Current story state to update
 */
export function updatePsychologicalProfile(state: StoryState) {
  state.psychologicalProfile = derivePsychologicalProfile(state);
}

/**
 * Determines optimal ending archetype based on current story state
 * 
 * This function analyzes the complete story state including psychological profile,
 * flags, hidden state, and profile shifts to recommend the most
 * appropriate ending archetype for maximum narrative impact.
 * 
 * @param state - Current story state with psychological profile and flags
 * @returns The most suitable ending archetype for this state
 * 
 * @example
 * ```typescript
 * const ending = determineOptimalEnding(state);
 * // Returns: "false_reality" for high-curiosity explorers
 * ```
 */
export function determineOptimalEnding(state: StoryState): EndingType {
  const { flags, psychologicalProfile, hiddenState } = state;
  const { archetype, stability } = psychologicalProfile;

  // Check for profile shift first (highest priority)
  if (hiddenState.profileShift?.detected) {
    const shiftedEnding = getShiftedEnding(state);
    if (shiftedEnding) {
      console.log(`[determineOptimalEnding] 🔄 Profile shift detected, using shifted ending: ${shiftedEnding}`);
      return shiftedEnding;
    }
  }
  
  // Use original ending determination logic
  // TODO: all available `endingTypes`
  switch (archetype) {
    // High curiosity leads to discovering uncomfortable truths
    case "the_explorer": return flags.curiosity === "high" ? "false_reality" : "fake_escape";
    // Avoidance leads to permanent consequences
    case "the_avoider": return "irreversible_loss";
    // Low fear = bold risks that backfire, High fear = desperate losses
    case "the_risk_taker": return flags.fear === "low" ? "fake_escape" : "irreversible_loss";
    // Unstable paranoia creates loops, stable paranoia creates false realities
    case "the_paranoid": return stability === "unstable" ? "loop" : "false_reality";
    // Guilt always leads to irreversible loss
    case "the_guilty": return "irreversible_loss";
    // Deniers get identity twists as their reality unravels
    case "the_denier": return stability === "unstable" ? "mental_fabrication" : "identity_twist";
    default: return state.viableEnding?.type ?? "ambiguity";
  }
}

/**
 * Sets up fake ending to real ending twist for maximum psychological impact
 * 
 * This function arms a fake resolution that will be ripped away,
 * creating emotional whiplash and enhanced horror.
 * 
 * @param state - Current story state
 * @param triggerPage - Page to start the fake resolution sequence
 * @param executionType - Type of fake-to-real execution
 * 
 * @example
 * ```typescript
 * setupFakeToRealEnding(state, 8, "fake_relief_twist");
 * // Arms fake ending that triggers on page 8
 * ```
 */
export function setupFakeToRealEnding(state: StoryState, triggerPage: number, executionType: "fake_relief_twist" | "loop_trap" | "identity_reveal"): void {
  state.hiddenState.endingPlan ??= {
    type: executionType,
    armed: true,
    triggerPage,
    fakeToReal: true
  };
}

/**
 * Detects significant behavioral shifts for dynamic ending mutation
 * 
 * This function analyzes recent behavior changes to determine if the
 * player has dramatically shifted their approach, potentially changing
 * the deserved ending.
 * 
 * @param state - Current story state
 * @returns Whether a profile shift was detected
 * 
 * @example
 * ```typescript
 * const shiftDetected = detectProfileShift(state);
 * // Returns true if behavior changed dramatically
 * ```
 */
export function detectProfileShift(state: StoryState): boolean {
  if (state.actionsHistory.length < 6) return false; // Need enough data
  
  const profile = state.psychologicalProfile;
  const recentActions = state.actionsHistory.slice(-3);
  const earlierActions = state.actionsHistory.slice(-6, -3);
  
  // Detect curiosity collapse (was exploring, now avoiding)
  const wasCurious = earlierActions.some(a => a.type === "explore");
  const nowAvoiding = recentActions.some(a => a.type === "escape");
  
  if (wasCurious && nowAvoiding && !state.hiddenState.profileShift) {
    state.hiddenState.profileShift = {
      detected: true,
      shiftType: "curiosity_collapse",
      detectedAt: state.page,
      originalEnding: state.viableEnding?.type
    };
    return true;
  }
  
  // Detect fear spike (was calm/brave, now escaping/panicked)
  const wasBrave = earlierActions.some(a => a.type === "risk" || a.type === "attack");
  const nowPanickedFromBrave = recentActions.some(a => a.type === "escape");
  
  if (wasBrave && nowPanickedFromBrave && !state.hiddenState.profileShift) {
    state.hiddenState.profileShift = {
      detected: true,
      shiftType: "fear_spike",
      detectedAt: state.page,
      originalEnding: state.viableEnding?.type
    };
    return true;
  }
  
  // Detect aggression turn (was peaceful, now attacking)
  const wasPeaceful = earlierActions.every(a => a.type !== "attack" && a.type !== "deceive");
  const nowAggressive = recentActions.some(a => a.type === "attack");
  
  if (wasPeaceful && nowAggressive && !state.hiddenState.profileShift) {
    state.hiddenState.profileShift = {
      detected: true,
      shiftType: "aggression_turn",
      detectedAt: state.page,
      originalEnding: state.viableEnding?.type
    };
    return true;
  }
  
  // Detect deception onset (was honest, now deceiving)
  const wasHonest = earlierActions.every(a => a.type !== "deceive");
  const nowDeceptive = recentActions.some(a => a.type === "deceive");
  
  if (wasHonest && nowDeceptive && !state.hiddenState.profileShift) {
    state.hiddenState.profileShift = {
      detected: true,
      shiftType: "deception_onset",
      detectedAt: state.page,
      originalEnding: state.viableEnding?.type
    };
    return true;
  }
  
  // Detect social withdrawal (was social, now ignoring)
  const wasSocial = earlierActions.some(a => a.type === "social" || a.type === "protect");
  const nowWithdrawn = recentActions.every(a => a.type === "ignore" || a.type === "escape");
  
  if (wasSocial && nowWithdrawn && !state.hiddenState.profileShift) {
    state.hiddenState.profileShift = {
      detected: true,
      shiftType: "social_withdrawal",
      detectedAt: state.page,
      originalEnding: state.viableEnding?.type
    };
    return true;
  }
  
  // Detect protective to aggressive (was protecting, now attacking)
  const wasProtective = earlierActions.some(a => a.type === "protect");
  const nowAggressiveFromProtective = recentActions.some(a => a.type === "attack");
  
  if (wasProtective && nowAggressiveFromProtective && !state.hiddenState.profileShift) {
    state.hiddenState.profileShift = {
      detected: true,
      shiftType: "protective_to_aggressive",
      detectedAt: state.page,
      originalEnding: state.viableEnding?.type
    };
    return true;
  }
  
  // Detect creative to destructive (was creating, now attacking/destroying)
  const wasCreative = earlierActions.some(a => a.type === "create" || a.type === "heal");
  const nowDestructive = recentActions.some(a => a.type === "attack");
  
  if (wasCreative && nowDestructive && !state.hiddenState.profileShift) {
    state.hiddenState.profileShift = {
      detected: true,
      shiftType: "creative_to_destructive",
      detectedAt: state.page,
      originalEnding: state.viableEnding?.type
    };
    return true;
  }
  
  // PROFILE-BASED SHIFT DETECTION
  
  // Detect archetype shift (fundamental behavioral pattern change)
  if (profile.archetype === "the_explorer" && nowAvoiding && !state.hiddenState.profileShift) {
    state.hiddenState.profileShift = {
      detected: true,
      shiftType: "archetype_collapse",
      detectedAt: state.page,
      originalEnding: state.viableEnding?.type
    };
    return true;
  }
  
  // Detect stability breakdown (mental coherence collapse)
  if (profile.stability === "unstable" && !state.hiddenState.profileShift) {
    // Check for reality-breaking actions
    const hasRealityBreak = recentActions.some(a => 
      a.type === "deceive" || a.type === "ignore" || a.type === "escape");
    
    if (hasRealityBreak) {
      state.hiddenState.profileShift = {
        detected: true,
        shiftType: "reality_breakdown",
        detectedAt: state.page,
        originalEnding: state.viableEnding?.type
      };
      return true;
    }
  }
  
  // Detect manipulation resistance reversal (was resistant, now susceptible)
  const wasResistant = earlierActions.some(a => 
    a.type === "attack" || a.type === "risk" || a.type === "explore");
  const nowCompliant = recentActions.some(a => 
    a.type === "ignore" || a.type === "deceive");
  
  if (wasResistant && nowCompliant && profile.manipulationAffinity === "confusion" && !state.hiddenState.profileShift) {
    state.hiddenState.profileShift = {
      detected: true,
      shiftType: "manipulation_acceptance",
      detectedAt: state.page,
      originalEnding: state.viableEnding?.type
    };
    return true;
  }
  
  // Detect trait inversion (dominant traits completely reverse)
  if (profile.dominantTraits.length > 0) {
    const traitsIndicateCuriosity = profile.dominantTraits.some(trait => 
      trait.toLowerCase().includes("curious") || trait.toLowerCase().includes("investigative"));
    const traitsIndicateFear = profile.dominantTraits.some(trait => 
      trait.toLowerCase().includes("fearful") || trait.toLowerCase().includes("cautious"));
    
    if (traitsIndicateCuriosity && nowAvoiding && !state.hiddenState.profileShift) {
      state.hiddenState.profileShift = {
        detected: true,
        shiftType: "trait_inversion",
        detectedAt: state.page,
        originalEnding: state.viableEnding?.type
      };
      return true;
    }
    
    if (traitsIndicateFear && nowAggressive && !state.hiddenState.profileShift) {
      state.hiddenState.profileShift = {
        detected: true,
        shiftType: "fear_to_aggression",
        detectedAt: state.page,
        originalEnding: state.viableEnding?.type
      };
      return true;
    }
  }
  
  return false;
}

/**
 * Gets mutated ending based on profile shift
 * 
 * If a behavioral shift was detected, this function returns a
 * psychologically appropriate ending that reflects the change.
 * 
 * @param state - Current story state
 * @returns The mutated ending archetype
 * 
 * @example
 * ```typescript
 * const mutatedEnding = getShiftedEnding(state);
 * // Returns "possession" for aggression turn
 * ```
 */
export function getShiftedEnding(state: StoryState): EndingType | undefined {
  if (!state.hiddenState.profileShift?.detected) {
    return state.viableEnding?.type;
  }
  
  const { shiftType } = state.hiddenState.profileShift;
  
  switch (shiftType) {
    // "You stopped asking questions... but something kept answering anyway"
    case "curiosity_collapse": return "mental_fabrication";
    // "It didn't chase you because you were slow... it chased you because you finally understood"
    case "fear_spike": return "loop";
    // "You weren't trying to survive anymore. You were trying to win. That's when it recognized you"
    case "aggression_turn": return "identity_twist";
    // "The explorer became the trapped - the ultimate irony"
    case "archetype_collapse": return "possession";
    // "When reality shattered, you found the truth in the pieces"
    case "reality_breakdown": return "false_reality";
    // "You finally stopped fighting... and accepted the lie as truth"
    case "manipulation_acceptance": return "mental_fabrication";
    // "The curious became fearful - the perfect victim"
    case "trait_inversion": return "loop";
    // "Fear turned to rage, and rage opened the wrong door"
    case "fear_to_aggression": return "possession";
    // "You thought you were escaping... but you were just running in circles"
    case "denial_break": return "false_reality";
    // "You betrayed your own instincts... and now you can't trust anything"
    case "trust_betrayal": return "fake_escape";
      
    default: return state.viableEnding?.type;
  }
}

/**
 * Updates story state with advanced ending systems
 * 
 * This function should be called after each action to:
 * - Detect profile shifts
 * - Arm ending plans at appropriate times
 * - Handle fake-to-real ending execution
 * 
 * @param state - Current story state to update
 */
export function updateAdvancedEndingSystems(state: StoryState): void {
  const pageProgress = state.page / state.maxPage;
  
  // Detect profile shifts (late game behavior changes)
  if (pageProgress > 0.6) detectProfileShift(state);
  
  // Auto-arm fake-to-real endings for certain archetypes
  if (pageProgress >= 0.7 && !state.hiddenState.endingPlan?.armed) {
    const ending = state.viableEnding?.type;
    const triggerPage = Math.max(state.page + 1, state.maxPage - 2);
    
    if (ending === "fake_escape" || ending === "loop" || ending === "identity_twist") {
      setupFakeToRealEnding(state, triggerPage, "fake_relief_twist");
    }
  }
}

/**
 * Creates an empty story state with default values
 * 
 * @param pageId - Page ID for the state
 * @param pageNumber - Page number
 * @param totalPages - Total number of pages
 * @returns Empty story state
 */
export function createEmptyStoryState(pageId: string, pageNumber: number, totalPages: number): StoryState {
  return {
    ...STORY_STATE_DEFAULTS,
    pageId,
    page: pageNumber,
    maxPage: totalPages,
  };
}

/**
 * Creates initial hidden state for new stories
 * 
 * @returns Baseline hidden state for story start
 */
export function createInitialHiddenState(): HiddenState {
  return {
    ...HIDDEN_STATE_DEFAULTS,
    endingPlan: {
      type: 'fake_relief_twist' satisfies EndingPlanType,
      armed: false,
      triggerPage: 15,
      fakeToReal: false
    } satisfies EndingPlan,
    profileShift: {
      detected: false,
      shiftType: 'curiosity_collapse' satisfies ProfileShiftType,
      detectedAt: 0,
      originalEnding: 'fake_escape' satisfies EndingType
    } satisfies ProfileShift
  } satisfies HiddenState;
}

/**
 * Calculates comprehensive story state information from the current story state
 * 
 * This function analyzes the current story progression and determines various metrics
 * including page counts, progress percentages, and story phase classification. It uses
 * predefined thresholds to categorize the story into phases (EARLY, MID, LATE, FINALE)
 * and provides corresponding phase goals for narrative guidance.
 * 
 * Phase classification thresholds:
 * - EARLY phase: 0% - 25% of story progress
 * - MID phase: 25% - 70% of story progress  
 * - LATE phase: 70% - 90% of story progress
 * - FINALE phase: 90% - 100% of story progress
 * 
 * @param state - The current story state containing page and maxPage information
 * @returns Comprehensive story state information including progress metrics and phase classification
 * 
 * @example
 * ```typescript
 * // Example usage with a story halfway through
 * const storyState: StoryState = {
 *   page: 10,
 *   maxPage: 20,
 *   // ... other state properties
 * };
 * 
 * const info = getStoryStateInfo(storyState);
 * console.log(info.phase); // 'MID'
 * console.log(info.pageProgress); // 0.5
 * console.log(info.remainingPages); // 10
 * ```
 */
export function getStoryStateInfo(state: StoryState): StoryStateInfo {
  const { page: currentPage, maxPage: totalPages, characters, places } = state;
  const remainingPages = totalPages - currentPage;
  const pageProgress = currentPage / totalPages;

  /**
   * Phase boundaries:
   * Early — first ~25% of pages: mystery seeding, character establishment, unreliability introduction
   * Mid — 25–70%: tension rhythm, thread weaving, psychological profiling exploitation
   * Late — 70–90%: thread convergence, payoff setup, reality fracture escalation
   * Finale — final ~10%: collapse, no new threads, ending delivery
   */
  const isEarlyPhase = pageProgress <= 0.25;
  const isLatePhase = pageProgress >= 0.70;
  const isMidPhase = !isEarlyPhase && !isLatePhase;
  const isFinale = pageProgress >= 0.90;
  const isFirstPage = currentPage === 1;
  const isLastPage = currentPage === totalPages;
  const phase: StoryPhase = isFinale ? 'FINALE' : isLatePhase ? 'LATE' : isMidPhase ? 'MID' : 'EARLY';
  const phaseGoal = storyPhases[phase];

  // Determine finale phase only when story is in finale
  const finalePhase: FinalePhase | undefined = isFinale ? (
    pageProgress >= 0.97 ? 'END' : pageProgress >= 0.94 ? 'MID' : 'EARLY'
  ) : undefined;

  const charactersSlot = MAX_CHARACTERS - Object.keys(characters).length;
  const placesSlot = MAX_PLACES - Object.keys(places).length;

  return {
    currentPage,
    totalPages,
    remainingPages,
    pageProgress,
    isEarlyPhase,
    isLatePhase,
    isMidPhase,
    isFinale,
    isFirstPage,
    isLastPage,
    phase,
    phaseGoal,
    finalePhase,
    charactersSlot,
    placesSlot,
  } satisfies StoryStateInfo;
}