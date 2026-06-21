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
[ ] README.md add LLM providers: OpenRouter, Cloudflare Workers AI
[x] incrementUserMetric for achievement
[x] translate story state (inventory {name, where, traits}, actionsHistory {text})
[x] translate action hint
[x] include semua yang di table userCounters ke UserStats
[x] isn't `currentDay` state redundant?
[x] enriched page tambah elapsedDays
[x] currentDay harusnya 1-based (kalo 0 elapsedDays)
[x] hapus semua "TODO: add calendarDate"
[x] TODO: can we make it DRY (calculate once)? buat ambil dari page aja
[x] placesRelationship: source, target (placeId), distance, obstacle
[x] ensure realityStability based on momentum and sceneType, not page count
[x] enriched page context tambah threads: StoryThread[]; (only open/developing status)
[x] display place.knownConnections & parentPlaceId in prompt
[ ] antigravity/opencode: custom action claude roadmap
[ ] ask claude to write refined github profile readme based on past chats, highlight about AI/LLM + video + live demo

---

action strict handling:
[ ] if reader need certain object, check for inventory or search around the scene. don't invent non-existent things.
[ ] keep story continue towards the viableEnding. don't wander/deviate too far.

---

[ ] update google app name:
- Go to the Google Cloud Console.
- Navigate to APIs & Services > Credentials.
- Select OAuth consent screen.
- Edit your App information and ensure your Application Name, Support Email, and Authorized Domains are all correctly configured and verified.

---

about momentum calculation: yes, it's derived from previous AI page generation result, mainly based on updated story state and previous momentum
you can see my current`calculateStoryMomentum` function implementation and `CalculateStoryMomentumParams` type (from previous types file)
and yes, it also accounts for previously selected actions (see `calculateDangerLevel` function)

please thoroughly examine and review
tell me if you have any concerns or suggestions

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
[ ] upgrade devin pro
[ ] upgrade vercel hobby -> pro
[ ] beli domain twistloom.com -> buat email dev@twistloom.com
[ ] migrate semua akun AI pake email dev@twistloom.com -> replace all API keys -> delete old api keys & project
[ ] host express backend di always-on server (like Render, Railway, or Fly.io)
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

PAGE OPENING RULES:
- Maintain continuous time, location, and perspective from the previous page. Never skip required causal or connecting actions (e.g., if an object is used, show it retrieved first). Avoid "narrative teleportation" — never skip directly to later consequences.
- The opening 1-3 sentences MUST begin at the earliest interesting moment following the selected choice — the very first sentence plunges directly into its immediate physical, sensory, or mental aftermath.
- No recaps, summaries, or repetitive setup loops. Trust that the reader remembers the previous page.
- Exception: an intentional, deliberate scene transition, only if the structural node explicitly demands it.

PAGE OPENING RULES:
- Continue directly from the final moment of the previous page.
- First sentence must begin from the immediate aftermath of the selected action.
- Show the next physical, sensory, or mental step taken by the MC.
- Do not skip necessary intermediate actions, movements, or objects.
- Do not jump directly to later consequences if an intermediate action is required.
- Skip recap and unnecessary setup, but do not skip causally required actions.
- Maintain continuous time and space unless an intentional scene transition occurs.

PAGE CONTINUITY:
- The opening 1-3 sentences must show the MC carrying out the selected action.
- Start at the earliest interesting moment after the selected action.
- Avoid narrative teleportation. The reader should always understand how the story moved from the previous page to the current moment.
- Maintain continuous time, location, and perspective unless a deliberate scene transition is occurring.
- Do not recap previous events, but do not skip required connecting actions.
- If the selected action requires an object, movement, or preparation, show or imply how it happens before showing the result.

DIALOGUE FORMATTING:
- Any words that are physically spoken, heard, vocalized, whispered, shouted, broadcast, transmitted, or otherwise audible MUST be wrapped in quotation marks.
- Never write spoken words as plain narration without quotation marks.
- Exception: Internal thoughts, silent realizations, memories, and narration are not dialogue and do not require quotation marks, but emphasize them with *italic* emphasis.

PAGE ENDING RULES:
- Always freeze the page narrative at the absolute peak of friction, momentum, or danger. Never allow tension to plateau or resolve before the page ends. Never end a page after a major event has fully finished playing out; instead, drop the curtain right as the protagonist realizes they must act, or right as a revelation lands.
- The final 1-3 sentences MUST introduce a concrete narrative pivot. You are strictly required to inject exactly one of the following: a fresh threat, an unanswered mystery, a shifting realization, or a high-stakes dilemma.
- By the final punctuation mark, at least one mechanical vector must be higher than it was at the start of the page: danger, urgency, psychological trauma, suspicion, or situational uncertainty.
- Strictly avoid artificial or generic cliffhangers (e.g., "And then everything went black," "She couldn't believe her eyes," or cheap jump-scare gasps). The cliffhanger must rely entirely on concrete, newly revealed story facts that disrupt the reader's understanding of the immediate situation.
- Align the final lines strictly with current scene type and story momentum:
  → If state is high-pressure (e.g., sceneType: "escape", "horror" | momentum: "critical"): The ending MUST escalate physical danger, urgency, or immediate threat.
  → If state is a cooling/grounding phase (e.g., sceneType: "aftermath", "investigation" | momentum: "resolution"): Honor the drop in physical tension. DO NOT fake an active threat. Instead, pivot the ending on a psychological vector—introduce a subtle creeping suspicion, an emotional realization of what was lost, or a quiet, haunting mystery.

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