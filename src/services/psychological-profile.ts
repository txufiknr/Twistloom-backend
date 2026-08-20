import { eq, desc, inArray, and } from 'drizzle-orm';
import { dbRead } from '../db/client.js';
import { storyStates, userCompletedBooks } from '../db/schema.js';
import type {
  StoryState,
  SelectedAction,
  PlotFlag,
  Archetype,
  StabilityTier,
  MissedEndingTeaser,
} from '../types/story.js';

export type { StabilityTier } from '../types/story.js';

/**
 * 4-axis behavioral vector scores (0–100 continuous scale) reflecting
 * the reader's decision gravity under tension.
 */
export interface PsychologicalVectorScores {
  /** 0 - 100: Morbid Drive vs. Instinctual Self-Preservation */
  curiosity: number;
  /** 0 - 100: Hyper-Vigilance vs. Naive Faith/Trust */
  paranoia: number;
  /** 0 - 100: Deep Alliance vs. Detached Cynicism */
  trust: number;
  /** 0 - 100: Cold Utilitarian Calculus vs. Ethical Remorse / Moral Guilt */
  pragmatism: number;
}

/**
 * Critical decision divergence turning point where the reader's narrative trajectory permanently shifted.
 */
export interface ProfileDivergencePoint {
  /** Page number where the decisive divergence occurred */
  pageNumber: number;
  /** Name of the scene location or place where the choice was made */
  locationName: string;
  /** Excerpt of the choice text or plot event */
  choiceSnippet: string;
  /** Narrative description of the psychological shift */
  shiftDescription: string;
}

/**
 * Master psychiatric evaluation payload delivered at case closure.
 */
export interface PsychologicalProfilePayload {
  /** Canonical display title of the diagnosed archetype */
  archetype: string;
  /** Machine identifier key of the diagnosed archetype */
  archetypeKey: Archetype;
  /** Evaluated mental stability tier at case conclusion */
  stability: StabilityTier;
  /** Evocative 1-2 sentence psychiatric psychoanalysis */
  diagnosticSummary: string;
  /** Prominent behavioral traits manifested throughout the investigation */
  dominantTraits: string[];
  /** Continuous 4-axis vector scores */
  vectors: PsychologicalVectorScores;
  /** Critical decision divergence point (if detected) */
  divergencePoint?: ProfileDivergencePoint | null;
  /** Canonical rarity weight of the archetype (static design constant, e.g. 8.4);
   *  NOT a live community percentile */
  rarityPercentage?: number;
  /** Counterfactual alternative trajectories for untaken branches ("What If?") */
  missedTeasers?: MissedEndingTeaser[];
}

/**
 * API response structure for single story psychological profile queries.
 */
export interface PsychologicalProfileResponse {
  success: boolean;
  profile: PsychologicalProfilePayload;
}

/**
 * Archetype distribution entry in the user's longitudinal Mind Matrix.
 */
export interface ArchetypeDistributionItem {
  archetype: string;
  archetypeKey: Archetype;
  count: number;
  percentage: number;
}

/**
 * Personality stamp badge unlocked across completed story files.
 * NOTE: intentionally carries no unlock timestamp — the matrix is served on
 * public profiles, so per-archetype first-completion dates are not exposed.
 */
export interface UnlockedStampItem {
  archetypeKey: Archetype;
  name: string;
}

/**
 * API response structure for longitudinal Reader Mind Matrix queries.
 */
export interface ReaderMindMatrixResponse {
  success: boolean;
  matrix: {
    dominantLifetimeArchetype: string;
    dominantLifetimeArchetypeKey: Archetype;
    totalStoriesAnalyzed: number;
    aggregateVectors: PsychologicalVectorScores;
    archetypeDistribution: ArchetypeDistributionItem[];
    unlockedStamps: UnlockedStampItem[];
  };
}

export interface ArchetypeDefinition {
  name: string;
  summary: string;
  traits: string[];
  rarity: number;
}

/**
 * Archetype definitions with canonical display names, diagnostic summaries, traits, and baseline rarities.
 */
