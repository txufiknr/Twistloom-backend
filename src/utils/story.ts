import { ARCHETYPE_ACTION_AFFINITY, DANGEROUS_ACTIONS, DEFAULT_SCENE_URGENCY, MAJOR_EVENT_CLIMAX_FLOOR, MANIPULATION_HINT_AFFINITY, MAX_ACTION_HISTORY, MAX_CHARACTERS, MAX_DOMINANT_TRAITS, MAX_FUTURE_NOTES, MAX_PLACES, MAX_TRAUMA_TAGS, MOMENTUM_BASELINE_SCORE, MOMENTUM_PERSISTENCE, MOMENTUM_RECENCY_WINDOW, MOMENTUM_THRESHOLDS, MOMENTUM_WEIGHTS, RESOLVING_DROP_THRESHOLD, SAFE_ACTIONS, SCENE_ROLE_DANGER, SCENE_TYPE_URGENCY, TENDENCY_RECENCY_WINDOW, THREAD_PRIORITY_WEIGHT, THREAT_PROXIMITY_SCORE } from "../config/story.js";
import { HIDDEN_STATE_DEFAULTS, STORY_STATE_DEFAULTS, SANITY_STATE_DEFAULTS } from "../schema/story.js";
import { storyPhases, plotFlagTypes } from "../types/story.js";
import { calculateHealthStatus, processCharacterUpdates } from "./characters.js";
import { processPlaceUpdates } from "./places.js";
import { deepEqualSimple } from "../utils/parser.js";
import { calculatePlayerProfile } from './player-profile.js';
import { ensureUniqueId } from "./text-processing.js";
import type { StoryState, StoryMomentum, SceneType, PsychologicalProfileMetrics, PsychologicalProfile, Archetype, StabilityLevel, ManipulationAffinity, EndingType, HiddenState, EndingPlanType, EndingPlan, ProfileShiftType, ProfileShift, StoryStateInfo, StoryPhase, FinalePhase, StateDelta, StoryGeneration, FlagLevel, PlotFlag, TagUpdates, TagItem, FutureNote, FactUpdate, FutureNoteGeneration, Action, PsychologicalStateDelta, InitialPlotFlag, StoryScene, CalculateStoryMomentumParams, StoryMomentumResult, SceneCharacter, EndingRecommendation, NarrativeContext, PersistedStoryPage, SelectedAction, StateDeltaGeneration } from "../types/story.js";
import type { Injury, InventoryItem } from "../types/character.js";
import type { ThreadUpdates, StoryThread, ThreadClue } from "../types/story-thread.js";
import type { CandidateGenerationPage } from "../types/candidate-generation.js";
import type { NewThread } from "../types/story-thread.js";

/**
 * Create a StoryThread object from a NewThread-like spec.
 * Exported so other modules (prompt initialization) can reuse the same
 * construction logic and remain consistent.
 */
export function createStoryThread(spec: NewThread, page: number): StoryThread {
  return {
    ...spec,
    importance: spec.importance ?? 0.5,
    clues: spec.clues?.map<ThreadClue>(c => ({ ...c, discoveredAtPage: page })) ?? [],
    status: 'open',
    introducedAt: page,
    lastUpdatedAt: page,
    urgency: 0.27, // Start with low urgency
  } satisfies StoryThread;
}

/**
 * Pressure from recent major plot flags. A major event introduced this page
 * contributes 1.0; pressure linearly decays to 0 over RECENCY_WINDOW pages.
 */
export function calculatePlotFlagPressure(plotFlags: PlotFlag[], currentPage: number): number {
  let pressure = 0;
  for (const flag of plotFlags) {
    if (!flag.isMajorEvent) continue;
    const distance = currentPage - flag.page;
    if (distance < 0 || distance > MOMENTUM_RECENCY_WINDOW) continue;
    pressure += 1 - distance / (MOMENTUM_RECENCY_WINDOW + 1);
  }
  return Math.min(1, pressure);
}

/**
 * Pressure from open story threads (mysteries), weighted by priority and
 * importance. Threads updated this page get a small recency boost — a fresh
 * clue should nudge momentum even if the thread's stored urgency hasn't
 * caught up yet.
 */
export function calculateThreadPressure(threads: StoryThread[], currentPage: number): number {
  const active = threads.filter(t => t.status === 'open');
  if (!active.length) return 0;

  let weightedSum = 0;
  let totalWeight = 0;

  for (const thread of active) {
    const priorityWeight = THREAD_PRIORITY_WEIGHT[thread.priority] ?? 0.5;
    const threadScore = thread.urgency * (0.6 + thread.importance * 0.4);
    const recencyBoost = thread.lastUpdatedAt === currentPage ? 0.15 : 0;

    weightedSum += Math.min(1, threadScore + recencyBoost) * priorityWeight;
    totalWeight += priorityWeight;
  }

  return Math.min(1, weightedSum / totalWeight);
}

/**
 * Immediate danger: hiddenState.threatProximity (primary signal), recent
 * dangerous/safe actions (most recent weighted higher), character scene
 * roles weighted by sceneFocus, and current fear flag.
 *
 * Character contribution is a focus-weighted average across all present
 * characters, so a single high-focus threat reads as more dangerous than
 * several low-focus ones, and a background opposition character doesn't
 * dominate. A character who suspicious towards the MC gets a small boost
 * on top of their role score — hidden threat is worse than declared threat.
 */
export function calculateDangerLevel(state: StoryState, charactersPresent?: SceneCharacter[]): number {
  const threatScore = THREAT_PROXIMITY_SCORE[state.hiddenState.threatProximity] ?? 0.2;

  const recent = state.actionsHistory.slice(-2);
  let actionScore = 0;
  recent.forEach((action, i) => {
    const weight = i === recent.length - 1 ? 0.6 : 0.4;
    if (DANGEROUS_ACTIONS.includes(action.type)) actionScore += weight;
    else if (SAFE_ACTIONS.includes(action.type)) actionScore -= weight * 0.5;
  });
  actionScore = Math.max(0, Math.min(1, actionScore));

  // Focus-weighted average of per-character danger scores.
  // sceneFocus is the weight — a high-focus threat dominates, a
  // low-focus one lurks quietly in the background.
  let characterDangerScore = 0;
  if (charactersPresent?.length) {
    let weightedSum = 0;
    let totalFocus = 0;

    for (const sc of charactersPresent) {
      const memory = state.characters[sc.characterId];
      const roleScore = SCENE_ROLE_DANGER[sc.sceneRole] ?? 0;

      // A suspicious character (secret threat) is worse than a declared one —
      // small bump, capped at 1.0 per character
      const suspicionBoost = memory?.relationshipToMC?.status === 'suspicious' ? 0.2 : 0;
      const characterScore = Math.min(1, roleScore + suspicionBoost);

      weightedSum += characterScore * sc.sceneFocus;
      totalFocus  += sc.sceneFocus;
    }

    characterDangerScore = totalFocus > 0
      ? Math.min(1, weightedSum / totalFocus)
      : 0;
  }

  const fearScore = state.flags.fear === 'high' ? 1 : state.flags.fear === 'medium' ? 0.5 : 0.2;

  return Math.min(1,
    threatScore          * 0.35 +
    actionScore          * 0.25 +
    characterDangerScore * 0.25 +
    fearScore            * 0.15,
  );
}

