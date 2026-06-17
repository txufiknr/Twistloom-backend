[ ] Page 1 selected actions masih none
[ ] Stripe switch to live
[ ] Implement belief
[ ] Implement corruption curve
[ ] Kalau real take action request & source action belum ada, page ga boleh dilihat
[ ] create paid book (vip with 500 followers, 30 days-old account, email verified, has published 50 books) -> pay as much as the book price -> book promoted
[ ] POST /user/comments - deprecated
[ ] isGeneratingStartedAt -> lastGenerationHeartbeatAt (no heartbeat for X minutes)
[ ] write CLAUDE.md based on README.md & AGENTS.md
[ ] Routine retry cron buat sequential aja (github action strategy)
[ ] story state: elapsedDays
[ ] story delta: elapsedDays (replace), mcAgeDelta (increment)
[ ] more LLM SDK: OpenRouter, Cloudflare Workers AI, Hugging Face Serverless Inference API, Together AI
[ ] consider threadId (instead of by name)
[x] place `locationHints` jadiin array of string aja
[x] place `knownCharacters` jadiin array of object aja
[x] place & inventory `traits` jadiin array of object { "trait": "...", "value": "..." }
[x] place update add: `removeTraits`
[x] place update remove: `visitCount`, `familiarity` & `lastVisitedAtPage`
[x] place calculate `familiarity` using `calculatePlaceFamiliarity`
[x] place calculate `lastVisitedAtPage`, `visitCount` (compare with previous page's place)
[x] update place by placeId
[x] update character by characterId
[x] Consider place & character key (generate like future note key)
[x] replace all "real full name" -> character_id
[x] Previous pages → Plot flags: kosong
[x] charactersPresent jadiin pake id aja
[x] Slugify character name nama tengah & belakang 1 huruf aja
[x] Initialize book firstPage gausah chatactersPresent
[x] Initialize book chatactersPresent infer dari initialCharacters
[x] scene harusnya pake placeId
[x] page table place harusnya placeId
[x] pageTranslations table take out `place`
[x] firstpage & nextpage place harusnya placeId
[x] add thread urgency decay
[x] place prompt tambah actual name, isRealNameKnown (known name jadi primary)
[x] implement openrouter & cloudflare
[x] Future notes key `generateUniqueId` vs `ensureUniqueId` (buat DRY)
[x] thread_id langsung generate AI aja (karena masuk ke future note `relatedThreadId`)
[x] env api keys openrouter & cloudflare -> also add on github & vercel
[x] charactersPresent jadiin SceneCharacter[]
[x] charactersPresent adain lagi di initial story page generation
[x] restore rules charactersPresent match with initialCharacters
[ ] translate story state (places {name}, inventory {name, where}, actionsHistory {text}, contextHistory)
[ ] db reset & pnpm check

[ ] Does very verbose and lengthy system prompt really necessary, worth, and benefits?

https://www.tokengratis.id/

---

utils/prompt.ts: formatActiveThreads, getThreadState
utils/story.ts: processThreadUpdates
types/story-thread.ts

I want to enhance my story thread system for reader experience, while also keeping it not too complex for AI
here's suggestions from ChatGPT (uploaded)
what's your proposal?

---

Recent Momentum Trend (from previous 5 pages):
Building (page 4-5) → Rising (page 6-7) → Critical (page 8)

Sesuaiin sama real values aja:
Example: High curiosity leads to discovering uncomfortable truths
  - Profile archetype: "the_explorer"
  - Curiosity flag: "high"
  - Recommended ending type: "false_reality"

---

please thoroughly examine my functions to heuristically propose ending archetype recommendation
can you:
- review and tell me if you have any concern or suggestions
- make it also return like verdict or summary for the recommendation

so the desired return shape is more or less like below (if possible):
{
  recommendation: "false_reality" // EndingType
  summary: "High curiosity leads to discovering uncomfortable truths",
  // Optionally:
  because: {
    archetype: "the_explorer",
    curiosity: "high",
    stability: "cracking"
  },
  ...etc
}

I attached my `types/story.ts` for complete type definitions

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

  // Highest priority: respect an active ending plan
  if (hiddenState.endingPlan?.armed) {
    // Map execution type to narrative ending type
    switch (hiddenState.endingPlan.type) {
      case "fake_relief_twist": return hiddenState.endingPlan.fakeToReal
        ? (state.viableEnding?.type ?? "fake_escape")  // rug-pull: deliver the real ending
        : "fake_escape";                                // build-up: steer toward false safety
      case "loop_trap":        return "loop";
      case "identity_reveal":  return "identity_twist";
    }
  }

  // Second priority: profile shift mutation
  if (hiddenState.profileShift?.detected) {
    const shiftedEnding = getShiftedEnding(state);
    if (shiftedEnding) {
      console.log(`[determineOptimalEnding] 🔄 Profile shift detected, using shifted ending: ${shiftedEnding}`);
      return shiftedEnding;
    }
  }

  // Base archetype logic
  switch (archetype) {
    case "the_explorer":   return flags.curiosity === "high" ? "false_reality" : "fake_escape";
    case "the_avoider":    return "irreversible_loss";
    case "the_risk_taker": return flags.fear === "low" ? "fake_escape" : "irreversible_loss";
    case "the_paranoid":   return stability === "unstable" ? "loop" : "false_reality";
    case "the_guilty":     return "irreversible_loss";
    case "the_denier":     return stability === "unstable" ? "mental_fabrication" : "identity_twist";
    default:               return state.viableEnding?.type ?? "ambiguity";
  }
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
  const { hiddenState, viableEnding } = state;
  const { profileShift } = hiddenState;

  if (!profileShift?.detected) return viableEnding?.type;

  switch (profileShift.shiftType) {
    // "You stopped asking questions... but something kept answering anyway"
    case "curiosity_collapse":      return "mental_fabrication";
    // "It didn't chase you because you were slow — it chased you because you understood"
    case "fear_spike":              return "loop";
    // "You weren't trying to survive anymore. You were trying to win."
    case "aggression_turn":         return "identity_twist";
    // "The explorer became the trapped"
    case "archetype_collapse":      return "possession";
    // "When reality shattered, you found the truth in the pieces"
    case "reality_breakdown":       return "false_reality";
    // "You finally stopped fighting... and accepted the lie as truth"
    case "manipulation_acceptance": return "mental_fabrication";
    // "The curious became fearful — the perfect victim"
    case "trait_inversion":         return "loop";
    // "Fear turned to rage, and rage opened the wrong door"
    case "fear_to_aggression":      return "possession";

    // Previously missing — now handled:
    // "You started lying and couldn't stop — even to yourself"
    case "deception_onset":         return "identity_twist";
    // "You pushed everyone away. No one was left to hear you scream."
    case "social_withdrawal":       return "irreversible_loss";
    // "The protector became the thing everyone needed protecting from"
    case "protective_to_aggressive": return "possession";
    // "You built something beautiful. Then you burned it."
    case "creative_to_destructive": return "irreversible_loss";

    // Handled here but currently never detected — keep them for when
    // detectProfileShift gains those detection paths:
    case "denial_break":            return "false_reality";
    case "trust_betrayal":          return "fake_escape";

    default: return viableEnding?.type;
  }
}

