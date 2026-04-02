import { MAX_DOMINANT_TRAITS, MAX_PAGE_HISTORY, MAX_PAST_INTERACTIONS, MAX_TRAUMA_TAGS } from "../config/story.js";
import type { CharacterMemory, CharacterStatus, CharacterUpdate, RelationshipUpdate } from "../types/character.js";
import type { StoryState, PsychologicalProfile, Archetype, StabilityLevel, ManipulationAffinity, Ending, StoryPage, Action } from "../types/story.js";
import { Gender } from "../types/user.js";
import { processCharacterUpdates } from "./characters.js";
import { processPlaceUpdates } from "./places.js";
import { summarizeStoryContext } from "./prompt.js";

/**
 * Updates story state based on user action and new trauma
 * 
 * This function processes the user's selected action from a story page, updates psychological
 * flags, manages trauma tags, and escalates story tension based on progression.
 * It maintains page history, action history, and generates context summaries.
 * 
 * @param state - Current story state to be updated
 * @param actionedPage - Previous page with selected action for context processing
 * @returns Promise resolving to updated story state with new flags, trauma, and escalation
 * 
 * @example
 * ```typescript
 * const newState = await updateState(currentState, {
 *   text: "The door creaked open...",
 *   actions: [{ type: 'explore', text: 'Investigate the noise' }],
 *   selectedAction: { type: 'explore', hint: { text: 'Something lurks inside' } }
 * });
 * ```
 */