export const ARCHETYPE_DEFINITIONS: Record<Archetype, ArchetypeDefinition> = {
  obsessive_investigator: {
    name: "The Obsessive Investigator",
    summary: "You repeatedly sacrificed personal safety and composure to uncover forbidden truths, choosing confrontation over flight in critical encounters.",
    traits: ["Morbid Curiosity", "Defiant Skepticism", "High Risk Tolerance"],
    rarity: 8.4,
  },
  cold_realist: {
    name: "The Cold Realist",
    summary: "You approached survival as an equation, discarding sentimentality and moral hesitation to maximize mathematical odds of endurance.",
    traits: ["Cold Utility", "Calculated Restraint", "Emotional Detachment"],
    rarity: 14.2,
  },
  selfless_martyr: {
    name: "The Selfless Martyr",
    summary: "You willingly absorbed psychological distress, physical injury, and mortal danger to shield others from the horrors lurking in the dark.",
    traits: ["Self-Sacrifice", "Fierce Empathy", "Survivor Guilt"],
    rarity: 11.5,
  },
  hyper_vigilant: {
    name: "The Hyper-Vigilant Paranoiac",
    summary: "You anticipated betrayal in every shadow and alliance, trusting nothing and treating every anomaly as an imminent existential threat.",
    traits: ["Hyper-Vigilance", "Deep Cynicism", "Defensive Instinct"],
    rarity: 18.1,
  },
  reckless_gambler: {
    name: "The Reckless Gambler",
    summary: "Under severe psychological tension, you consistently leaned into high-entropy, chaotic actions, daring the darkness to claim you.",
    traits: ["Impulsive Courage", "High Entropy", "Crisis Adaptability"],
    rarity: 12.8,
  },
  the_fatalist: {
    name: "The Fatalist",
    summary: "You moved through the nightmare with eerie composure, accepting impending doom as inevitable rather than struggling in vain.",
    traits: ["Grim Acceptance", "Nihilistic Calm", "Unyielding Resolve"],
    rarity: 9.6,
  },
};

/**
 * Counterfactual alternative trajectories for paths the reader did NOT take.
 * Drives replay motivation by teasing what other psychological personas lay down untaken branches.
 */
export const ARCHETYPE_MISS_MAP: Record<Archetype, MissedEndingTeaser[]> = {
  obsessive_investigator: [
    {
      archetype: "cold_realist",
      trigger: "If you had prioritized personal survival over forbidden truth at the crossroads...",
      wouldHaveEnded: "pyrrhic_victory",
      teaser: "You would have preserved your composure, but buried the town's darkest secret forever.",
    },
    {
      archetype: "the_fatalist",
      trigger: "If you had surrendered to the inevitable darkness in the archives...",
      wouldHaveEnded: "cosmic_cycle",
      teaser: "You would have accepted the horror with eerie calm rather than fighting back.",
    },
  ],
  cold_realist: [
    {
      archetype: "selfless_martyr",
      trigger: "If you had shielded your companion at the threshold...",
      wouldHaveEnded: "irreversible_loss",
      teaser: "You would have shouldered their pain, altering the final confrontation.",
    },
    {
      archetype: "obsessive_investigator",
      trigger: "If you had risked life and limb to read the forbidden tome...",
      wouldHaveEnded: "ambiguity",
      teaser: "You would have solved the core mystery at the cost of your sanity.",
    },
  ],
  selfless_martyr: [
    {
      archetype: "cold_realist",
      trigger: "If you had refused to carry the emotional burden of others...",
      wouldHaveEnded: "fake_escape",
      teaser: "You would have walked out alive and untainted by survivor's guilt.",
    },
    {
      archetype: "hyper_vigilant",
      trigger: "If you had suspected your allies instead of shielding them...",
      wouldHaveEnded: "betrayal",
      teaser: "You would have uncovered their hidden motives before the final betrayal.",
    },
  ],
  hyper_vigilant: [
    {
      archetype: "selfless_martyr",
      trigger: "If you had lowered your guard and trusted your companions...",
      wouldHaveEnded: "collective_delusion",
      teaser: "You would have discovered warmth in the dark, unlocking an alliance ending.",
    },
    {
      archetype: "reckless_gambler",
      trigger: "If you had stopped calculating dangers and leaped into the unknown...",
      wouldHaveEnded: "escalation",
      teaser: "You would have triggered high-entropy chaos, altering the timeline permanently.",
    },
  ],
  reckless_gambler: [
    {
      archetype: "obsessive_investigator",
      trigger: "If you had methodically analyzed clues instead of gambling on instincts...",
      wouldHaveEnded: "loop",
      teaser: "You would have assembled the full evidence dossier and decoded the cipher.",
    },
    {
      archetype: "the_fatalist",
      trigger: "If you had acknowledged the futility of your defiance...",
      wouldHaveEnded: "predetermined",
      teaser: "You would have found quiet closure in the ending rather than disaster.",
    },
  ],
  the_fatalist: [
    {
      archetype: "obsessive_investigator",
      trigger: "If you had refused to accept your fate and clawed for answers...",
      wouldHaveEnded: "false_reality",
      teaser: "You would have shattered the illusion and exposed the architecture of the simulation.",
    },
    {
      archetype: "reckless_gambler",
      trigger: "If you had defied the cosmic inevitability with wild defiance...",
      wouldHaveEnded: "become_threat",
      teaser: "You would have forced reality itself to fracture around your choices.",
    },
  ],
};

