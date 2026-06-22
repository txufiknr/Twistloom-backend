import { eq, desc } from 'drizzle-orm';
import { dbRead } from '../db/client.js';
import { storyStates } from '../db/schema.js';
import { determineOptimalEnding } from '../utils/story.js';
import type { PsychologicalProfileResult, MissedEndingTeaser, Archetype, PsychologicalProfile, EndingType, StoryState } from '../types/story.js';

/**
 * Archetype-to-archetype miss mappings.
 * For each archetype, defines what the player *didn't* become and why,
 * so the teasers feel diagnostic rather than random.
 */
const ARCHETYPE_MISS_MAP: Record<Archetype, Omit<MissedEndingTeaser, 'wouldHaveEnded'>[]> = {
  the_explorer: [
    { archetype: 'the_avoider', trigger: 'fear overtook your curiosity', teaser: 'You never hesitated long enough to let the shadows win.' },
    { archetype: 'the_paranoid', trigger: 'you trusted what you found', teaser: 'Your trust never curdled into suspicion — you never saw how every clue could be a trap.' },
    { archetype: 'the_guilty', trigger: 'you never carried a mistake you couldn\'t forgive', teaser: 'Your choices never came at a cost you couldn\'t shoulder.' },
  ],
  the_avoider: [
    { archetype: 'the_explorer', trigger: 'curiosity never overcame your caution', teaser: 'You never opened the door you were afraid to open — something was waiting behind it.' },
    { archetype: 'the_risk_taker', trigger: 'you always chose safety first', teaser: 'There was a version of you that ran toward the danger instead of away.' },
    { archetype: 'the_denier', trigger: 'you faced reality instead of rationalizing', teaser: 'You never told yourself it wasn\'t real — the truth was always worse.' },
  ],
  the_risk_taker: [
    { archetype: 'the_explorer', trigger: 'you acted before you understood', teaser: 'If you\'d stopped to look instead of charging ahead, you\'d have seen what was really there.' },
    { archetype: 'the_paranoid', trigger: 'you never learned to be afraid', teaser: 'Your boldness never became suspicion — the one person you trusted was waiting to betray you.' },
    { archetype: 'the_guilty', trigger: 'your risks never hurt anyone but yourself', teaser: 'There\'s a world where your bold choice cost someone else everything.' },
  ],
  the_paranoid: [
    { archetype: 'the_explorer', trigger: 'you let fear close your eyes', teaser: 'If you\'d trusted just once, you\'d have uncovered the truth beneath the lies.' },
    { archetype: 'the_denier', trigger: 'your suspicion was always right', teaser: 'You never had to pretend it wasn\'t happening — but what if pretending would have saved you?' },
    { archetype: 'the_avoider', trigger: 'you saw threats everywhere', teaser: 'Not every shadow hides a monster. You never learned the difference.' },
  ],
  the_guilty: [
    { archetype: 'the_explorer', trigger: 'your past weighed more than your curiosity', teaser: 'You were too busy punishing yourself to see what was still worth discovering.' },
    { archetype: 'the_risk_taker', trigger: 'you carried your guilt like a chain', teaser: 'If you\'d forgiven yourself, you might have taken the chance that could have saved you.' },
    { archetype: 'the_avoider', trigger: 'your guilt made you face things head-on', teaser: 'Some people run from their mistakes. You walked right into yours.' },
  ],
  the_denier: [
    { archetype: 'the_paranoid', trigger: 'you refused to see the pattern', teaser: 'The signs were there — you just never let yourself connect them.' },
    { archetype: 'the_avoider', trigger: 'you rationalized instead of retreating', teaser: 'You told yourself it was fine, even as the walls bent around you.' },
    { archetype: 'the_guilty', trigger: 'you never admitted what you did', teaser: 'Somewhere in your denial, you buried a truth that would have broken you anyway.' },
  ],
};

/**
 * Maps each archetype to its "missed" ending if the player had leaned differently.
 */
const ARCHETYPE_MISSED_ENDING: Record<Archetype, EndingType> = {
  the_explorer: 'loop',
  the_avoider: 'possession',
  the_risk_taker: 'pyrrhic_victory',
  the_paranoid: 'identity_twist',
  the_guilty: 'irreversible_loss',
  the_denier: 'false_reality',
};

/**
 * Build the post-ending "psychological autopsy" result for a completed book.
 *
 * Fetches the final page's story state, derives the ending recommendation,
 * and generates teaser data for what the reader *didn't* trigger.
 *
 * @param bookId - The UUID of the completed book
 * @returns The psychological profile result, or null if no story state found
 */
export async function getPsychologicalProfileResult(bookId: string): Promise<PsychologicalProfileResult | null> {
  const rows = await dbRead
    .select()
    .from(storyStates)
    .where(eq(storyStates.bookId, bookId))
    .orderBy(desc(storyStates.page))
    .limit(1);

  if (!rows.length) return null;

  const state = rows[0];
  if (!state.psychologicalProfile) return null;

  const profile: PsychologicalProfile = state.psychologicalProfile as PsychologicalProfile;
  const archetype = profile.archetype;
  const endingRec = determineOptimalEnding(state as unknown as StoryState);

  const missData = ARCHETYPE_MISS_MAP[archetype] || [];

  const teasers: MissedEndingTeaser[] = missData.map((m) => ({
    ...m,
    wouldHaveEnded: ARCHETYPE_MISSED_ENDING[m.archetype] || 'ambiguity',
  }));

  return {
    archetype: profile.archetype,
    stability: profile.stability,
    dominantTraits: profile.dominantTraits,
    manipulationAffinity: profile.manipulationAffinity,
    ending: {
      type: endingRec.type,
      summary: endingRec.summary,
    },
    missedTeasers: teasers,
  };
}
