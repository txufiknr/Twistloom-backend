import { MAX_CHARACTERS, MAX_DOMINANT_TRAITS, MAX_PLACES, MAX_TRAUMA_TAGS } from "../config/story.js";
import { HIDDEN_STATE_DEFAULTS, STORY_STATE_DEFAULTS } from "../schema/story.js";
import { storyPhases } from "../types/story.js";
import type { StoryState, PsychologicalProfile, Archetype, StabilityLevel, ManipulationAffinity, Action, ActionedStoryPage, EndingType, HiddenState, EndingPlanType, EndingPlan, ProfileShiftType, ProfileShift, StoryStateInfo, StoryPhase, FinalePhase, StateDelta, StoryGeneration } from "../types/story.js";
import type { ThreadUpdates, StoryThread } from "../types/thread.js";
import { processCharacterUpdates } from "./characters.js";
import { processPlaceUpdates } from "./places.js";
import { generateId } from "./uuid.js";
import { deepEqualSimple } from "../utils/parser.js";

/**
 * Extracts state delta fields from a StoryGeneration object
 * 
 * This function separates the page content from state change information,
 * returning only the delta fields that affect story state progression.
 * 
 * @param generation - StoryGeneration object containing both page content and state deltas
 * @returns Clean StateDelta object with only state change fields
 * 
 * @example
 * ```typescript
 * const delta = extractStateDelta(generatedPage);
 * // Returns: { flagUpdates, traumaTagUpdates, plotFlagUpdates, ... }
 * ```
 */
