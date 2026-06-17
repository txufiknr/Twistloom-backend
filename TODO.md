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
[ ] translate story state (place name, inventory, actionsHistory, contextHistory)
[ ] db reset & pnpm check

Migrate imagen
Endpoints to be discontinued	Recommended migration path
imagen-4.0-generate-001	gemini-3.1-flash-image
imagen-4.0-ultra-generate-001	gemini-3.1-flash-image
imagen-4.0-fast-generate-001	gemini-3.1-flash-image

Backend:
Does very verbose and lengthy system prompt really necessary, worth, and benefits?

https://www.tokengratis.id/

---

[ ] claude investigate 401 error

backend:
src/middleware/nextauth.ts

frontend:
src/auth.ts

---

here's my Groq chat completions limit I copy-pasted from: https://console.groq.com/settings/limits

Chat Completions
Model	Requests per Minute	Requests per Day	Tokens per Minute	Tokens per Day	Actions
allam-2-7b	30	7K	6K	500K	
groq/compound	30	250	70K	No limit	
groq/compound-mini	30	250	70K	No limit	
llama-3.1-8b-instant	30	14.4K	6K	500K	
llama-3.3-70b-versatile	30	1K	12K	100K	
meta-llama/llama-4-scout-17b-16e-instruct	30	1K	30K	500K	
meta-llama/llama-prompt-guard-2-22m	30	14.4K	15K	500K	
meta-llama/llama-prompt-guard-2-86m	30	14.4K	15K	500K	
openai/gpt-oss-120b	30	1K	8K	200K	
openai/gpt-oss-20b	30	1K	8K	200K	
openai/gpt-oss-safeguard-20b	30	1K	8K	200K	
qwen/qwen3-32b	60	1K	6K	500K	

based on that, can you:
- filter which models fit for creative thriller story writing in priority order (by most creative)
- correct my Groq `rpm` & `rpd`
- should we add `rpmo` as well for Cohere case (monthly quota)?
- correct my `canUseAIToday` logic to account montly quota correctly (if `rpmo` value defined)

and also for rate limit differentiation across models in single provider, I think I'm no problem to use the highest RPM & RPD
because my waterfall logic handles that quota exceeded error gracefully and goes to next provider-model fallback
so I prefer ceiling values instead of minimum conservative values (which risk of ignoring actual quota remaining), but just add notes in the jsdoc or inline comments

please continue

---

utils/prompt.ts: formatActiveThreads, getThreadState
utils/story.ts: processThreadUpdates
types/story-thread.ts

I want to enhance my story thread system for reader experience, while also keeping it not too complex for AI
here's suggestions from ChatGPT (uploaded)
what's your proposal?

---

Recent Momentum Trend:
Building → Rising → Critical

Current Narrative Pressure:
High

Sesuaiin sama real values aja:
Example: High curiosity leads to discovering uncomfortable truths
  - Profile archetype: "the_explorer"
  - Curiosity flag: "high"
  - Recommended ending type: "false_reality"

---

[ ] ask claude to review and incorporate new LLM providers

docs/TODO-more-llm-sdk.md
docs/TODO-more-llm-sdk-2.md
config/ai-clients.ts
utils/ai-chat.ts
utils/ai-chat-stream.ts
utils/ai-limiters.ts
utils/ai-clients.ts

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