/**
 * Safely parses narrative flag levels ('low' | 'medium' | 'high' or numeric floats) into 0.0–1.0 values.
 */
export function parseFlagLevel(val: unknown): number {
  if (typeof val === 'number' && !Number.isNaN(val)) {
    return Math.min(1, Math.max(0, val));
  }
  if (typeof val === 'string') {
    const lower = val.trim().toLowerCase();
    if (lower === 'low') return 0.2;
    if (lower === 'medium') return 0.5;
    if (lower === 'high') return 0.8;
    const parsed = parseFloat(lower);
    if (!Number.isNaN(parsed)) {
      return Math.min(1, Math.max(0, parsed));
    }
  }
  return 0.5;
}

/**
 * Resolves a human-readable location name from placeId and state place memories,
 * ensuring raw UUID strings never leak into user-facing UI.
 */
function resolveLocationName(placeId: string | undefined, places: unknown): string {
  if (!placeId) return "The Threshold";

  if (places && typeof places === 'object') {
    if (Array.isArray(places)) {
      const found = places.find(
        (p) => typeof p === 'object' && p !== null && (p as { id?: string }).id === placeId
      ) as { name?: string; knownName?: string; realName?: string } | undefined;

      if (found?.name) return found.name;
      if (found?.knownName) return found.knownName;
      if (found?.realName) return found.realName;
    } else {
      const placeMap = places as Record<string, { name?: string; knownName?: string; realName?: string }>;
      const found = placeMap[placeId];
      if (found?.name) return found.name;
      if (found?.knownName) return found.knownName;
      if (found?.realName) return found.realName;
    }
  }

  // Detect UUID or hex strings
  if (/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(placeId) || /^[0-9a-f]{20,}/i.test(placeId)) {
    return "The Critical Crossroads";
  }

  return placeId.replace(/[-_]/g, ' ');
}

/**
 * Calculates 4-axis continuous behavioral vectors from a story state and action history.
 *
 * Vector Axes:
 *  - Curiosity (0–100): Weighted from `explore` actions, `risk` actions, and `flags.curiosity`.
 *  - Paranoia (0–100): Weighted from `escape` actions, `flags.fear`, and inverse of `flags.trust`.
 *  - Trust (0–100): Weighted from `social` / `dialogue` actions and `flags.trust`.
 *  - Pragmatism (0–100): Weighted from utilitarian choices and inverse of `flags.guilt`.
 *
 * @param state - Complete story state snapshot for the target page.
 * @returns PsychologicalVectorScores continuous 0–100 vector object.
 */