export async function updateState(state: StoryState, actionedPage: StoryPage): Promise<StoryState> {
  const updatedState = {
    ...state,
    // Add current page to history, maintain sliding window (last 10 pages)
    pageHistory: [...state.pageHistory, actionedPage].slice(-MAX_PAGE_HISTORY),
    // Increment page number
    page: state.page + 1
  };

  // Add chosen action to history
  addChosenAction(updatedState, actionedPage.selectedAction);

  // Update psychological flags based on action type
  updateFlags(updatedState, actionedPage.selectedAction);

  // Process new trauma if provided
  maybeAddTrauma(updatedState, actionedPage.addTraumaTag);

  // Escalate story tension and hidden state
  updateHiddenState(updatedState);

  // Update psychological profile based on new state
  updatePsychologicalProfile(updatedState);

  // Update advanced ending systems (profile shifts, fake endings)
  updateAdvancedEndingSystems(updatedState);

  // Process character updates from AI output
  processCharacterUpdates(updatedState, actionedPage.characterUpdates);

  // Process place updates from AI output
  processPlaceUpdates(updatedState, actionedPage.placeUpdates);

  // Update context history with AI summarization
  updatedState.contextHistory = await summarizeStoryContext(
    state.contextHistory,
    actionedPage.text,
    state.page
  );

  return updatedState;
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
 * Adds the chosen action to the history of actions taken in the story
 *
 * @param state - The current state of the story
 * @param action - The action chosen by the user. If not provided, the function does nothing.
 */
function addChosenAction(state: StoryState, action?: Action): void {
  if (action) state.actionsHistory.push(action);
}

/**
 * Adds new trauma tag if provided and manages trauma collection
 * 
 * @param state - Current story state
 * @param actionedPage - Page that may contain a new trauma tag
 */
function maybeAddTrauma(state: StoryState, traumaTag?: string): void {
  if (traumaTag) pushTrauma(state, traumaTag);
}

/**
 * Adds trauma tag to the collection, maintaining the most recent MAX_TRAUMA_TAGS tags
 * 
 * Keeps the last MAX_TRAUMA_TAGS trauma tags to maintain relevance to current story events.
 * 
 * @param state - Current story state
 * @param tag - New trauma tag to add
 */
function pushTrauma(state: StoryState, tag: string): void {
  if (!state.traumaTags.includes(tag)) {
    state.traumaTags.push(tag);
  }

  // Keep only the last MAX_TRAUMA_TAGS trauma tags for relevance
  if (state.traumaTags.length > MAX_TRAUMA_TAGS) {
    state.traumaTags = state.traumaTags.slice(-MAX_TRAUMA_TAGS);
  }
}

/**
 * Updates hidden story state based on progression and difficulty
 * 
 * Escalates threat proximity, reality stability, memory integrity,
 * and difficulty based on page progression and current state.
 * 
 * @param state - Current story state to update
 */
function updateHiddenState(state: StoryState): void {
  const pageProgress = state.page / state.maxPage;

  // Escalation over time
  if (pageProgress > 0.6) {
    state.hiddenState.threatProximity = "near";
  }

  if (pageProgress > 0.8) {
    state.hiddenState.threatProximity = "immediate";
    state.hiddenState.realityStability = "broken";
  }

  // Memory corruption scaling
  if (pageProgress > 0.5) {
    state.memoryIntegrity = "fragmented";
  }

  if (pageProgress > 0.75) {
    state.memoryIntegrity = "corrupted";
  }

  // Difficulty escalation
  if (pageProgress > 0.7) {
    state.difficulty = "high";
  }

  // Nightmare difficulty escalation
  if (state.difficulty === "nightmare" && pageProgress > 0.4) {
    state.hiddenState.realityStability = "broken";
    state.memoryIntegrity = "corrupted";
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
 * Determines the optimal ending archetype based on psychological profile
 * 
 * This function analyzes the MC's psychological profile to select the most
 * appropriate ending archetype that will create the maximum narrative impact
 * based on their behavioral patterns and mental state. Uses flag-based
 * conditional logic for more nuanced ending selection.
 * 
 * @param state - Current story state with psychological profile and flags
 * @returns The most suitable ending archetype for this profile
 * 
 * @example
 * ```typescript
 * const ending = determineEndingArchetype(state);
 * // Returns: "false_reality" for high-curiosity explorers
 * ```
 */
export function determineEndingArchetype(state: StoryState): Ending {
  const { archetype, stability } = state.psychologicalProfile;
  const { flags } = state;

  switch (archetype) {
    case "the_explorer":
      // High curiosity leads to discovering uncomfortable truths
      return flags.curiosity === "high" ? "false_reality" : "fake_escape";

    case "the_avoider":
      // Avoidance leads to permanent consequences
      return "irreversible_loss";

    case "the_risk_taker":
      // Low fear = bold risks that backfire, High fear = desperate losses
      return flags.fear === "low" ? "fake_escape" : "irreversible_loss";

    case "the_paranoid":
      // Unstable paranoia creates loops, stable paranoia creates false realities
      return stability === "unstable" ? "loop" : "false_reality";

    case "the_guilty":
      // Guilt always leads to irreversible loss
      return "irreversible_loss";

    case "the_denier":
      // Deniers get identity twists as their reality unravels
      return stability === "unstable" ? "mental_fabrication" : "identity_twist";

    default:
      return "ambiguity";
  }
}

/**
 * Gets the current ending archetype for a story state
 * 
 * This function implements the timing logic for ending assignment.
 * Between 30-50% story progress, it caches the ending for consistency.
 * Before assignment, it returns dynamic calculation; after, it returns cached value.
 * 
 * @param state - Current story state
 * @returns The ending archetype (cached or dynamic)
 * 
 * @example
 * ```typescript
 * const ending = getCurrentEndingArchetype(state);
 * // Returns cached ending after 40% progress, dynamic before
 * ```
 */
export function getCurrentEndingArchetype(state: StoryState): Ending {
  const pageProgress = state.page / state.maxPage;
  
  // Assign ending at 30-50% progress for optimal foreshadowing
  if (!state.cachedEndingArchetype && pageProgress >= 0.3 && pageProgress <= 0.5) {
    // Ensure profile is up-to-date before assigning ending
    if (!state.psychologicalProfile) {
      updatePsychologicalProfile(state);
    }
    state.cachedEndingArchetype = determineEndingArchetype(state);
  }
  
  // Return cached ending if available, otherwise calculate dynamically
  return state.cachedEndingArchetype || determineEndingArchetype(state);
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
  
  const recentActions = state.actionsHistory.slice(-3);
  const earlierActions = state.actionsHistory.slice(-6, -3);
  
  const { flags } = state;
  const profile = state.psychologicalProfile;
  
  // Detect curiosity collapse (was exploring, now avoiding)
  const wasCurious = earlierActions.some(a => a.type === "explore");
  const nowAvoiding = recentActions.some(a => a.type === "escape");
  
  if (wasCurious && nowAvoiding && !state.hiddenState.profileShift) {
    state.hiddenState.profileShift = {
      detected: true,
      shiftType: "curiosity_collapse",
      detectedAt: state.page,
      originalEnding: state.cachedEndingArchetype
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
      originalEnding: state.cachedEndingArchetype
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
      originalEnding: state.cachedEndingArchetype
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
      originalEnding: state.cachedEndingArchetype
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
      originalEnding: state.cachedEndingArchetype
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
      originalEnding: state.cachedEndingArchetype
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
      originalEnding: state.cachedEndingArchetype
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
      originalEnding: state.cachedEndingArchetype
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
        originalEnding: state.cachedEndingArchetype
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
      originalEnding: state.cachedEndingArchetype
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
        originalEnding: state.cachedEndingArchetype
      };
      return true;
    }
    
    if (traitsIndicateFear && nowAggressive && !state.hiddenState.profileShift) {
      state.hiddenState.profileShift = {
        detected: true,
        shiftType: "fear_to_aggression",
        detectedAt: state.page,
        originalEnding: state.cachedEndingArchetype
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
export function getShiftedEnding(state: StoryState): Ending {
  if (!state.hiddenState.profileShift?.detected) {
    return getCurrentEndingArchetype(state);
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
      
    default: return getCurrentEndingArchetype(state);
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
    const ending = getCurrentEndingArchetype(state);
    const triggerPage = Math.max(state.page + 1, state.maxPage - 2);
    
    if (ending === "fake_escape" || ending === "loop" || ending === "identity_twist") {
      setupFakeToRealEnding(state, triggerPage, "fake_relief_twist");
    }
  }
}