---

[ ] const validated = ajv.validate(schema, aiResponse);
https://www.npmjs.com/package/ajv

---

[ ] validate AI json integrity:

import { z } from "zod";

const UserSchema = z.object({
  user_age: z.number().int().min(18).max(99),
  username: z.string().min(3).max(15)
});

// After calling your LLM API (Groq, Cerebras, etc.)
try {
  const rawJson = JSON.parse(apiResponse.choices[0].message.content);
  const validatedData = UserSchema.parse(rawJson); // Throws if constraints fail
  console.log("Safe and validated data:", validatedData);
} catch (error) {
  console.error("LLM failed constraint validation. Retry or fallback needed.", error);
}

---

[ ] Consider generate multiverse in parallel instead of 1 big request
[ ] Provider Abstraction Layer:
interface AIProvider {
  generate(request: AIRequest): Promise<AIResponse>;
  stream(request: AIRequest): AsyncIterable<string>;
}

[ ] updateBookGenerationStatus -> update bookGenerations aiProvider & aiModel
[ ] ai-chat add metrics: requestStart, firstTokenReceived, generationFinished (TTFT: 1.3s, Generation: 5.8s, Total: 7.1s)


unstable
→ narration may contain paranoia
→ ambiguous events interpreted negatively
→ increased self-doubt
→ unreliable perception

The protagonist is psychologically unstable.
Interpret ambiguous situations in a threatening way.
Increase paranoia and uncertainty.

[ ] pass title idea ke initallze book & github workflow dynamic job title
[ ] Generate originals tambah custom input book title & mc name
[ ] Paid book: VIP 500+ followers, must be > 30 days old account, Verified email required
[ ] Sale credits: 10% fee, cuma bisa dicairkan integer ke credits