export function calculatePsychologicalVectors(state: StoryState): PsychologicalVectorScores {
  const actions = state.actionsHistory || [];
  const flags = state.flags || { curiosity: '0', fear: '0', guilt: '0', trust: '0' };

  let exploreCount = 0;
  let escapeCount = 0;
  let riskCount = 0;
  let socialCount = 0;
  let dialogueCount = 0;
  let protectCount = 0;
  let healCount = 0;
  let attackCount = 0;
  let deceiveCount = 0;
  let ignoreCount = 0;

  for (const a of actions) {
    switch (a.type) {
      case 'explore': exploreCount++; break;
      case 'escape': escapeCount++; break;
      case 'risk': riskCount++; break;
      case 'social': socialCount++; break;
      // Trust-building / selfless actions feed the Alliance axis
      case 'dialogue': dialogueCount++; break;
      case 'protect': protectCount++; break;
      case 'heal': healCount++; break;
      // Aggressive / manipulative actions feed the Utilitarian axis
      case 'attack': attackCount++; break;
      case 'deceive': deceiveCount++; break;
      // Passive avoidance feeds the Fear axis
      case 'ignore': ignoreCount++; break;
      default: break; // create / custom / other — neutral
    }
  }

  const total = Math.max(1, actions.length);

  const curiosityRaw = (exploreCount * 2 + riskCount) / total;
  const fearRaw = (escapeCount * 2 + ignoreCount) / total;
  const trustRaw = (socialCount * 2 + dialogueCount + protectCount + healCount) / total;
  const pragmatismRaw = (riskCount + escapeCount + attackCount + deceiveCount) / total;

  // Accurately parse textual flags ('low', 'medium', 'high')
  const curiosityFlag = parseFlagLevel(flags.curiosity);
  const fearFlag = parseFlagLevel(flags.fear);
  const trustFlag = parseFlagLevel(flags.trust);
  const guiltFlag = parseFlagLevel(flags.guilt);

  const clamp = (val: number) => Math.round(Math.min(98, Math.max(8, val)));

  const curiosity = clamp((curiosityRaw * 0.6 + curiosityFlag * 0.4) * 100);
  const paranoia = clamp((fearRaw * 0.5 + fearFlag * 0.3 + (1 - trustFlag) * 0.2) * 100);
  const trust = clamp((trustRaw * 0.5 + trustFlag * 0.5) * 100);
  const pragmatism = clamp((pragmatismRaw * 0.5 + (1 - guiltFlag) * 0.5) * 100);

  return { curiosity, paranoia, trust, pragmatism };
}

/**
 * Derives the canonical Archetype based on mathematical vector dominance.
 *
 * @param vectors - 4-axis behavioral vector scores.
 * @param state - Optional story state snapshot.
 * @returns Canonical Archetype key.
 */