/**
 * Scene-driven urgency, blended with thread pressure (an urgent mystery
 * raises the floor even during a quiet scene type).
 */
export function calculateUrgencyLevel(sceneType: SceneType | undefined, threadPressure: number): number {
  const sceneScore = sceneType ? (SCENE_TYPE_URGENCY[sceneType] ?? DEFAULT_SCENE_URGENCY) : DEFAULT_SCENE_URGENCY;
  return Math.min(1, sceneScore * 0.6 + threadPressure * 0.4);
}

/**
 * Psychological pressure: fear and aggression dominate, trauma weight and
 * cognitive disorder (1 - cognitiveState) add a "things are getting away
 * from the MC" component.
 */
export function calculatePsychPressure(profile: PsychologicalProfileMetrics): number {
  const cognitiveDisorder = 1 - profile.cognitiveState;
  return Math.min(1,
    profile.fear         * 0.35 +
    profile.aggression   * 0.2 +
    profile.traumaWeight * 0.25 +
    cognitiveDisorder    * 0.2
  );
}

function scoreToMomentum(score: number): StoryMomentum {
  for (const { max, momentum } of MOMENTUM_THRESHOLDS) {
    if (score <= max) return momentum;
  }
  return 'critical';
}

/**
 * Calculates current story momentum (narrative pressure/urgency) for the
 * page about to be persisted.
 *
 * Combines five 0–1 factors into a raw score, smooths it against the parent
 * page's momentum (so momentum ramps rather than jumps page-to-page), then
 * maps to a discrete StoryMomentum — with two overrides:
 *  - a major event this page forces 'climactic' (if the raw score clears
 *    a minimal floor — a major event in an otherwise very calm scene still
 *    reads as a turning point, but won't override a near-zero score)
 *  - a sharp drop from a peak ('tense'/'climactic') maps to 'resolving'
 *    instead of jumping straight back down the scale
 *
 * @example
 * ```typescript
 * const { momentum } = calculateStoryMomentum({
 *   state: newState,
 *   currentPage: expectedPageNumber,
 *   sceneType: generatedStoryPage.sceneType,
 *   charactersPresent: generatedStoryPage.charactersPresent ?? [],
 *   previousMomentum: actionedPage.momentum,
 * });
 * ```
 */
export function calculateStoryMomentum(params: CalculateStoryMomentumParams): StoryMomentumResult {
  const { state, currentPage, sceneType, charactersPresent, previousMomentum } = params;

  const profile = calculatePlayerProfile(state);

  const plotPressure   = calculatePlotFlagPressure(state.plotFlags, currentPage);
  const threadPressure = calculateThreadPressure(state.threads, currentPage);
  const dangerLevel    = calculateDangerLevel(state, charactersPresent);
  const urgencyLevel   = calculateUrgencyLevel(sceneType, threadPressure);
  const psychPressure  = calculatePsychPressure(profile);

  const rawScore =
    plotPressure   * MOMENTUM_WEIGHTS.plotPressure +
    threadPressure * MOMENTUM_WEIGHTS.threadPressure +
    dangerLevel    * MOMENTUM_WEIGHTS.dangerLevel +
    urgencyLevel   * MOMENTUM_WEIGHTS.urgencyLevel +
    psychPressure  * MOMENTUM_WEIGHTS.psychPressure;

  const prevScore = previousMomentum ? MOMENTUM_BASELINE_SCORE[previousMomentum] : rawScore;
  const smoothedScore = prevScore * MOMENTUM_PERSISTENCE + rawScore * (1 - MOMENTUM_PERSISTENCE);

  let momentum: StoryMomentum;

  if (state.isMajorEvent && smoothedScore >= MAJOR_EVENT_CLIMAX_FLOOR) {
    momentum = 'critical';
  } else {
    momentum = scoreToMomentum(smoothedScore);

    // An elevated state ('rising' or 'critical') that drops sharply reads as
    // tension being released, not a reset back to quiet setup.
    const wasElevated = previousMomentum === 'rising' || previousMomentum === 'critical';
    const droppedSignificantly = wasElevated
      && (MOMENTUM_BASELINE_SCORE[previousMomentum!] - smoothedScore) >= RESOLVING_DROP_THRESHOLD
      && momentum !== 'critical';

    if (droppedSignificantly) momentum = 'resolution';
  }

  return {
    momentum,
    rawScore,
    smoothedScore,
    factors: { plotPressure, threadPressure, dangerLevel, urgencyLevel, psychPressure },
  };
}

/**
 * Calculates how strongly this action aligns with the reader's established
 * behavioral pattern and psychological profile.
 *
 * Three weighted factors:
 *  - Frequency:  how often has the reader chosen this action type recently?
 *  - Archetype:  does this action type fit the derived archetype's tendencies?
 *  - Hint:       does the hint type match what engages this reader's manipulation affinity?
 *
 * Returns 0.0–1.0. Higher = more "on-brand" for this reader/character.
 *
 * @example
 * // Called after generation, for each action in the generated set
 * const tendency = calculateActionTendency(action, newState);
 */
export function calculateActionTendency(action: Action, state: StoryState): number {
  const { psychologicalProfile, actionsHistory } = state;
  const { archetype, manipulationAffinity } = psychologicalProfile;

  // 1. Historical frequency — how often has this action type appeared in recent choices?
  const recent = actionsHistory.slice(-TENDENCY_RECENCY_WINDOW);
  const frequencyScore = recent.length > 0
    ? recent.filter(a => a.type === action.type).length / recent.length
    : 0.5; // no history yet → neutral

  // 2. Archetype affinity — does this action type fit the archetype's behavioral gravity?
  const archetypeScore = ARCHETYPE_ACTION_AFFINITY[archetype]?.[action.type] ?? 0.35;

  // 3. Hint/manipulation affinity — does the hint type engage this reader's psychology?
  const hintScore = MANIPULATION_HINT_AFFINITY[manipulationAffinity]?.[action.hint.type] ?? 0.35;

  return Math.min(1, Math.max(0,
    frequencyScore  * 0.40 +
    archetypeScore  * 0.40 +
    hintScore       * 0.20,
  ));
}

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
export function extractStateDelta(params: {
  generatedStoryPage: StoryGeneration,
  expectedPageNumber: number,
  futureNoteKeys: string[],
}): StateDelta {
  const { generatedStoryPage: generation, expectedPageNumber, futureNoteKeys } = params;
  const { placeId, futureNoteUpdates } = generation;
  if (expectedPageNumber === 1) return {}; // No story state delta for page 1

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
    placeConnectionUpdates: generation.placeConnectionUpdates,
    placeUpdates: generation.placeUpdates,
    threadUpdates: generation.threadUpdates,
    viableEnding: generation.viableEnding,
    isMajorEvent: generation.addPlotFlags?.some(p => p.isMajorEvent),
    contextHistory: generation.contextHistory,
    addPlotFlags: generation.addPlotFlags,
    minutesPassed: generation.minutesPassed,
    // Tag with current place for context
    inventory: generation.inventory?.map(inventory => inventory.pageAcquired === expectedPageNumber ? ({ ...inventory, placeId }) : inventory),
    injuries: generation.injuries?.map(injury => injury.pageAcquired === expectedPageNumber ? ({ ...injury, placeId }) : injury),
  } satisfies Record<keyof StateDeltaGeneration | 'isMajorEvent', unknown>;
  // } satisfies StateDelta;

  return stateDelta;
}