export function extractStateDelta(generation: StoryGeneration): StateDelta {
  return {
    flagUpdates: generation.flagUpdates,
    traumaTagUpdates: generation.traumaTagUpdates,
    plotFlagUpdates: generation.plotFlagUpdates,
    inventoryUpdates: generation.inventoryUpdates,
    characterUpdates: generation.characterUpdates,
    relationshipUpdates: generation.relationshipUpdates,
    placeUpdates: generation.placeUpdates,
    threadUpdates: generation.threadUpdates,
    viableEnding: generation.viableEnding,
    isMajorEvent: generation.isMajorEvent,
    contextHistory: generation.contextHistory,
  };
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
export function calculatePsychologicalDeltas(baseState: StoryState, newState: StoryState): Pick<StateDelta, 'psychologicalProfileUpdates' | 'hiddenStateUpdates' | 'memoryIntegrity' | 'difficulty'> {
  const deltas: Pick<StateDelta, 'psychologicalProfileUpdates' | 'hiddenStateUpdates' | 'memoryIntegrity' | 'difficulty'> = {};

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
    
    if (Object.keys(profileUpdates).length > 0) {
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
    
    if (Object.keys(hiddenUpdates).length > 0) {
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

  return deltas;
}

/**
 * Applies state delta to base story state
 * 
 * This function applies incremental changes from a StateDelta to a base StoryState,
 * producing a new state with all updates applied. This is useful for reconstructing
 * story states from stored deltas without requiring full snapshots.
 * 
 * @param baseState - Base story state to apply delta to
 * @param stateDelta - State delta containing incremental changes
 * @returns New story state with delta applied
 * 
 * @example
 * ```typescript
 * const newState = applyStateDelta(currentState, {
 *   flagUpdates: { trust: "low" },
 *   traumaTagUpdates: { add: ["heard a voice"], remove: [] },
 *   plotFlagUpdates: { add: ["found key"], remove: [] }
 * });
 * ```
 */
export function applyStateDelta(baseState: StoryState, stateDelta: StateDelta): StoryState {
  const {
    flagUpdates,
    traumaTagUpdates,
    plotFlagUpdates,
    inventoryUpdates,
    characterUpdates,
    relationshipUpdates,
    placeUpdates,
    threadUpdates,
    viableEnding,
    isMajorEvent,
    contextHistory,
    psychologicalProfileUpdates,
    hiddenStateUpdates,
    memoryIntegrity,
    difficulty,
  } = stateDelta;

  // Create new state with base state values
  const newState: StoryState = {
    ...baseState,
    // Apply optional delta fields
    flags: flagUpdates ? { ...baseState.flags, ...flagUpdates } : baseState.flags,
    isMajorEvent: isMajorEvent ?? baseState.isMajorEvent,
    contextHistory: contextHistory ?? baseState.contextHistory,
    viableEnding: viableEnding ? { ...baseState.viableEnding, ...viableEnding } : baseState.viableEnding,
    // Apply new delta fields
    psychologicalProfile: psychologicalProfileUpdates 
      ? { ...baseState.psychologicalProfile, ...psychologicalProfileUpdates } 
      : baseState.psychologicalProfile,
    hiddenState: hiddenStateUpdates 
      ? { ...baseState.hiddenState, ...hiddenStateUpdates } 
      : baseState.hiddenState,
    memoryIntegrity: memoryIntegrity ?? baseState.memoryIntegrity,
    difficulty: difficulty ?? baseState.difficulty,
  };

  // Apply trauma tag updates
  if (traumaTagUpdates) {
    processTraumaTagUpdates(newState, traumaTagUpdates);
  }

  // Apply plot flag updates
  if (plotFlagUpdates) {
    processPlotFlagUpdates(newState, plotFlagUpdates);
  }

  // Apply inventory updates
  if (inventoryUpdates) {
    processInventoryUpdates(newState, inventoryUpdates);
  }

  // Apply character and relationship updates
  if (characterUpdates || relationshipUpdates) {
    processCharacterUpdates(newState, characterUpdates, relationshipUpdates);
  }

  // Apply place updates
  if (placeUpdates) {
    processPlaceUpdates(newState, placeUpdates);
  }

  // Apply thread updates
  if (threadUpdates) {
    processThreadUpdates(newState, threadUpdates);
  }

  return newState;
}

/**
 * Advances story state based on user action and previous AI turn updates
 *
 * This function processes the user's selected action from a story page and applies any
 * updates (characters, places, threads) generated by the AI in the previous turn.
 * It updates psychological flags, manages trauma tags, escalates story tension,
 * maintains page history, action history, and generates context summaries.
 *
 * @param state - Current story state to be updated
 * @param actionedPage - Previous page with selected action and previous AI turn's updates
 * @returns Promise resolving to updated story state with new flags, trauma, and escalation
 *
 * @example
 * ```typescript
 * const newState = await advanceStoryState(currentState, {
 *   text: "The door creaked open...",
 *   actions: [{ type: 'explore', text: 'Investigate the noise' }],
 *   selectedAction: { type: 'explore', hint: { text: 'Something lurks inside' } },
 *   characterUpdates: { ... }, // From previous AI turn
 *   placeUpdates: { ... }, // From previous AI turn
 *   threadUpdates: { ... } // From previous AI turn
 * });
 * ```
 */
export async function advanceStoryState(state: StoryState, actionedPage: ActionedStoryPage): Promise<StoryState> {
  const updatedState = updateStoryState(state, actionedPage.stateDelta);

  // Add chosen action to history and increment page number
  updatedState.actionsHistory.push(actionedPage.selectedAction);
  updatedState.page++;

  // Update psychological flags based on action type
  updateFlags(updatedState, actionedPage.selectedAction);

  // Escalate story tension and hidden state
  updateHiddenState(updatedState);

  // Update psychological profile based on new state
  updatePsychologicalProfile(updatedState);

  // Update advanced ending systems (profile shifts, fake endings)
  updateAdvancedEndingSystems(updatedState);

  return updatedState;
}

/**
 * Applies current AI turn's updates to story state
 *
 * This function processes updates (viable ending, trauma, characters, places, threads)
 * generated by the AI in the current turn and applies them to the story state.
 * This is called after AI generation succeeds.
 *
 * @param storyState - Current story state to update
 * @param generatedPage - AI-generated page content with current turn's updates
 * @returns Updated story state with current AI modifications applied
 */
export function updateStoryState(
  storyState: StoryState,
  stateDelta: StateDelta
): StoryState {
  const {
    flagUpdates,
    traumaTagUpdates,
    plotFlagUpdates,
    inventoryUpdates,
    characterUpdates,
    relationshipUpdates,
    placeUpdates,
    threadUpdates,
    viableEnding,
    isMajorEvent,
    contextHistory,
  } = stateDelta;

  // Create new state with viable ending updates
  const newState: StoryState = { 
    ...storyState,
    isMajorEvent: isMajorEvent ?? storyState.isMajorEvent,
    contextHistory: contextHistory ?? storyState.contextHistory,
    flags: {...storyState.flags, ...(flagUpdates ?? {})},
    viableEnding: {
      text: viableEnding?.text ?? storyState.viableEnding?.text,
      type: viableEnding?.type ?? storyState.viableEnding?.type,
    } 
  };

  // Add or remove new trauma tag if provided
  processTraumaTagUpdates(newState, traumaTagUpdates);

  // Add or remove plot flag if provided
  processPlotFlagUpdates(newState, plotFlagUpdates);

  // Add or remove inventory if provided
  processInventoryUpdates(newState, inventoryUpdates);

  // Process character updates from AI output
  processCharacterUpdates(newState, characterUpdates, relationshipUpdates);

  // Process place updates from AI output
  processPlaceUpdates(newState, placeUpdates);

  // Process thread updates from AI output
  processThreadUpdates(newState, threadUpdates);

  return newState;
}

/**
 * Updates psychological flags based on action type and current state
 * 
 * Uses ActionType enum instead of string matching for more reliable
 * flag updates. Considers current flag levels to prevent unnecessary changes.
 * 
 * @param state - Current story state
 * @param action - User action with type classification
 */
function updateFlags(state: StoryState, action?: Action): void {
  if (!action) return;
  
  switch (action.type) {
    case "explore":
      // Exploration increases curiosity and potentially fear
      if (state.flags.curiosity !== "high") {
        state.flags.curiosity = state.flags.curiosity === "low" ? "medium" : "high";
      }
      // Exploration in high fear increases fear further
      if (state.flags.fear === "high") {
        state.flags.trust = "low";
      }
      break;

    case "escape":
      // Escape actions increase fear and decrease trust
      state.flags.fear = "high";
      state.flags.trust = "low";
      // High fear may fragment memory
      if (state.memoryIntegrity === "stable") {
        state.memoryIntegrity = "fragmented";
      }
      break;

    case "social":
      // Social actions can affect trust based on current levels
      if (state.flags.trust === "low") {
        // Low trust + social = potential betrayal setup
        state.flags.guilt = "medium";
      } else {
        // High trust + social = temporary relief
        state.flags.fear = state.flags.fear === "high" ? "medium" : "low";
      }
      break;

    case "risk":
      // Risky actions increase all negative states
      state.flags.fear = "high";
      state.flags.guilt = state.flags.guilt === "low" ? "medium" : "high";
      state.flags.trust = "low";
      // Risk actions accelerate curiosity
      state.flags.curiosity = "high";
      break;

    case "ignore":
      // Ignoring can increase guilt and curiosity
      if (state.flags.guilt !== "high") {
        state.flags.guilt = state.flags.guilt === "low" ? "medium" : "high";
      }
      state.flags.curiosity = "high";
      break;
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
export function processTraumaTagUpdates(state: StoryState, updates?: { add: string[]; remove: string[] }): void {
  if (!updates) return;
  
  // Remove specified tags
  if (updates.remove.length > 0) {
    state.traumaTags = state.traumaTags.filter(tag => !updates.remove.includes(tag));
  }
  
  // Add new tags (avoid duplicates)
  if (updates.add.length > 0) {
    for (const tag of updates.add) {
      if (!state.traumaTags.includes(tag)) {
        state.traumaTags.push(tag);
      }
    }
    
    // Keep only the last MAX_TRAUMA_TAGS trauma tags for relevance
    if (state.traumaTags.length > MAX_TRAUMA_TAGS) {
      state.traumaTags = state.traumaTags.slice(-MAX_TRAUMA_TAGS);
    }
  }
}

/**
 * Processes plot flag updates from AI-generated content
 * 
 * Handles both adding and removing plot flags based on the TagUpdates structure.
 * Plot flags track important story developments and discoveries.
 * 
 * @param state - Current story state to update
 * @param updates - TagUpdates object with add and remove arrays
 * 
 * @example
 * ```typescript
 * processPlotFlagUpdates(state, {
 *   add: ["found mysterious key", "discovered secret passage"],
 *   remove: ["old irrelevant flag"]
 * });
 * ```
 */
export function processPlotFlagUpdates(state: StoryState, updates?: { add: string[]; remove: string[] }): void {
  if (!updates) return;
  
  // Remove specified flags
  if (updates.remove.length > 0) {
    state.plotFlags = state.plotFlags.filter(flag => !updates.remove.includes(flag));
  }
  
  // Add new flags (avoid duplicates)
  if (updates.add.length > 0) {
    for (const flag of updates.add) {
      if (!state.plotFlags.includes(flag)) {
        state.plotFlags.push(flag);
      }
    }
  }
}

/**
 * Processes inventory updates from AI-generated content
 * 
 * Handles both adding and removing inventory items based on the TagUpdates structure.
 * Inventory tracks items the character possesses for story interactions.
 * 
 * @param state - Current story state to update
 * @param updates - TagUpdates object with add and remove arrays
 * 
 * @example
 * ```typescript
 * processInventoryUpdates(state, {
 *   add: ["rusty key", "flashlight", "old photograph"],
 *   remove: ["broken item", "used up item"]
 * });
 * ```
 */
export function processInventoryUpdates(state: StoryState, updates?: { add: string[]; remove: string[] }): void {
  if (!updates) return;
  
  // Remove specified items
  if (updates.remove.length > 0) {
    state.inventory = state.inventory.filter(item => !updates.remove.includes(item));
  }
  
  // Add new items (avoid duplicates)
  if (updates.add.length > 0) {
    for (const item of updates.add) {
      if (!state.inventory.includes(item)) {
        state.inventory.push(item);
      }
    }
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
  if (threadUpdates.newThreads && threadUpdates.newThreads.length > 0) {
    for (const newThread of threadUpdates.newThreads) {
      const thread: StoryThread = {
        id: generateId(),
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
  if (threadUpdates.updateThreads && threadUpdates.updateThreads.length > 0) {
    for (const update of threadUpdates.updateThreads) {
      const existingThread = state.threads.find(t => t.id === update.id);
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
  if (threadUpdates.addClues && threadUpdates.addClues.length > 0) {
    for (const clueUpdate of threadUpdates.addClues) {
      const existingThread = state.threads.find(t => t.id === clueUpdate.threadId);
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
  if (threadUpdates.closeThreads && threadUpdates.closeThreads.length > 0) {
    for (const threadId of threadUpdates.closeThreads) {
      const existingThread = state.threads.find(t => t.id === threadId);
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
 * @param state - Current story state to update
 */
function updateHiddenState(state: StoryState): void {
  const pageProgress = state.page / state.maxPage;
  const traumaCount = state.traumaTags.length;
  const majorEventCount = state.actionsHistory.filter(a => 
    a.type === 'confront' || a.type === 'avoid'
  ).length;

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
    state.hiddenState.realityStability = "shaking";
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
    const recentActions = actionsHistory.slice(-5); // Increased window for better analysis
    
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
 * @returns Updated psychological profile
 */
export function updatePsychologicalProfile(state: StoryState): PsychologicalProfile {
  const newProfile = derivePsychologicalProfile(state);
  state.psychologicalProfile = newProfile;
  return newProfile;
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
  const { archetype, stability } = state.psychologicalProfile;
  const { flags } = state;

  // Check for profile shift first (highest priority)
  if (state.hiddenState.profileShift?.detected) {
    const shiftedEnding = getShiftedEnding(state);
    if (shiftedEnding) {
      console.log(`[determineOptimalEnding] 🔄 Profile shift detected, using shifted ending: ${shiftedEnding}`);
      return shiftedEnding;
    }
  }
  
  // Use original ending determination logic
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
  if (!state.hiddenState.endingPlan) {
    state.hiddenState.endingPlan = {
      type: executionType,
      armed: true,
      triggerPage,
      fakeToReal: true
    };
  }
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
    case "denial_break": return "false_reality";
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
  if (pageProgress > 0.6) {
    detectProfileShift(state);
  }
  
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
   * Phase boundaries (assuming BOOK_AVERAGE_PAGES as baseline):
   * Early — first ~25% of pages: mystery seeding, character establishment, unreliability introduction
   * Mid — 25–70%: tension rhythm, thread weaving, psychological profiling exploitation
   * Late — 70–90%: thread convergence, payoff setup, reality fracture escalation
   * Finale — final ~10%: collapse, no new threads, ending delivery
   */
  const isEarlyPhase = pageProgress <= 0.25;
  const isLatePhase = pageProgress >= 0.70;
  const isMidPhase = !isEarlyPhase && !isLatePhase;
  const isFinale = pageProgress >= 0.90;
  const phase: StoryPhase = isFinale ? 'FINALE' : isLatePhase ? 'LATE' : isMidPhase ? 'MID' : 'EARLY';
  const phaseGoal = storyPhases[phase];

  // Determine finale phase only when story is in finale
  const finalePhase: FinalePhase | undefined = isFinale 
    ? currentPage >= totalPages * 0.95 ? 'END' 
    : currentPage >= totalPages * 0.85 ? 'MID' 
    : 'EARLY'
    : undefined;

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
    phase,
    phaseGoal,
    finalePhase,
    charactersSlot,
    placesSlot,
  } satisfies StoryStateInfo;
}