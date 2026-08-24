/**
 * Field-by-field prose instructions for next-page generation — split out of
 * prompt.ts (checkpoint 6, at the user's request) into its own file for
 * manageability, and made generic (`FieldInstructionSection<T>`) so `fields`
 * is checked against real `keyof T` at compile time instead of being a
 * loose, typo-able `string`.
 *
 * One computed-once array (`buildNextPageFieldInstructionSections`) is the
 * single source every consumer reads from — the legacy combined function
 * and the two split page/delta-only functions below all derive from it
 * rather than each maintaining their own copy, so they can never drift the
 * way the old duplicated-JSON-shape templates once did (see prompt.ts's
 * NEW_CHARACTER_SHAPE-style constants for the prior fix of that same class
 * of bug). See MULTI_TURN_PAGE_GENERATION_ROADMAP.md Part 3 Phase 1 Step 1.2
 * for the multi-turn split this file's `stage`/`isMultiTurn` machinery
 * exists for.
 */

import { characterImportances, characterStatuses, factTypes, sceneRoleValues, canonicalPlaceTypes, accessibilityValues } from "../config/enums.js";
import { ACTION_TEXT_LENGTH, FACT_KEY_FORMAT, KEY_EVENT_LENGTH, MAX_ACTION_CHOICES, MAX_ACTION_CHOICES_FINALE, MAX_CHARACTERS, MAX_FUTURE_NOTES, MAX_INVENTORY_ITEM, MAX_PLACES, MAX_TRAUMA_TAGS, MAX_WORDS_SUMMARIZED_CONTEXT, MIN_ACTION_CHOICES, PLACE_CONTEXT_LENGTH, VIABLE_ENDING_LENGTH } from "../config/story.js";
import { formatOneOf } from "./text-processing.js";
import { getStoryStateInfo } from "./story.js";
import type { StoryState, Action, SceneType, StoryGeneration } from "../types/story.js";

/**
 * One field-instruction section: which multi-turn stage authors it, which
 * real `keyof T` key(s) it documents, and its prose text.
 *
 * `fields` is always an array, even for single-key sections — a few
 * sections (traumaTagAdd/traumaTagRemove, futureNoteAdd/futureNoteRemove,
 * newCharacters/updatedCharacters, newPlaces/updatedPlaces) cover two real
 * schema keys under one prose block, since the AI authors them together;
 * a uniform array avoids a `keyof T | (keyof T)[]` union and the
 * "is this one key or many" ambiguity that comes with it. Every entry's
 * `fields` values are checked against `keyof T` at compile time — a typo'd
 * or renamed field name is now a build error, not a silent documentation
 * drift.
 */
export type FieldInstructionSection<T> = {
  fields: (keyof T)[];
  stage: 'page' | 'delta';
  text: string;
};