[ ] userSettings schema
- interests: string[]
- email notification settings

[ ] enhance book explore:
- fuzzy search/Levenshtein (typo tolerant) // does postgresql has this built-in?
- search jaccard similarity (by book keywords & title)
- need change to cursor pagination?

[ensureCandidatesForPageWithStrategy] ⚠️ All actions are invalid, replaced with 1 continue action.
https://github.com/txufiknr/Twistloom-backend/actions/runs/26221075235/job/77155911594

future:
[ ] initialize book: auto-generate MC picture (AI-generated image)

paid infra:
[ ] beli domain twistloom.com -> buat email dev@twistloom.com
[ ] migrate semua akun AI pake email dev@twistloom.com -> replace all API keys
[ ] purchase premium AI chat API keys
[ ] migrate: GitHub models 8K context -> Official OpenAI 128K context
[ ] migrate: LRU & in-memory cache (for static configurations or public API metadata) -> Vercel KV or Upstash Redis for true, shared cross-user in-memory storage.
[ ] migrate: serverless environment -> single, always-on server Vercel VPS alternative (like Render, Railway, or Fly.io) if you want a true, traditional single-instance server.
[ ] unlock 1,000 RPD OpenRouter: requires a one-time $10 credit top-up

by book creator:
[ ] soundtrack based on mood
[ ] add character image
[ ] add page image
[ ] add voice or use noiz tts api

paid:
[ ] custom action prompt (max 50 chars, prevent sql inject, etc)
[x] re-select other action in previous page
[ ] generate cover image with AI (puter)
[ ] generate page image with AI (puter)
[ ] see hint for an action
[ ] use noiz tts api

Story meta:
visualStyle = "dark cinematic, moody lighting, realistic horror, muted tones"
corruptionCurve: number[]
Hints/secret dark facts (don't reveal, it may or never known by MC)

Starting a sentence with a coordinating conjunction (such as or, and, or but) is a stylistic choice rather than a grammatical error. 

Conditional prompt
Boost image importance score when new place is discovered.

Output:
Image prompt
Image importance score

At initialize book:
- Fully connected graph (places connection, characters connection, place-character connection)

---

I'd like to see your designs proposal for:

Branch locking system (prevents illegal jumps)
“Golden path” vs “corrupted path” tracking
Replay system with alternate timeline comparison

---

PROMPT:
You are an award-winning literary author.
You are an award-winning literary novelist.
You are an avant-garde fiction writer.

Focus on the visual textures and psychological weight of the environment.
Focus deeply on subtext, sensory details, environmental atmosphere, psychological depth, and complex human contradictions.
Never use predictable AI framing phrases.

---

Story Phase: Early

Narrative Objectives:
- Establish atmosphere and tone.
- Create curiosity rather than answers.
- Introduce subtle inconsistencies and unanswered questions.
- Favor implication over explanation.
- Build attachment to characters and locations.
- Avoid major revelations.

Mystery Guidelines:
- Readers should notice strange details.
- Readers should not yet understand their significance.

---

Story Phase: Mid

Narrative Objectives:
- Escalate tension and uncertainty.
- Increase consequences of player choices.
- Introduce contradictions and conflicting interpretations.
- Reveal partial truths while creating deeper questions.
- Strengthen relationships, suspicions, and conflicts.

Mystery Guidelines:
- Answers should generate new questions.
- Existing mysteries should evolve rather than stagnate.

---

Story Phase: Finale

Writing Guidance:
- Prioritize resolution over setup.
- Prefer established plot threads.
- Avoid introducing major new mysteries.
- Connect current events to previous clues.
- Focus on consequences and emotional payoff.

Writing Goals:
- Deliver emotional payoff.
- Resolve major mysteries when appropriate.
- Intensify dramatic tension.
- Favor emotionally charged observations.
- Allow consequences of earlier choices to surface.
- Reveal hidden connections between established story elements.
- Avoid introducing major unrelated mysteries unless required.

Narrative Objectives:
- Prioritize payoff over setup.
- Connect present events to previously established clues.
- Deliver emotional and thematic resolution.
- Reveal truths through action and consequence.
- Maximize dramatic intensity.

Mystery Guidelines:
- Mysteries should converge.
- Avoid creating major unresolved plot threads.
- Prefer revelations that feel inevitable in hindsight.