export function mapFutureNoteWithKey(notes: FutureNoteGeneration[] | undefined, expectedPageNumber: number, futureNoteKeys: string[]): FutureNote[] {
  const registeredKeys = new Set(futureNoteKeys);
  return notes?.map<FutureNote>(note => {
    const tag = note.tag || 'other';
    const key = ensureUniqueId(tag, registeredKeys, { alwaysShowSuffix: true });
    registeredKeys.add(key);
    if (note.relatedThreadId === 'none') delete note.relatedThreadId; // Exclude `relatedThreadId` key if value is "none"
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
    // To consider: addPlannedCharacters,
    addPlotFlags,
    factUpdates,
    characterUpdates,
    relationshipUpdates,
    placeConnectionUpdates,
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
    difficulty
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
    viableEnding: viableEnding ? { ...baseState.viableEnding, ...viableEnding } : baseState.viableEnding,
    psychologicalProfile: psychologicalProfileUpdates ? { ...baseState.psychologicalProfile, ...psychologicalProfileUpdates } : baseState.psychologicalProfile,
    hiddenState: hiddenStateUpdates ? { ...baseState.hiddenState, ...hiddenStateUpdates } : baseState.hiddenState,
    memoryIntegrity: memoryIntegrity ?? baseState.memoryIntegrity,
    difficulty: difficulty ?? baseState.difficulty,
  };

  const [previousPlaceId] = Object.entries(baseState.places).find(([, place]) => place.lastVisitedAtPage === newState.page - 1) ?? [];

  // Mutating helpers are now safe: they operate on freshly-copied arrays/objects
  processTraumaTagUpdates(newState, traumaTagUpdates);
  processFutureNoteUpdates(newState, futureNoteUpdates);
  processPlotFlagUpdates(newState, addPlotFlags, scene);
  processFactUpdates(newState, factUpdates);
  processCharacterUpdates(newState, characterUpdates, relationshipUpdates, scene?.placeId);
  processPlaceUpdates(newState, placeUpdates, placeConnectionUpdates, scene, previousPlaceId);
  processThreadUpdates(newState, threadUpdates);

  // Apply flag updates — each update contains a `type` and `level`.
  if (flagUpdates?.length) {
    newState.flags = { ...newState.flags };
    for (const flagUpdate of flagUpdates) {
      newState.flags[flagUpdate.type] = flagUpdate.level;
    }
  }

  // Apply inventory updates (full replacements, remove which has amount of 0).
  // Note: Empty array or ommited means no change.
  if (inventory?.length) newState.inventory = cleanUpInventory(inventory);
  // Apply injury updates (full replacements, remove which has severity of 0).
  if (injuries?.length) {
    newState.injuries = removeHealedInjuries(injuries);
    newState.healthStatus = calculateHealthStatus(newState.injuries);
  }

  // Update world clock using AI-provided minutesPassed or scene-type heuristic
  const minutesPassed = stateDelta.minutesPassed;
  if (minutesPassed !== undefined || scene?.sceneType) {
    updateWorldClock(newState, scene?.sceneType, minutesPassed);
  }

  return newState;
}

/**
 * Applies an ordered chain of page deltas on top of a base state.
 *
 * This is the shared core of both reconstruction paths
 * ({@link reconstructStoryStateFromParentChain} and the heavier
 * `reconstructStoryState` branch-traversal function) — previously each
 * implemented its own copy of this loop, and both copies independently
 * had the same bug: `state.page` was left at the base state's page number
 * for the entire loop instead of being advanced per page, so every
 * page-stamped field written by a `processXxx` helper during
 * reconstruction (plot flag `page`, thread `introducedAt`/`lastUpdatedAt`,
 * clue `discoveredAtPage`) ended up tagged with the snapshot's page
 * instead of the actual page the delta came from.
 *
 * `applyStateDelta`'s contract (see its docs) is that `baseState.page` is
 * already the page being applied — true in the live generation flow
 * because `advanceStoryState` increments `.page` first. This helper makes
 * the same contract hold true for every step of a reconstruction loop.
 *
 * @param baseState - Starting state (typically a stored snapshot)
 * @param pages - Pages to apply, in chronological order, NOT including the page baseState was loaded from
 */
export function applyDeltaChain(baseState: StoryState, pages: PersistedStoryPage[]): StoryState {
  let currentState = baseState;
  for (const page of pages) {
    // Sync page/pageId to the delta being applied BEFORE applying it, so
    // any page-stamped fields written inside are stamped correctly.
    currentState = applyStateDelta({ ...currentState, pageId: page.id, page: page.page }, page.stateDelta, page);
  }
  return currentState;
}

/**
 * Extends an existing actionsHistory with entries for a chain of pages.
 *
 * `actionsHistory` is accumulated directly on `StoryState` (not part of
 * `StateDelta`), so `applyDeltaChain`/`applyStateDelta` never touch it.
 * This walks consecutive page pairs and finds, on each parent page's
 * `actions`, the one whose `destinationPageIds` led to the next page.
 *
 * @param existingHistory - History to extend (e.g. the base snapshot's actionsHistory)
 * @param pages - Full ordered chain INCLUDING the page `existingHistory` already accounts for as pages[0]
 */
export function appendActionsHistory(existingHistory: SelectedAction[], pages: PersistedStoryPage[]): SelectedAction[] {
  const appended: SelectedAction[] = [];

  for (let i = 1; i < pages.length; i++) {
    const page = pages[i];
    const parentPage = pages[i - 1];
    const selectedAction = parentPage.actions?.find(action => action.destinationPageIds?.some(id => id === page.id));

    if (selectedAction) {
      appended.push({
        text: selectedAction.text,
        type: selectedAction.type,
        hint: selectedAction.hint,
        page: parentPage.page,   // Page where action was taken, not destination
        pageId: parentPage.id,   // Page where action was taken, not destination
        nextPageId: page.id,
      });
    } else {
      console.warn(`[appendActionsHistory] ⚠️ No matching action found for page ${page.id} from parent ${parentPage.id}`);
    }
  }

  return [...existingHistory, ...appended];
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
export async function advanceStoryState(state: StoryState, actionedPage: Pick<CandidateGenerationPage, 'page' | 'actions' | 'action' | 'momentum' | 'sceneType'>): Promise<StoryState> {
  const { actions: allActions, action, page } = actionedPage;
  const { phase } = getStoryStateInfo(state);

  const selectedIndex = allActions.findIndex(action => action.text === action.text);
  const selectedLetter = String.fromCharCode(65 + selectedIndex); // A, B, C, etc.
  const narrativeContext: NarrativeContext = {
    momentum: actionedPage.momentum,
    sceneType: actionedPage.sceneType,
    phase
  };

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
  if (updatedState.inventory?.length) {
    updatedState.inventory = cleanUpInventory(updatedState.inventory);
  }

  // Apply injury decay to MC injuries
  if (updatedState.injuries?.length) {
    updatedState.injuries = decayInjuries(updatedState.injuries);
  }

  // Apply injury decay to all characters
  Object.values(updatedState.characters).forEach(character => {
    if (character.injuries?.length) {
      character.injuries = decayInjuries(character.injuries);
    }
  });

  // Update psychological flags based on action type
  updateFlags(updatedState, actionedPage.action);

  // Escalate story tension and hidden state
  updateHiddenState(updatedState, narrativeContext);

  // Update sanity/composure resource (momentum-driven ticking clock)
  updateSanity(updatedState, narrativeContext);

  // Update psychological profile based on new state
  updatePsychologicalProfile(updatedState, narrativeContext);

  // Update advanced ending systems (profile shifts, fake endings)
  updateAdvancedEndingSystems(updatedState);

  return updatedState;
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
    case "social":   trustScore += 0.3; break;   // Social builds trust
    case "explore":  trustScore += 0.1; break;   // Exploration builds some trust
    case "protect":  trustScore += 0.4; break;   // Protecting others strongly builds trust
    case "heal":     trustScore += 0.3; break;   // Healing builds trust
    case "create":   trustScore += 0.1; break;   // Creation builds some trust
    case "dialogue": trustScore += 0.2; break;   // Dialogue builds trust
    case "risk":     trustScore -= 0.4; break;   // Risky actions damage trust
    case "escape":   trustScore -= 0.3; break;   // Escape shows distrust
    case "ignore":   trustScore -= 0.2; break;   // Ignoring erodes trust
    case "attack":   trustScore -= 0.3; break;   // Attack damages trust
    case "deceive":  trustScore -= 0.5; break;   // Deception severely damages trust
    case "custom":   trustScore += 0.05; break;  // Custom actions have minimal trust impact
    case "other":    trustScore += 0.05; break;  // Other actions have minimal trust impact
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
    case "escape":   fearScore += 0.4; break;    // Escape increases fear
    case "risk":     fearScore += 0.3; break;    // Risk increases fear
    case "attack":   fearScore += 0.2; break;    // Attack can create fear
    case "explore":  fearScore += 0.2; break;    // Exploration can be scary
    case "ignore":   fearScore += 0.1; break;    // Ignoring creates fear
    case "deceive":  fearScore += 0.2; break;    // Deception creates fear
    case "social":   fearScore -= 0.1; break;    // Social reduces fear slightly
    case "protect":  fearScore -= 0.1; break;    // Protecting reduces fear
    case "heal":     fearScore -= 0.2; break;    // Healing reduces fear
    case "create":   fearScore -= 0.1; break;    // Creation reduces fear
    case "dialogue": fearScore -= 0.05; break;   // Dialogue reduces fear
    case "custom":   fearScore += 0.05; break;   // Custom actions have minimal fear impact
    case "other":    fearScore += 0.05; break;   // Other actions have minimal fear impact
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
    case "explore":  curiosityScore += 0.4; break;   // Exploration drives curiosity
    case "risk":     curiosityScore += 0.3; break;   // Risk requires curiosity
    case "create":   curiosityScore += 0.3; break;   // Creation drives curiosity
    case "dialogue": curiosityScore += 0.2; break;   // Dialogue creates curiosity
    case "social":   curiosityScore += 0.1; break;   // Social creates curiosity
    case "ignore":   curiosityScore += 0.2; break;   // Ignoring increases curiosity
    case "deceive":  curiosityScore += 0.1; break;   // Deception requires curiosity
    case "protect":  curiosityScore += 0.05; break;  // Protecting creates some curiosity
    case "heal":     curiosityScore += 0.1; break;   // Healing creates curiosity
    case "attack":   curiosityScore += 0.05; break;  // Attack creates minimal curiosity
    case "escape":   curiosityScore -= 0.2; break;   // Escape reduces curiosity
    case "custom":   curiosityScore += 0.1; break;   // Custom actions create curiosity
    case "other":    curiosityScore += 0.05; break;  // Other actions create minimal curiosity
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

  // `remove` is always `string[]` (keys), even when T is an object TagItem
  // (e.g. FutureNote). Compare by extracted key so object-vs-string-key
  // comparisons work, not just same-typeof comparisons.
  const keyOf = (item: TagItem): string => typeof item === 'string' ? item : item.key;
  const isSameItem = (a: TagItem, b: TagItem): boolean => keyOf(a) === keyOf(b);

  // 1. Remove specified items
  if (updates.remove?.length) {
    targetArray.splice(
      0,
      targetArray.length,
      ...targetArray.filter(item => !updates.remove!.some(r => isSameItem(item, r))),
    );
  }

  // 2. Add new items (avoid duplicates)
  if (updates.add?.length) {
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

  const { placeId, calendarDate, timeOfDay } = scene ?? {};

  for (const addPlotFlag of addPlotFlags) {
    // Validate / normalise type
    const validType = plotFlagTypes.includes(addPlotFlag.type as any) ? addPlotFlag.type : "other";
    const normalized: PlotFlag = { ...addPlotFlag, page: state.page, placeId, calendarDate, timeOfDay, type: validType };
  
    // Guard against duplicates (same page + type + fact).
    // This mirrors the deduplication in processTagUpdates and provides a safety
    // net against double-application from retries or repeated reconstruction.
    const isDuplicate = state.plotFlags.some(f => f.page === normalized.page && f.type === normalized.type && f.fact === normalized.fact);
    if (isDuplicate) continue;
  
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
 * Processes AI-generated thread updates and advances thread pacing.
 *
 * This function:
 * - Applies passive urgency decay to all active threads
 * - Creates new threads
 * - Updates existing thread metadata
 * - Adds newly discovered clues
 * - Closes resolved threads
 * - Applies AI-provided urgency corrections
 * - Increases urgency for threads that were actively touched this page
 *
 * Urgency represents how close a thread is to a major reveal,
 * twist, or resolution.
 *
 * Engine-owned pacing:
 * - All active threads gradually lose urgency over time if ignored
 * - Threads gain urgency whenever they are meaningfully developed
 * - More important threads gain urgency faster
 *
 * AI-owned pacing:
 * - `urgencyCorrection` may be used to reflect exceptional shifts
 *   in narrative momentum (breakthroughs, setbacks, major twists)
 * - Routine progression should rely on automatic urgency updates
 *
 * @param state - Mutable story state
 * @param threadUpdates - Optional thread operations generated by AI
 */
export function processThreadUpdates(state: StoryState, threadUpdates?: ThreadUpdates): void {
  // Decay urgency for all active threads slightly to represent natural
  // cooling when threads are ignored. Keep a sensible floor so threads
  // never drop to zero and lose all momentum.
  for (const thread of state.threads) {
    thread.urgency = Math.max(0.1, thread.urgency - 0.01);
  }

  if (!threadUpdates) return;

  // Create new threads
  if (threadUpdates.newThreads?.length) {
    for (const newThread of threadUpdates.newThreads) {
      const thread = createStoryThread(newThread, state.page);
      state.threads.push(thread);
    }
  }

  // Update existing threads
  if (threadUpdates.updateThreads?.length) {
    for (const update of threadUpdates.updateThreads) {
      const existingThread = state.threads.find(t => t.threadId === update.threadId);
      if (existingThread) {
        if (update.status) existingThread.status = update.status;
        if (update.priority) existingThread.priority = update.priority;
        if (update.truth) existingThread.truth = update.truth;
        if (update.importance !== undefined) existingThread.importance = update.importance;
        if (update.urgencyCorrection !== undefined && update.urgencyCorrection !== 0) {
          existingThread.urgency = Math.max(Math.min(existingThread.urgency + update.urgencyCorrection, 1.0), 0);
        }
        if (update.summary) existingThread.summary = update.summary;
        if (update.resolution) existingThread.resolution = update.resolution;
        existingThread.lastUpdatedAt = state.page;
      }
    }
  }

  // Add clues to existing threads
  if (threadUpdates.addClues?.length) {
    for (const newClue of threadUpdates.addClues) {
      const existingThread = state.threads.find(t => t.threadId === newClue.threadId);
      if (existingThread) {
        existingThread.clues.push({ ...newClue, discoveredAtPage: state.page });
        existingThread.lastUpdatedAt = state.page;
        // A newly added clue should raise urgency proportional to thread importance
        existingThread.urgency = Math.min(1.0, existingThread.urgency + existingThread.importance * 0.05);
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

  // Increase urgency every time the thread is introduced or touched
  // Increase urgency for threads that were introduced or touched on this page.
  for (const thread of state.threads) {
    if (thread.lastUpdatedAt === state.page) {
      thread.urgency = Math.min(1.0, thread.urgency + (thread.importance * 0.03));
    }
  }
}

/**
 * Updates hidden story state based on dynamic momentum, scene context,
 * and progression.
 * 
 * Escalates threat proximity, reality stability, memory integrity,
 * and difficulty based on current state and momentum. Escapes the "linear death
 * march" by allowing reality and memory to fluctuate based on immediate
 * narrative pressure, while still trending downward over time.
 * 
 * @param state - Current story state to update
 * @param context - The current momentum, scene type, and overarching story phase
 */
export function updateHiddenState(state: StoryState, context: NarrativeContext): void {
  const { momentum = 'building', sceneType = 'transition', phase = 'EARLY' } = context;
  
  const pageProgress = state.maxPage > 0 ? (state.page / state.maxPage) : 0; 
  const traumaCount = state.traumaTags.length;
  const stressfulActionCount = state.actionsHistory.filter(
    a => a.type === 'attack' || a.type === 'ignore' || a.type === 'escape'
  ).length;

  // 1. Calculate Dynamic Modifiers based on Momentum & Scene
  let momentumModifier = 0;
  if (momentum === 'critical') momentumModifier = 0.35;
  else if (momentum === 'rising') momentumModifier = 0.15;
  else if (momentum === 'resolution') momentumModifier = -0.20; // Healing effect

  let sceneStress = 0;
  if (['horror', 'dream', 'escape'].includes(sceneType)) sceneStress = 0.2;
  else if (['confrontation', 'revelation'].includes(sceneType)) sceneStress = 0.1;
  else if (['aftermath', 'dialogue', 'transition'].includes(sceneType)) sceneStress = -0.15; // Grounding effect

  const isFinale = phase === 'FINALE';

  // ========================
  // TRUTH LEVEL CALCULATION
  // ========================
  let truthScore = 1.0; 
  truthScore -= pageProgress * 0.3; // Less reliant on pure time
  truthScore -= Math.min(traumaCount * 0.08, 0.2); 
  truthScore -= momentumModifier; 
  truthScore -= sceneStress;

  if (isFinale) truthScore = Math.min(truthScore, 0.5); // Hard cap in the finale
  truthScore = Math.max(0, truthScore);

  if (truthScore >= 0.7) state.hiddenState.truthLevel = "mostly_true";
  else if (truthScore >= 0.4) state.hiddenState.truthLevel = "partially_true";
  else state.hiddenState.truthLevel = "mostly_false";

  // ========================
  // MEMORY INTEGRITY CALCULATION
  // ========================
  let memoryScore = 1.0;
  if (state.hiddenState.truthLevel === 'mostly_false') memoryScore -= 0.25;
  
  memoryScore -= Math.min(traumaCount * 0.1, 0.3);
  memoryScore -= (momentumModifier * 0.8); // High momentum splinters focus
  
  memoryScore = Math.max(0, Math.min(1.0, memoryScore));

  if (memoryScore <= 0.35) state.memoryIntegrity = "corrupted";
  else if (memoryScore <= 0.65) state.memoryIntegrity = "fragmented";
  else state.memoryIntegrity = "stable";

  // ========================
  // REALITY STABILITY CALCULATION
  // ========================
  let stabilityScore = 1.0;
  if (state.hiddenState.truthLevel === 'mostly_false') stabilityScore -= 0.25;
  if (state.memoryIntegrity === 'corrupted') stabilityScore -= 0.25;
  
  stabilityScore -= Math.min(stressfulActionCount * 0.05, 0.15);
  stabilityScore -= momentumModifier; // Directly impacts how physical laws hold up
  stabilityScore -= sceneStress;
  
  if (isFinale) stabilityScore -= 0.3; // The world inherently breaks in the finale
  stabilityScore = Math.max(0, Math.min(1.0, stabilityScore));

  if (stabilityScore <= 0.3) state.hiddenState.realityStability = "broken";
  else if (stabilityScore <= 0.6) state.hiddenState.realityStability = "slipping";
  else state.hiddenState.realityStability = "stable";

  // ========================
  // THREAT PROXIMITY CALCULATION
  // ========================
  // Threat is now purely driven by momentum and scene, NOT page count.
  let threatScore = 0.2; // Base baseline
  threatScore += momentumModifier * 1.5; // Critical momentum pushes this extremely high
  if (['escape', 'confrontation', 'horror'].includes(sceneType)) threatScore += 0.3;
  if (['resolution', 'aftermath'].includes(sceneType)) threatScore -= 0.4;
  
  threatScore = Math.max(0, Math.min(1.0, threatScore));

  if (threatScore >= 0.7) state.hiddenState.threatProximity = "immediate";
  else if (threatScore >= 0.4) state.hiddenState.threatProximity = "near";
  else state.hiddenState.threatProximity = "distant";

  // ========================
  // DIFFICULTY CALCULATION
  // ========================
  let difficultyScore = pageProgress * 0.2; // Escalate naturally as page count increases.
  difficultyScore += (1.0 - truthScore) * 0.3;
  difficultyScore += Math.max(0, momentumModifier); // Difficulty scales up with tension, but doesn't easily scale down
  difficultyScore += Math.min(traumaCount * 0.05, 0.2);

  if (isFinale) difficultyScore += 0.3; // Near the ending, behave as at least 'high' regardless of setting.
  difficultyScore = Math.min(difficultyScore, 1.0);

  if (difficultyScore >= 0.8) state.difficulty = "nightmare";
  else if (difficultyScore >= 0.5) state.difficulty = "high";
  else if (difficultyScore >= 0.3) state.difficulty = "medium";
  else state.difficulty = "low";
}

/**
 * Updates the reader-facing sanity/composure resource.
 *
 * Decays composure under sustained critical momentum.
 * Can be spent to resist realityStability collapse (not implemented here —
 * the spending decision is a reader-facing action choice).
 *
 * Key design principle: tie decay to momentum + threatProximity, NOT to
 * a fixed page count, to avoid fighting the AI's variable scene pacing.
 *
 * @param state - Current story state (mutated in place)
 * @param context - Current momentum, scene type, and phase
 */
export function updateSanity(state: StoryState, context: NarrativeContext): void {
  const { momentum = 'building' } = context;

  // Initialize sanity state if not present
  if (!state.sanityState) {
    state.sanityState = { ...SANITY_STATE_DEFAULTS };
  }

  const sanity = state.sanityState;

  // Only decay if we haven't already crashed
  if (sanity.hasCrashed) return;

  // Rate-limited decay:
  // - critical: full decayRate
  // - rising: half decayRate
  // - building/resolution: no decay (recovery opportunity)
  let decayThisPage = 0;
  if (momentum === 'critical') {
    decayThisPage = sanity.decayRate;
  } else if (momentum === 'rising') {
    decayThisPage = Math.round(sanity.decayRate * 0.5);
  }

  // Threat proximity amplifies decay
  if (state.hiddenState.threatProximity === 'immediate') {
    decayThisPage = Math.round(decayThisPage * 1.5);
  } else if (state.hiddenState.threatProximity === 'near') {
    decayThisPage = Math.round(decayThisPage * 1.2);
  }

  // Every 3 trauma tags adds +1 decay
  if (state.traumaTags.length >= 3) {
    decayThisPage += Math.floor(state.traumaTags.length / 3);
  }

  // Apply decay
  sanity.composure = Math.max(0, sanity.composure - decayThisPage);

  // Check for crash
  if (sanity.composure <= 0 && !sanity.hasCrashed) {
    sanity.hasCrashed = true;
    sanity.crashedAtPage = state.page;
  }

  // Small recovery in resolution phase (healing effect)
  if (momentum === 'resolution' && sanity.composure < sanity.maxComposure) {
    sanity.composure = Math.min(sanity.maxComposure, sanity.composure + 3);
  }
}

/**
 * Advances the in-fiction world clock based on scene type.
 *
 * Sets minutesElapsed (how much in-fiction time since last action)
 * and increments totalDaysElapsed on wrap-around.
 *
 * Minutes are the base unit; can be formatted as "1m", "45m", "2h" etc.
 *
 * @param state - Current story state (mutated in place)
 * @param sceneType - The narrative function of the current page
 */
export function updateWorldClock(state: StoryState, sceneType?: SceneType, minutesPassedOverride?: number): void {
  if (!state.hiddenState.worldClock) {
    state.hiddenState.worldClock = {
      minutesElapsed: 0,
      totalDaysElapsed: 0,
    };
  }

  const clock = state.hiddenState.worldClock;

  // Use AI-provided minutesPassed if available, otherwise fall back to scene-type heuristic
  let minutesPassed: number;
  if (minutesPassedOverride !== undefined) {
    minutesPassed = minutesPassedOverride;
  } else {
    // Time passage by scene type (in minutes):
    // - Horror/dream: seconds-to-minutes (tense, focused moments)
    // - Dialogue/confrontation: minutes
    // - Transition/aftermath: tens-of-minutes to hours
    // - Investigation: moderate exploration time
    minutesPassed = 5;
    switch (sceneType) {
      case 'horror':
      case 'dream':
        minutesPassed = 2;
        break;
      case 'dialogue':
      case 'confrontation':
        minutesPassed = 5;
        break;
      case 'investigation':
      case 'revelation':
        minutesPassed = 15;
        break;
      case 'escape':
        minutesPassed = 3;
        break;
      case 'transition':
        minutesPassed = 45;
        break;
      case 'aftermath':
        minutesPassed = 30;
        break;
      case 'deception':
        minutesPassed = 10;
        break;
    }
  }

  clock.minutesElapsed = minutesPassed;

  // Accumulate to days (roughly, for schedule purposes)
  const totalMinutes = (clock.totalDaysElapsed * 24 * 60) + minutesPassed;
  clock.totalDaysElapsed = Math.floor(totalMinutes / (24 * 60));
}

/**
 * Derives psychological profile from current story state using dynamic scene context
 * 
 * This function analyzes the MC's behavior patterns, flags, and actions to
 * create a structured psychological profile for adaptive narrative manipulation.
 * 
 * @param state - Current story state
 * @param context - The current momentum, scene type, and overarching story phase
 * @returns Derived psychological profile for the MC
 * 
 * @example
 * ```typescript
 * const profile = derivePsychologicalProfile(state);
 * // Returns: { archetype: "the_paranoid", stability: "cracking", ... }
 * ```
 */
export function derivePsychologicalProfile(state: StoryState, context: NarrativeContext): PsychologicalProfile {
  const { flags, actionsHistory, traumaTags, difficulty, hiddenState, memoryIntegrity } = state;
  const { momentum = 'building', sceneType = 'transition', phase = 'EARLY' } = context;
  
  // Determine archetype based on dominant behavioral patterns
  let archetype: Archetype = "the_explorer";
  let manipulationAffinity: ManipulationAffinity = "fear";
  
  // Use a Set to automatically prevent duplicate traits (e.g., "curious", "curious")
  const traitSet = new Set<string>();
  
  // 1. Determine Archetype (Same priority queue logic)
  if (flags.curiosity === "high" && flags.fear !== "high") {
    archetype = "the_explorer";
    manipulationAffinity = "confusion";
    traitSet.add("curious").add("investigative");
  } 
  else if (flags.fear === "high" && flags.trust === "low") {
    archetype = "the_paranoid";
    manipulationAffinity = "fear";
    traitSet.add("fearful").add("suspicious").add("cautious");
  } 
  else if (flags.curiosity === "high" && flags.fear === "high") {
    archetype = "the_risk_taker";
    manipulationAffinity = "control_loss";
    traitSet.add("bold").add("impulsive").add("conflicted");
  } 
  else if (flags.guilt === "high" && traumaTags.length > 0) {
    archetype = "the_guilty";
    manipulationAffinity = "guilt";
    traitSet.add("remorseful").add("self-blaming").add("haunted");
  } 
  else if (flags.fear === "high" && flags.curiosity === "low") {
    archetype = "the_avoider";
    manipulationAffinity = "control_loss";
    traitSet.add("cautious").add("hesitant").add("safety-seeking");
  } 
  else if (memoryIntegrity !== "stable" && flags.trust === "medium") {
    archetype = "the_denier";
    manipulationAffinity = "confusion";
    traitSet.add("rationalizing").add("avoidant").add("conflicted");
  }

  // 2. Determine Stability Level dynamically based on Momentum
  let stability: StabilityLevel = "stable";
  
  let instabilityScore = 0;
  if (flags.fear === "high") instabilityScore += 1;
  if (flags.guilt === "high") instabilityScore += 1;
  if (memoryIntegrity === "corrupted") instabilityScore += 2;
  if (hiddenState.realityStability === "broken") instabilityScore += 2;
  if (traumaTags.length >= 3) instabilityScore += 1;
  
  // Immediate scene context heavily influences perceived stability
  if (momentum === 'critical') instabilityScore += 2;
  else if (momentum === 'resolution') instabilityScore -= 2; // Grounding effect
  
  if (sceneType === 'dream' || sceneType === 'horror') instabilityScore += 1;
  if (phase === 'FINALE') instabilityScore += 2; // Hard to stay sane in the finale

  if (instabilityScore >= 5) {
    stability = "unstable";
  } else if (instabilityScore >= 3) {
    stability = "cracking";
  }
  
  // 3. Inject Dynamic Traits from Recent Actions
  if (actionsHistory.length > 0) {
    const recentActions = actionsHistory.slice(-MAX_ACTION_HISTORY);
    
    if (recentActions.some(d => d.type === 'escape')) traitSet.add("fearful");
    if (recentActions.some(d => d.type === 'social')) traitSet.add("social");
    if (recentActions.some(d => d.type === 'explore')) traitSet.add("curious");
    if (recentActions.some(d => d.type === 'attack')) traitSet.add("aggressive");
    if (recentActions.some(d => d.type === 'protect')) traitSet.add("protective");
    if (recentActions.some(d => d.type === 'deceive')) traitSet.add("deceptive");
    if (recentActions.some(d => d.type === 'risk')) traitSet.add("risk_taker");
    if (recentActions.some(d => d.type === 'heal')) traitSet.add("hopeful");
  }
  
  // 4. Add Difficulty Impacts
  if (difficulty === "nightmare") traitSet.add("overwhelmed");
  else if (difficulty === "high") traitSet.add("stressed");
  
  // Convert Set back to Array and slice to max (e.g., 5) to keep prompt clean
  const dominantTraits = Array.from(traitSet).slice(0, MAX_DOMINANT_TRAITS);
  
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
export function updatePsychologicalProfile(state: StoryState, context: NarrativeContext) {
  state.psychologicalProfile = derivePsychologicalProfile(state, context);
}

/**
 * Determines optimal ending archetype based on current story state
 * 
 * Analyzes the complete story state including psychological profile,
 * flags, hidden state, and profile shifts to recommend the most
 * appropriate ending archetype for maximum narrative impact.
 * 
 * @param state - Current story state with psychological profile and flags
 * @returns A structured recommendation object detailing the target ending
 * 
 * @example
 * ```typescript
 * const ending = determineOptimalEnding(state);
 * // Returns: "false_reality" for high-curiosity explorers
 * ```
 */
export function determineOptimalEnding(state: StoryState): EndingRecommendation {
  const { flags, psychologicalProfile, hiddenState, viableEnding } = state;
  const { archetype, stability } = psychologicalProfile;

  // ---------------------------------------------------------
  // TIER 1: Respect an Active Ending Plan (Highest Priority)
  // ---------------------------------------------------------
  if (hiddenState.endingPlan?.armed) {
    let targetEnding: EndingType;
    let summary: string;

    switch (hiddenState.endingPlan.type) {
      case "fake_relief_twist":
        targetEnding = hiddenState.endingPlan.fakeToReal ? (viableEnding?.type ?? "fake_escape") : "fake_escape";
        summary = "Active plan: False sense of security followed by the rug-pull.";
        break;
      case "loop_trap":
        targetEnding = "loop";
        summary = "Active plan: Forcing a cyclical nightmare or time loop.";
        break;
      case "identity_reveal":
        targetEnding = "identity_twist";
        summary = "Active plan: Building toward a shocking truth about MC's identity.";
        break;
      case "unreliable_reality":
        targetEnding = "false_reality";
        summary = "Active plan: The world rules are breaking down completely.";
        break;
      case "possession":
        targetEnding = "possession";
        summary = "Active plan: External control or supernatural possession.";
        break;
      case "silent_void":
        targetEnding = "irreversible_loss";
        summary = "Active plan: Existential dread culminating in permanent loss.";
        break;
      case "observer_twist":
        targetEnding = "simulation";
        summary = "Active plan: Breaking the fourth wall or revealing the simulation.";
        break;
    }

    return {
      type: targetEnding,
      summary,
      because: {
        tier: "ending_plan",
        planType: hiddenState.endingPlan.type,
        fakeToReal: hiddenState.endingPlan.fakeToReal
      }
    };
  }

  // ---------------------------------------------------------
  // TIER 2: Profile Shift Mutation
  // ---------------------------------------------------------
  if (hiddenState.profileShift?.detected) {
    const shiftData = getShiftedEnding(hiddenState.profileShift.shiftType, viableEnding?.type);
    
    if (shiftData) {
      return {
        type: shiftData.type,
        summary: shiftData.summary,
        because: {
          tier: "profile_shift",
          shiftType: hiddenState.profileShift.shiftType,
          originalEnding: viableEnding?.type
        }
      };
    }
  }

  // ---------------------------------------------------------
  // TIER 3: Base Archetype Logic
  // ---------------------------------------------------------
  const baseBecause = {
    tier: "base_archetype" as const,
    archetype,
    stability,
    curiosity: flags.curiosity,
    fear: flags.fear
  };

  switch (archetype) {
    case "the_explorer":
      return flags.curiosity === "high"
        ? { type: "false_reality", summary: "High curiosity leads to discovering impossible, uncomfortable truths.", because: baseBecause }
        : { type: "fake_escape", summary: "Explorer's curiosity waned; they settled for a false exit.", because: baseBecause };
    
    case "the_avoider":
      return { type: "irreversible_loss", summary: "Avoidance eventually demands a permanent, irreversible toll.", because: baseBecause };
    
    case "the_risk_taker":
      return flags.fear === "low"
        ? { type: "fake_escape", summary: "Blind bravery walks directly into an illusion of safety.", because: baseBecause }
        : { type: "irreversible_loss", summary: "Taking risks while fearful leads to permanent, punishing consequences.", because: baseBecause };
    
    case "the_paranoid":
      return stability === "unstable"
        ? { type: "loop", summary: "Complete instability traps the paranoid mind in a familiar nightmare.", because: baseBecause }
        : { type: "false_reality", summary: "Paranoia pays off: the world actually isn't real.", because: baseBecause };
    
    case "the_guilty":
      return { type: "pyrrhic_victory", summary: "Guilt demands sacrifice; success comes at an unacceptable moral cost.", because: baseBecause };
    
    case "the_denier":
      return stability === "unstable"
        ? { type: "mental_fabrication", summary: "Denial shatters into full mental fabrication of events.", because: baseBecause }
        : { type: "identity_twist", summary: "Denial masks the fact that the MC is not who they think they are.", because: baseBecause };
    
    default:
      return {
        type: viableEnding?.type ?? "ambiguity",
        summary: "No strong archetype traits detected. Defaulting to viable ending or ambiguity.",
        because: {
          tier: "fallback",
          archetype,
          viableEnding: viableEnding?.type
        }
      };
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
export function setupFakeToRealEnding(
  state: StoryState,
  triggerPage: number,
  executionType: "fake_relief_twist" | "loop_trap" | "identity_reveal"
): void {
  state.hiddenState.endingPlan = {
    type: executionType,
    armed: true,
    triggerPage,
    fakeToReal: false, // activated later when page >= triggerPage
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
 * Gets mutated ending logic based on profile shift type
 * 
 * If a behavioral shift was detected, this function returns a
 * psychologically appropriate ending that reflects the change.
 * 
 * @param shiftType - The detected behavioral shift
 * @param fallbackEnding - The current viable ending to fall back on
 * @returns Object containing the new archetype and a descriptive summary
 * 
 * @example
 * ```typescript
 * const mutatedEnding = getShiftedEnding(state);
 * // Returns "possession" for aggression turn
 * ```
 */
function getShiftedEnding(shiftType: ProfileShiftType, fallbackEnding?: EndingType): { type: EndingType, summary: string } | undefined {
  switch (shiftType) {
    // "You stopped asking questions... but something kept answering anyway"
    case "curiosity_collapse": return { type: "mental_fabrication", summary: "You stopped asking questions... but something kept answering anyway." };
    // "It didn't chase you because you were slow — it chased you because you understood"
    case "fear_spike": return { type: "loop", summary: "It didn't chase you because you were slow — it chased you because you understood." };
    // "You weren't trying to survive anymore. You were trying to win."
    case "aggression_turn": return { type: "become_threat", summary: "You weren't trying to survive anymore. You became the monster you fought." };
    // "The explorer became the trapped"
    case "archetype_collapse": return { type: "possession", summary: "The core identity collapsed, leaving an empty vessel for control." };
    // "When reality shattered, you found the truth in the pieces"
    case "reality_breakdown": return { type: "false_reality", summary: "When reality shattered, you found the truth in the pieces." };
    // "You finally stopped fighting... and accepted the lie as truth"
    case "manipulation_acceptance": return { type: "mental_fabrication", summary: "You finally stopped fighting... and accepted the lie as truth." };
    // "The curious became fearful — the perfect victim"
    case "trait_inversion": return { type: "loop", summary: "The curious became fearful — stepping perfectly back to the beginning." };
    // "Fear turned to rage, and rage opened the wrong door"
    case "fear_to_aggression": return { type: "possession", summary: "Fear turned to rage, and rage opened the door to outside influence." };
    // "You started lying and couldn't stop — even to yourself"
    case "deception_onset": return { type: "identity_twist", summary: "You started lying and couldn't stop — even to yourself about who you are." };
    // "You pushed everyone away. No one was left to hear you scream."
    case "social_withdrawal": return { type: "irreversible_loss", summary: "You pushed everyone away. Now, there is no one left to lose." };
    // "The protector became the thing everyone needed protecting from"
    case "protective_to_aggressive": return { type: "become_threat", summary: "The protector became the thing everyone needed protecting from." };
    // "You built something beautiful. Then you burned it."
    case "creative_to_destructive": return { type: "escalation", summary: "You built something beautiful, then burned it, creating a worse threat." };

    // Handled here but currently never detected — keep them for when
    // detectProfileShift gains those detection paths:
    case "denial_break": return { type: "false_reality", summary: "The dam broke. The world as you knew it never existed." };
    case "trust_betrayal": return { type: "betrayal", summary: "The safety was a lie; the true villain was the one you trusted." };
    default: return fallbackEnding ? { type: fallbackEnding, summary: "Profile shift mapped to current viable ending." } : undefined;
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

  // Auto-arm fake-to-real plan for twist-eligible ending types
  if (pageProgress >= 0.7 && !state.hiddenState.endingPlan?.armed) {
    const ending = state.viableEnding?.type;
    const triggerPage = Math.max(state.page + 1, state.maxPage - 2);

    if (ending === "fake_escape" || ending === "loop" || ending === "identity_twist") {
      setupFakeToRealEnding(state, triggerPage, "fake_relief_twist");
    }
  }

  // Transition: once we hit triggerPage, activate the rug-pull phase
  const plan = state.hiddenState.endingPlan;
  if (plan?.armed && !plan.fakeToReal && state.page >= plan.triggerPage) {
    state.hiddenState.endingPlan = { ...plan, fakeToReal: true };
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
    worldClock: {
      minutesElapsed: 0,
      totalDaysElapsed: 0,
    },
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