function buildNextPageFieldInstructionSections(state: StoryState, action: Action, sceneType: SceneType = 'transition', isMultiTurn: boolean = false): FieldInstructionSection<StoryGeneration>[] {
  const { traumaTags, futureNotes } = state;
  const { isEarlyPhase, isLatePhase, isMidPhase, isFinale, isLastPage, charactersSlot, placesSlot, phase } = getStoryStateInfo(state);
  const isDialogueAction = action.type === 'dialogue';

  return [
  { fields: ['text'], stage: 'page', text: `text
  - Write in the target language's first-person singular. Never refer to the MC as "the protagonist" or "the narrator".
  - Continue seamlessly from the previous page.${sceneType === 'transition' ? '' : ` No time skip. No location jump. No off-screen actions.`}
  - ${isDialogueAction ? `It's a dialogue action, so begin directly with "[dialogue]."` : `Begin immediately with the chosen action — lead with the target language's action phrase or any necessary causal steps.`}
  - Open mid-moment, but maintain causal continuity. Avoid recap or unnecessary setup.
  - Open from the physical state the previous page ended on (where the MC is, how their body is positioned). If that baseline isn't unambiguous, establish it in the first line.
  - Track the MC's body continuously: posture and orientation never change without a written physical transition. No off-screen repositioning.
  - Keep the camera welded to the MC: show only what they can see/hear/infer. Anchor every pronoun to one clear antecedent; name the owner before a body part acts.
  - This is a fast-paced story, don't over explain small details (e.g. clothing, accessories) unless they're plot important.
${isEarlyPhase ? `  - Tone: unsettling, not terrifying. Something is wrong — but not yet catastrophic.` : ''}
${isMidPhase ? `  - Tone: escalating. Dread should feel earned and personal by now.` : ''}
${isLatePhase ? `  - Tone: fracturing. Reality and relationships should feel increasingly unstable.` : ''}
${isFinale ? `  - Tone: collapse. This is the point of no return. Write accordingly.` : ''}` },
  { fields: ['mood'], stage: 'page', text: `mood
  - Reflect the dominant emotional atmosphere of this specific page, not the genre generally.
${isFinale ? `  - Mood should feel terminal — no neutrality, no ambiguity in register.` : ''}` },
  { fields: ['placeId'], stage: 'page', text: `placeId
  - Use same place ID if the MC hasn't moved.
  - Use "unknown" only if location is genuinely ambiguous to the MC.
${isMultiTurn ? `  - If the MC has moved somewhere genuinely new, invent a short unique lowercase-slug ID for it now (e.g. "flooded-basement-stairwell") and use it consistently — a later stage formally introduces it in newPlaces using this EXACT ID.` : ''}
${isLatePhase || isFinale ? `  - Familiar places should feel subtly wrong now — same name, different atmosphere.` : ''}` },
  { fields: ['weather'], stage: 'page', text: `weather
  - Keep consistent with recent pages unless enough time has passed or the scene has moved somewhere conditions would plausibly differ.
  - Omit if not narratively relevant to this page.
${isLatePhase || isFinale ? `  - A sudden shift can heighten dread — but don't reuse it as a cheap scare every page.` : ''}` },
  { fields: ['calendarDate'], stage: 'page', text: `calendarDate:
  - Increment if the day has changed.
  - Use 'yyyy-MM-dd' format (e.g., "2026-07-26").` },
  { fields: ['timeOfDay'], stage: 'page', text: `timeOfDay
  - Any string: "2 AM", "dusk", "HH:mm", time range, or "unknown".
  - Must be consistent with previous page unless a transition is written into the text.` },
  { fields: ['minutesPassed'], stage: 'delta', text: `minutesPassed
  - Realistic in-world minutes that pass during this page's events.
  - Omit if the exact duration is ambiguous or unimportant (system will estimate from scene type).
  - Use precise values when time is narratively significant (e.g., a 3-minute countdown, 45-minute interrogation).
  - Values under 1 can indicate seconds (0.5 ≈ 30 seconds). Values over 120 imply multiple hours.` },
  { fields: ['sceneType'], stage: 'page', text: `sceneType
  - Select the single dominant narrative function of the page.
  - Analyze user's selected action to either maintain previous scene type or transition to a new, logical scene type.
  - Choose the scene type that best represents the page's primary narrative purpose, not merely its setting, mood, or individual actions.
  - If multiple scene types apply, choose the most important narrative function.
  - Use "transition" only when no stronger narrative function dominates the page.` },
  { fields: ['charactersPresent'], stage: 'page', text: `charactersPresent
  - Side characters physically present in the scene besides MC.
  - Only side characters, exclude MC. MC is central POV and always on the scene.
  - Do not include characters who are only mentioned, remembered, referenced, contacted remotely, or discussed.
  - Every ID must match an existing known character${isFinale ? `.
  - Keep the cast minimal. Finale scenes should feel claustrophobic, not populated.`
: isMultiTurn ? ` or, if this is a brand-new character appearing for the first time, a short unique lowercase-slug ID you invent now (based on their role or a distinguishing trait, e.g. "hollow-eyed-clerk") — use it consistently. A later stage introduces them formally in newCharacters using this EXACT ID, so do not reuse an ID already on the known-characters list.`
: ` or a character introduced in newCharacters on this page.`}
  - sceneRole: ${sceneRoleValues}
  - sceneFocus: between 0.0 to 1.0. Relative narrative importance in the current scene (highest = character to focus).` },
  { fields: ['keyEvents'], stage: 'page', text: `keyEvents
  - ${KEY_EVENT_LENGTH}. Plot-level facts only — what objectively happened (situation/exact hard facts).
${isLatePhase || isFinale ? `  - At least one event should connect to or resolve a thread opened earlier in the story.` : ''}` },
  { fields: ['keyObjects'], stage: 'page', text: `keyObjects
  - Objects introduced or used this page that may have future narrative significance.
${isEarlyPhase ? `  - Seed freely — early objects pay off later. Introduce them without drawing attention.` : ''}
${isMidPhase ? `  - Only include objects with clear narrative weight. No new red herrings.` : ''}
${isLatePhase || isFinale ? `  - Reuse established objects only. No new ones unless absolutely necessary.` : ''}` },
  { fields: ['inventory'], stage: 'delta', text: `inventory
  - Items currently in MC's possession. Can include the amount, traits, and where it currently located.
  - Max ${MAX_INVENTORY_ITEM} different items. Only include that actually matters to the plot.
  - To remove an item, explicitly set its amount to 0 (system will auto-remove).
  - If no changes, output empty array or omit this field entirely.
  - Otherwise, MUST include all current items with updated values and/or new item if any.` },
  { fields: ['injuries'], stage: 'delta', text: `injuries
  - Injuries are auto-decaying, ONLY update when character takes action that treats/worsens injury.
  - If an action is taken to heal, or anything made injury worse, update the injury severity and description accordingly.
  - If healed, set severity to 0 (system will auto-remove fully healed injuries).
  - If healed but leaves permanent scar/story relevance, move to character's appearance.
  - If no meaningful injury-related action occurs, output empty array or omit this field entirely.
  - Otherwise, MUST include all previous injuries with updated values and/or new injury if any.
  - consequences: update any that affect the storyline (e.g. "Can't run fast, can't lift heavy objects").` },
  { fields: ['traumaTagAdd', 'traumaTagRemove'], stage: 'delta', text: `traumaTagAdd / traumaTagRemove
  - Short evocative phrases for experiences that will haunt the MC later.
${traumaTags.length < MAX_TRAUMA_TAGS ? `  - Only add if something genuinely traumatic or psychologically significant occurs.` : `  - Maximum trauma tags reached. Can't add more.`}
  - Remove when trauma is resolved.
${isEarlyPhase ? `  - Max 1 per page. Plant sparingly — early trauma tags shape everything downstream.` : `  - Max 2 per page. Omit if none.`}
${isFinale ? `  - Existing trauma tags should be echoing and surfacing now, not new ones being added.` : ''}` },
  { fields: ['futureNoteAdd', 'futureNoteRemove'], stage: 'delta', text: `futureNoteAdd / futureNoteRemove
${futureNotes.length < MAX_FUTURE_NOTES ? `  - ONLY add for important unresolved clues, revelations, promises, relationships, mysteries, or future developments which matter later.
  - Do NOT add for temporary details, completed events, or facts already captured by plot flags.
  - Prefer advancing existing future notes before creating new ones. Avoid duplicate or overlapping future notes.` : ''}
  - Future notes represent narrative obligations, not immediate requirements. Do not resolve a future note merely because it exists.
  - Remove notes which have been fulfilled or become irrelevant.
  - If fulfilling a future note materially changes the story, record the outcome as a plot flag.
  - Keep max ${MAX_FUTURE_NOTES} items. Only the most important unresolved future notes.` },
  { fields: ['addPlannedCharacters'], stage: 'delta', text: `addPlannedCharacters
${!isLatePhase && charactersSlot > 0 ? `  - Add new planned character candidates for future introduction when the story needs fresh faces for upcoming beats.
  - This is for characters not yet on-page — they're seeds for future pages. Use newCharacters instead if the new character is physically present on this page.
  - Each must have a distinct characterId. Avoid generic or throwaway plans.
  - storyPurpose: why this character exists and what role they'll play.
  - plannedIntro: brief hook describing how/when they might first appear.`
: `  - Do not add new planned characters. ${isLatePhase ? 'Phase is too late for meaningful future introductions.' : `${MAX_CHARACTERS} characters limit reached.`}`}` },
  { fields: ['factUpdates'], stage: 'delta', text: `factUpdates
  - Represents long-term story memory, discoveries, or important established facts that influence future turns.
  - key: consistent ${FACT_KEY_FORMAT}. Type can be either: ${formatOneOf(Object.keys(factTypes))}.
  - value: latest known state. Prefer concise value over long sentence (explanation can be added in reason).
  - reason: 1-sentence, why or how it hapenned or changed.
  - Facts should be objectively true within the story after this page ends.
  - Do NOT record every event that happened on the page.
  - Don't duplicate: reuse existing keys whenever updating the same fact (only meaningful change).
  - ONLY include facts that meet at least one of these criteria (if unsure, omit it):
    → Permanently change the story world.
    → Reveal important information to remember 20+ pages later.
    → Change a character's status, goal, relationship, possession, or knowledge.
    → Establish a mystery clue, suspect, or revelation.` },
  { fields: ['addPlotFlags'], stage: 'delta', text: `addPlotFlags
  - Add ONLY for crucial story developments that impact narrative trajectory and become established canon (max 2 per page).
  - Do NOT add for temporary actions, routine events, minor clues, short-lived details, or if no lasting story state changed.
  - Use for major revelations, death, betrayal, irreversible decisions, or major shifts in story direction.
  - fact: describe the newly established story fact clearly and specifically (subject + verb + object).
  - isMajorEvent: true only for irreversible events or major turning points with lasting consequences.
  - Major-event pacing:
    → Review recent major events before introducing a new major event.
    → If multiple major events occurred recently, prefer fallout, consequences, investigation, tension, or character reactions before introducing another major event.
    → Do NOT create major events solely to escalate the plot.
  - Expected distribution:
    → Most pages: 0-1 plot flags.
    → Major turning points: up to 2 plot flags.` },
  { fields: ['contextHistory'], stage: 'delta', text: `contextHistory
  - Running summary from page 1 until now — key plot developments, hard facts, major events.
  - Incorporate the overall story context while keeping all essential narrative elements.
  - Single paragraph or bullet points (max ${MAX_WORDS_SUMMARIZED_CONTEXT} words).
  - Write in 3rd person POV.
  - Maintain the continuity of the story.` },
  { fields: ['flagUpdates'], stage: 'delta', text: `flagUpdates
  - Only include flags that changed this page. Omit unchanged flags entirely.
  - Base changes on what actually happened in the scene.
${isEarlyPhase ? `  - Changes should be subtle — small shifts, not dramatic swings.` : ''}
${isLatePhase || isFinale ? `  - Flags should reflect escalation. Fear and guilt especially should be peaking.` : ''}` },
  { fields: ['actions'], stage: 'page', text: `actions
${isLastPage ? `  - This is the last page, just provide a single action that concludes the story.` : `  - text: first-person action or dialogue (${ACTION_TEXT_LENGTH}). No explicit subject pronoun — lead directly with the target language's verb form or a short saying (e.g. Pretend not to hear, "Yes, of course.").
  - hint.text: what will happen as a consequence — written as a story beat, not a label. Invisible to the player.
  - ${isFinale ? `Max ${MAX_ACTION_CHOICES_FINALE} choices — the story is closing in.` : `${MIN_ACTION_CHOICES}-${MAX_ACTION_CHOICES} choices.`} Each must be meaningfully distinct.
  - Vary across: reckless / cautious / emotional / avoidant.
  - ${isLatePhase ? `Each action text should be distinct despite similar outcomes` : `Each action text should be distinct and convey unique consequences.`}
  - At least one should feel subtly wrong or inadvisable.
${isEarlyPhase ? `  - Choices should feel open and curious — stakes are present but not yet dire.` : ''}
${isMidPhase ? `  - Choices should reflect the player's established decision patterns. Make the trap feel tailored.` : ''}
${isLatePhase ? `  - Every choice should carry visible weight. No option should feel consequence-free.` : ''}
${isFinale ? `  - Both choices should feel like loss. The difference is only in what kind.` : ''}`}` },
  { fields: ['branchNames'], stage: 'delta', text: `branchNames
  - Suggest 3 creative, distinct names for this page as a timeline/branch — evocative, spoiler-free (e.g., "The Locked Door", "Trust No One").
  - Always suggest regardless of whether this page's actions actually fork the story — the system decides whether a name is used.` },
  { fields: ['newCharacters', 'updatedCharacters'], stage: 'delta', text: `newCharacters/updatedCharacters
${isMultiTurn ? `  - The GENERATED PAGE's charactersPresent may reference an ID not in KNOWN CHARACTERS — that means the page turn invented a slug ID for a brand-new character. You MUST add a newCharacters entry using that EXACT ID (do not invent a different one, do not rename it).` : ''}
${charactersSlot === 0 ? `  - Can't introduce new characters (${MAX_CHARACTERS} limit). Update existing ones only.`
: isEarlyPhase ? `  - New characters welcome up to ${charactersSlot} more — establish the cast now.`
: isMidPhase ? `  - Optionally introduce up to ${charactersSlot} new characters only if genuinely necessary. Prefer deepening existing ones.`
: `  - No new characters. Cast is fixed. Late arrivals dilute stakes.`}
${isLatePhase || isFinale
? `  - Expect significant status/flag changes now. Characters should be fracturing or revealing.`
: `  - Only update characters whose state actually changed this page.`}
  - For new characters: incorporate appearance naturally in storytelling.
  - For updates: only include changed fields, omit unaltered ones.
  - knownName: mandatory narration alias. Gradually update as MC learns real identity.
  - bio: concise, suggestive. Gradually update when new info revealed.
  - appearance: visual description. Only update if meaningfully changed (e.g., permanent injury).
  - recognitionLevel: how well MC recognizes this character.
  - status: ${formatOneOf(characterStatuses)}
  - importance: ${formatOneOf(characterImportances)}
  - relationshipToMC: based on interaction and story progression.
  - potentialTwist: adjust to reflect plot developments.
  - secrets: spoiler/hints (new) or remove revealed ones (update).
  - traits: only story-relevant. Remove or update.
  - injuries: add or update. Set severity to zero to remove.
  - pastInteractions (new): dialogue or event towards MC in current page.
  - newInteractions (update): interactions since last page.
  - relationships (new only): include known relationships to other named characters. Omit if none.` },
  { fields: ['relationshipUpdates'], stage: 'delta', text: `relationshipUpdates
  - Changes in relationship between any two named characters (excluding MC).
  - Omit if no relationships shifted this page.
${isEarlyPhase ? `  - Subtle shifts only — early relationships should feel ambiguous, not defined.` : ''}
${isLatePhase || isFinale ? `  - Relationships should be breaking, inverting, or crystallizing. No more ambiguity.` : ''}` },
  { fields: ['newPlaces', 'updatedPlaces'], stage: 'delta', text: `newPlaces/updatedPlaces
${isMultiTurn ? `  - The GENERATED PAGE's placeId may be an ID not in KNOWN PLACES — that means the page turn invented a slug ID for a brand-new place. You MUST add a newPlaces entry using that EXACT ID (do not invent a different one, do not rename it).` : ''}
${placesSlot === 0 ? `  - Can't introduce new places (${MAX_PLACES} limit). Update existing ones only.`
: isEarlyPhase || isMidPhase ? `  - You can introduce up to ${placesSlot} new meaningful places the MC enters for the first time — no generic one-offs.
  - knownName: should fit in-world cultural setting.
  - context: ${PLACE_CONTEXT_LENGTH}. Evocative over descriptive.
  - hints: known clues, obstacles, spatial relationships. Must be consistent to build a "world map."
  - category: Choose the closest match: ${formatOneOf(canonicalPlaceTypes)}.
  - familiarity: start at 0.0-0.2 unless MC has prior history.
  - traits: include relevant info (e.g., smell, sound, visual, feeling).
  - knownCharacters: include relevant characters (beside MC) with meaningful context.
  - keyEvents: any important event happening in the scene.
  - keyObjects: any important objects to remember.
  - Might need to update other places' hints to link with this new place.`
: `  - No new places. If MC is somewhere new, question whether it's necessary.`}
  - For updates: only on revisit or significant event. Include only changed fields.
  - familiarityCorrection: always 0 except on major condition:
    → place changes drastically, or fundamentally changes how MC understands it.
    → learns hidden functions/secrets, discovers new areas, gains deeper understanding.
    → memory loss/confusion, familiar assumptions proven false, environment unrecognizable.
    → Do NOT use for ordinary visits, repeated exposure, or gradual learning (handled automatically).
${isLatePhase || isFinale ? `  - High-familiarity places revisited now should feel distorted.` : ''}` },
  { fields: ['placeConnections'], stage: 'delta', text: `placeConnections
  - Add new if visiting/adding a new place or when a place is first connected.
  - Only update existing if route conditions meaningfully change on revisit.
  - travelTime: travel duration (e.g., "5 minutes walk", "20 minutes drive").
  - routeType: route description (e.g., "main street", "alley", "tunnel").
  - accessibility: ${accessibilityValues}.
  - addObstacles/removeObstacles: story-relevant barriers, hazards, or access requirements.
  - notes: short route details not covered elsewhere.` },
  { fields: ['newThreads'], stage: 'delta', text: `${!isFinale ? `newThreads (see ACTIVE THREADS for whether a new thread is warranted this page)
  - title: Short, evocative name for the mystery (e.g., "Lisa's Identity", "The River Incident")
  - question: central mystery question (e.g., "Who is Lisa really?", "What happened at the river that night?")
  - priority: "main" for central mysteries, "secondary" for supporting mysteries, "minor" for background details
  - truth: "true" if the thread leads to genuine revelation, "false" if it's a deliberate misdirection, "unknown" if ambiguous
  - importance: 0.0-1.0 (how frequently this thread should appear in the narrative)` : ''}` },
  { fields: ['updateThreads'], stage: 'delta', text: `updateThreads
  - Update existing threads when their status, priority, or urgency meaningfully changes.
  - threadId: must match an existing thread ID.
  - status: ${isLatePhase ? 'update to "revealed" or "closed" as threads converge toward the ending.' : '"open" (newly introduced), "developing" (active investigation), "revealed" (truth partially shown), "closed" (resolved).'}
  - urgencyCorrection: explicit closeness adjustment to a reveal/twist/resolution (e.g., +0.20 = major breakthrough, -0.15 = mystery became more complicated). Do not use for normal progression, new clues, or routine thread development. The system already handles those automatically.
  - summary: running summary of thread development (from the start to current).
  - resolution: only include when thread is being closed or resolved (brief summary of the answer).
  - If this page develops, complicates, advances, or revisits an active thread, include a summary update for that thread.
${isFinale ? `  - Every main thread must be resolved (status: "closed" with resolution text).` : ''}` },
  { fields: ['addClues'], stage: 'delta', text: `addClues
${isEarlyPhase || isMidPhase ? `  - Add clues to existing threads to advance mysteries.
  - threadId: must match an existing thread ID.
  - clue: short, evocative clue that advances the mystery (e.g., "She knows my mother", "Flashbacks of water").
  - isFalse: set to true if this is a deliberate misdirection (false clue).` : ''}
${isLatePhase ? `  - Add revealing clues that push threads toward resolution.` : ''}
${isFinale ? `  - Add final clues that complete thread resolutions.` : ''}` },
  { fields: ['closeThreads'], stage: 'delta', text: `${isLatePhase ? 'closeThreads' : ''}
${isLatePhase ? `  - Close threads that have been fully resolved or are no longer relevant.
  - Include thread IDs that should be marked as closed (resolution should be in updateThreads.resolution)` : ''}
${isFinale ? `  - All remaining threads must be closed in the finale.` : ''}` },
  { fields: ['viableEnding'], stage: 'delta', text: `viableEnding
  - Don't output viableEnding if unchanged
  - Only output if story trajectory has meaningfully shifted and the previously planned ending no longer fits, or if outline should be updated.
${futureNotes.length ? `  - Ensure it supports or aligns with future notes` : ''}
  - text: Summary of the desired doom (${VIABLE_ENDING_LENGTH}). Specific to this MC and theme — not a genre template.
  - outline: A roadmap to reach the ending. 1-2 sentence per item. Align done count with current ${phase} phase. Don't change what have been done, only adjust what haven't done.
${isEarlyPhase ? `  - Rarely needed this early. Only revise if the theme has fundamentally diverged from the original plan.` : ''}
${isMidPhase ? `  - Revise if a major twist has made the original ending implausible or redundant.` : ''}
${isLatePhase ? `  - Should be stable now. Revise only if a late revelation makes the ending genuinely unreachable.` : ''}
${isFinale ? `  - Do not revise. The ending is now in motion — execute it.` : ''}` },
  ];
}

/**
 * Legacy single-shot field instructions (unchanged output) — every section
 * from buildNextPageFieldInstructionSections, joined in original order. Used
 * by the pre-multi-turn generateNextPage(s) path (USE_MULTI_TURN_GENERATION
 * off) and by buildNextPageEvaluatorPrompt's legacy evaluator. Always calls
 * with isMultiTurn=false (the default), so this is byte-identical to the
 * pre-split function — verified via automated diff during authoring.
 */
export function buildNextPageFieldInstructions(state: StoryState, action: Action, sceneType: SceneType = 'transition'): string {
  return buildNextPageFieldInstructionSections(state, action, sceneType).map(s => s.text).join('\n\n');
}

/**
 * Turn A (StoryPage) field instructions — MULTI_TURN_PAGE_GENERATION_ROADMAP.md
 * Part 3 Phase 1 Step 1.2. Only the sections for StoryPageGeneration's 11
 * fields (text, mood, placeId, weather, calendarDate, timeOfDay, sceneType,
 * charactersPresent, keyEvents, keyObjects, actions) — the exact same prose
 * buildNextPageFieldInstructions uses for these fields today, just narrowed
 * to what Turn A actually authors. Passes isMultiTurn=true so charactersPresent
 * and placeId get the slug-ID handoff instruction (see the ID-handoff note in
 * Part 5 of the roadmap) that a same-response legacy call never needs.
 */
export function buildStoryPageFieldInstructions(state: StoryState, action: Action, sceneType: SceneType = 'transition'): string {
  return buildNextPageFieldInstructionSections(state, action, sceneType, true)
    .filter(s => s.stage === 'page')
    .map(s => s.text)
    .join('\n\n');
}

/**
 * Turn B (StateDelta) field instructions — MULTI_TURN_PAGE_GENERATION_ROADMAP.md
 * Part 3 Phase 1 Step 1.2. Every section NOT claimed by Turn A above,
 * including `branchNames` (moved here — see StateDeltaGenerationWithBranch
 * doc in types/story.ts for why) and `minutesPassed` (a StateDeltaGeneration
 * field even though it reads like scene metadata). Passes isMultiTurn=true so
 * newCharacters/newPlaces get the matching slug-ID handoff instruction.
 */
export function buildStateDeltaFieldInstructions(state: StoryState, action: Action, sceneType: SceneType = 'transition'): string {
  return buildNextPageFieldInstructionSections(state, action, sceneType, true)
    .filter(s => s.stage === 'delta')
    .map(s => s.text)
    .join('\n\n');
}