export function resolveArchetype(vectors: PsychologicalVectorScores, state?: StoryState): Archetype {
  const { curiosity, paranoia, trust, pragmatism } = vectors;

  // DESIGN NOTE: vector-based classification runs FIRST (not the stored AI
  // archetype) so the badge always agrees with the 4-axis sliders rendered from
  // the same vectors (B4: slider/badge mutual consistency). The stored-profile
  // fallback below is intentionally NOT dead code — it is reached whenever the
  // six rules fail to fire (e.g. balanced mid-range vectors), where it prefers
  // the AI's holistic judgment over a tie-break by vector peak.

  // 1. Dominant Curiosity + High Pragmatism -> Obsessive Investigator
  if (curiosity >= 62 && pragmatism >= 50) return "obsessive_investigator";
  // 2. High Pragmatism + Low/Moderate Trust -> Cold Realist
  if (pragmatism >= 60 && trust <= 45) return "cold_realist";
  // 3. High Trust + Protective tendency -> Selfless Martyr
  if (trust >= 58 && pragmatism <= 55) return "selfless_martyr";
  // 4. High Paranoia + Low Trust -> Hyper-Vigilant
  if (paranoia >= 58 && trust <= 45) return "hyper_vigilant";
  // 5. High Curiosity + Low Paranoia (Risk leaning) -> Reckless Gambler
  if (curiosity >= 55 && paranoia <= 45) return "reckless_gambler";
  // 6. Low Curiosity + Low Paranoia (Grim acceptance) -> The Fatalist
  if (curiosity <= 45 && paranoia <= 50) return "the_fatalist";

  // If state has an explicit stored archetype matching canonical definitions, respect it
  if (state?.psychologicalProfile?.archetype && ARCHETYPE_DEFINITIONS[state.psychologicalProfile.archetype]) {
    return state.psychologicalProfile.archetype;
  }

  // Balanced fallback based on dominant vector peak
  const maxScore = Math.max(curiosity, paranoia, trust, pragmatism);
  if (maxScore === curiosity) return "obsessive_investigator";
  if (maxScore === pragmatism) return "cold_realist";
  if (maxScore === trust) return "selfless_martyr";
  if (maxScore === paranoia) return "hyper_vigilant";

  return "obsessive_investigator";
}

/**
 * Resolves mental stability tier from sanity composure, memory integrity, and trauma tag accumulation.
 *
 * Stability Tiers:
 *  - `unraveling`: Composure <= 15, or legacy unstable, or crashed with >= 4 trauma tags.
 *  - `fractured`: Composure < 45, or legacy cracking, or crashed composure, or >= 3 trauma tags.
 *  - `volatile`: Composure < 75, or >= 1 trauma tags.
 *  - `lucid`: Composure >= 75 with 0 trauma tags.
 *
 * @param state - Story state snapshot.
 * @returns StabilityTier ('lucid' | 'volatile' | 'fractured' | 'unraveling').
 */
export function resolveStabilityTier(state: StoryState): StabilityTier {
  const composure = state.sanityState?.composure ?? 100;
  const hasCrashed = state.sanityState?.hasCrashed ?? false;
  const traumaCount = state.traumaTags?.length ?? 0;
  const legacyStability = state.psychologicalProfile?.stability;

  if (composure <= 15 || legacyStability === 'unstable' || (hasCrashed && traumaCount >= 4)) {
    return 'unraveling';
  }
  if (composure < 45 || legacyStability === 'cracking' || hasCrashed || traumaCount >= 3) {
    return 'fractured';
  }
  if (composure < 75 || traumaCount >= 1) {
    return 'volatile';
  }
  return 'lucid';
}

/**
 * Identifies the critical decision divergence turning point in the reader's action history.
 *
 * @param state - Story state snapshot containing actionsHistory, plotFlags, and places.
 * @returns ProfileDivergencePoint object or null if story was too short.
 */
export function findDivergencePoint(state: StoryState): ProfileDivergencePoint | null {
  const actions = state.actionsHistory || [];
  const plotFlags = state.plotFlags || [];
  const places = state.places;

  // 1. Prefer an explicit major event or turning point plot flag
  const turningFlag = plotFlags.find((f: PlotFlag) => f.type === 'turning_point' || f.isMajorEvent);
  if (turningFlag && turningFlag.page) {
    const actionAtPage = actions.find((a: SelectedAction) => a.page === turningFlag.page);
    return {
      pageNumber: turningFlag.page,
      locationName: resolveLocationName(turningFlag.placeId, places),
      choiceSnippet: actionAtPage?.text || turningFlag.fact || "Critical narrative divergence",
      shiftDescription: `Shifted psychological trajectory permanently on page ${turningFlag.page}.`,
    };
  }

  // 2. Fallback to middle pivotal decision
  if (actions.length > 2) {
    const midIndex = Math.floor(actions.length / 2);
    const criticalAction = actions[midIndex];
    return {
      pageNumber: criticalAction.page || midIndex + 1,
      locationName: "The Critical Crossroads",
      choiceSnippet: criticalAction.text || "Decisive turn in the dark",
      shiftDescription: "Marked the point where your decision pattern locked into its dominant archetype.",
    };
  }

  return null;
}

/**
 * Builds the post-ending psychological evaluation for a completed book/page.
 *
 * ## Design decision: per-ending-branch, not per-reader
 * This profile is deliberately scoped to a single ending branch (the terminal
 * `story_states.pageId` reached), NOT to a specific reader. It aggregates the
 * canonical `actionsHistory` of the story state for that ending, which is what
 * powers the ending rarity and social-share surfaces ("X% of investigators who
 * closed this case reached the same conclusion", OG archetype badge). A reader
 * who is browsing an ending they did not personally achieve still sees the
 * *ending's* psychology rather than their own.
 *
 * Consequence to be aware of: two readers who reach the same ending page will
 * share the same archetype/stability, because both map to the same canonical
 * state row. Per-reader attribution would require keying off
 * `userCompletedBooks` instead — intentionally not done here.
 *
 * @param bookId - Unique book database ID.
 * @param pageId - Target terminal page ID (optional, defaults to latest page).
 * @returns PsychologicalProfilePayload or null if state not found.
 */
export async function getPsychologicalProfileResult(
  bookId: string,
  pageId?: string
): Promise<PsychologicalProfilePayload | null> {
  let rows;
  if (pageId) {
    rows = await dbRead
      .select()
      .from(storyStates)
      .where(and(eq(storyStates.bookId, bookId), eq(storyStates.pageId, pageId)))
      .limit(1);
  } else {
    rows = await dbRead
      .select()
      .from(storyStates)
      .where(eq(storyStates.bookId, bookId))
      .orderBy(desc(storyStates.page))
      .limit(1);
  }

  if (!rows.length) return null;

  const state = rows[0] as unknown as StoryState;
  const vectors = calculatePsychologicalVectors(state);
  const archetypeKey = resolveArchetype(vectors, state);
  const archetypeDef = ARCHETYPE_DEFINITIONS[archetypeKey] || ARCHETYPE_DEFINITIONS.obsessive_investigator;
  const stability = resolveStabilityTier(state);
  const divergencePoint = findDivergencePoint(state);
  const missedTeasers = ARCHETYPE_MISS_MAP[archetypeKey] || [];

  return {
    archetype: archetypeDef.name,
    archetypeKey,
    stability,
    diagnosticSummary: archetypeDef.summary,
    dominantTraits: archetypeDef.traits,
    vectors,
    divergencePoint,
    rarityPercentage: archetypeDef.rarity,
    missedTeasers,
  };
}

/**
 * Computes a reader's lifetime longitudinal Reader Mind Matrix across all completed stories.
 *
 * @param userId - Unique user ID.
 * @returns ReaderMindMatrixResponse['matrix'] object containing dominant archetype, aggregate spectrum, distribution, and stamps.
 */
export async function getUserMindMatrix(userId: string): Promise<ReaderMindMatrixResponse['matrix']> {
  const completions = await dbRead
    .select({
      pageId: userCompletedBooks.pageId,
      bookId: userCompletedBooks.bookId,
    })
    .from(userCompletedBooks)
    .where(eq(userCompletedBooks.userId, userId))
    .orderBy(desc(userCompletedBooks.completedAt));

  if (!completions.length) {
    return {
      dominantLifetimeArchetype: ARCHETYPE_DEFINITIONS.obsessive_investigator.name,
      dominantLifetimeArchetypeKey: "obsessive_investigator",
      totalStoriesAnalyzed: 0,
      aggregateVectors: { curiosity: 50, paranoia: 50, trust: 50, pragmatism: 50 },
      archetypeDistribution: [],
      unlockedStamps: [],
    };
  }

  const pageIds = completions.map((c) => c.pageId);

  // Chunk pageIds if large (safety against SQL parameter limits)
  const chunkSize = 100;
  const states: unknown[] = [];
  for (let i = 0; i < pageIds.length; i += chunkSize) {
    const chunk = pageIds.slice(i, i + chunkSize);
    const chunkStates = await dbRead
      .select()
      .from(storyStates)
      .where(inArray(storyStates.pageId, chunk));
    states.push(...chunkStates);
  }

  // Only states that resolve are analyzable — use `states.length` as the single
  // source of truth so totalStoriesAnalyzed, distribution counts, percentages,
  // and vector averages can never diverge.
  const analyzedCount = states.length;
  if (!analyzedCount) {
    return {
      dominantLifetimeArchetype: ARCHETYPE_DEFINITIONS.obsessive_investigator.name,
      dominantLifetimeArchetypeKey: "obsessive_investigator",
      totalStoriesAnalyzed: 0,
      aggregateVectors: { curiosity: 50, paranoia: 50, trust: 50, pragmatism: 50 },
      archetypeDistribution: [],
      unlockedStamps: [],
    };
  }

  const archetypeCounts: Partial<Record<Archetype, number>> = {};
  const unlockedStampsSet = new Set<Archetype>();
  let totalCuriosity = 0;
  let totalParanoia = 0;
  let totalTrust = 0;
  let totalPragmatism = 0;

  for (const s of states) {
    const stateObj = s as StoryState;
    const vectors = calculatePsychologicalVectors(stateObj);
    const key = resolveArchetype(vectors, stateObj);

    archetypeCounts[key] = (archetypeCounts[key] || 0) + 1;
    totalCuriosity += vectors.curiosity;
    totalParanoia += vectors.paranoia;
    totalTrust += vectors.trust;
    totalPragmatism += vectors.pragmatism;

    unlockedStampsSet.add(key);
  }

  const aggregateVectors: PsychologicalVectorScores = {
    curiosity: Math.round(totalCuriosity / analyzedCount),
    paranoia: Math.round(totalParanoia / analyzedCount),
    trust: Math.round(totalTrust / analyzedCount),
    pragmatism: Math.round(totalPragmatism / analyzedCount),
  };

  // Determine the dominant lifetime archetype
  let dominantKey: Archetype = "obsessive_investigator";
  let maxCount = -1;
  for (const [k, count] of Object.entries(archetypeCounts)) {
    const typedKey = k as Archetype;
    if (count !== undefined && count > maxCount) {
      maxCount = count;
      dominantKey = typedKey;
    }
  }

  // Calculate percentages that sum to 100%
  const distributionEntries = Object.entries(archetypeCounts) as [Archetype, number][];
  distributionEntries.sort((a, b) => b[1] - a[1]);

  let allocatedPercent = 0;
  const distribution: ArchetypeDistributionItem[] = distributionEntries.map(([typedKey, count], idx) => {
    const def = ARCHETYPE_DEFINITIONS[typedKey] || ARCHETYPE_DEFINITIONS.obsessive_investigator;
    let pct = Math.round((count / analyzedCount) * 100);

    // If last entry, adjust to ensure exactly 100% sum
    if (idx === distributionEntries.length - 1) {
      pct = Math.max(0, 100 - allocatedPercent);
    } else {
      allocatedPercent += pct;
    }

    return {
      archetype: def.name,
      archetypeKey: typedKey,
      count,
      percentage: pct,
    };
  });

  const unlockedStamps: UnlockedStampItem[] = Array.from(unlockedStampsSet).map((key) => {
    const def = ARCHETYPE_DEFINITIONS[key] || ARCHETYPE_DEFINITIONS.obsessive_investigator;
    return {
      archetypeKey: key,
      name: def.name,
    };
  });

  const dominantDef = ARCHETYPE_DEFINITIONS[dominantKey] || ARCHETYPE_DEFINITIONS.obsessive_investigator;

  return {
    dominantLifetimeArchetype: dominantDef.name,
    dominantLifetimeArchetypeKey: dominantKey,
    totalStoriesAnalyzed: analyzedCount, // Matches the distribution/count denominator
    aggregateVectors,
    archetypeDistribution: distribution,
    unlockedStamps,
  };
}
