[ ] Page 1 selected actions masih none
[ ] Stripe switch to live
[ ] Implement belief
[ ] Implement corruption curve
[ ] Kalau real take action request & source action belum ada, page ga boleh dilihat
[ ] create paid book (vip with 500 followers, 30 days-old account, email verified, has published 50 books) -> pay as much as the book price -> book promoted
[ ] POST /user/comments - deprecated
[ ] isGeneratingStartedAt -> lastGenerationHeartbeatAt (no heartbeat for X minutes)
[ ] write CLAUDE.md based on README.md & AGENTS.md
[ ] Consider place & character key (generate like future note key) -> replace all "real full name"
[ ] Routine retry cron buat sequential aja (github action strategy)
[ ] story state: elapsedDays
[ ] story delta: elapsedDays (replace), mcAgeDelta (increment)
[ ] story state: sceneTypes
[ ] story state: storyMomentum: "building" | "rising" | "critical" | "resolution";
[ ] more LLM SDK: OpenRouter, Cloudflare Workers AI, Hugging Face Serverless Inference API, Together AI
[ ] Process character update relationship match first name & knownName

---

Story Momentum: Critical

Writing Guidance:
- Increase urgency.
- Favor emotionally charged observations.
- Compress downtime.
- Make actions feel consequential.

export const storyMomentums = {
  "building": "",
  "rising": "",
  "critical": "",
  "resolution": "",
};

export const sceneTypes = {
  "investigation": "",
  "revelation": "",
  "dialogue": "",
  "dream": "",
  "escape": "",
  "confrontation": "",
  "aftermath": "",
};

Writing Style Guidance:
- Use more symbolic imagery.
- Allow unusual metaphors.
- Favor sensory language.


Story Phase: Development
Story Momentum: Critical
Scene Type: Revelation

Writing Goals:
- Reveal meaningful information.
- Increase urgency.
- Connect clues established earlier.
- Use vivid but controlled imagery.
- Avoid introducing unrelated mysteries.

---

[ ] const validated = ajv.validate(schema, aiResponse);
https://www.npmjs.com/package/ajv

---
utils/prompt.ts
types/story.ts
config/story.ts

storyMomentum: "building" | "rising" | "critical" | "resolution";

---

validate AI json integrity:

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
[ ] Roadmap AI optimization docs selesaiin & jadiin architecture MD docs file
[ ] Provider Abstraction Layer:
interface AIProvider {
  generate(request: AIRequest): Promise<AIResponse>;
  stream(request: AIRequest): AsyncIterable<string>;
}

[ ] Prompt: story thread: active clues, active mysteries
[ ] titleIdea buat mandatory aja, jadiin input cron juga
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
[ ] purchase premium AI chat API keys
[ ] migrate: GitHub models 8K context -> Official OpenAI 128K context
[ ] migrate: LRU & in-memory cache (for static configurations or public API metadata) -> Vercel KV or Upstash Redis for true, shared cross-user in-memory storage.
[ ] migrate: serverless environment -> single, always-on server Vercel VPS alternative (like Render, Railway, or Fly.io) if you want a true, traditional single-instance server.

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

---

Current Story Momentum: Critical

Writing Guidance:
- Every scene should feel consequential.
- Increase urgency.
- Reduce routine interactions.
- Favor irreversible developments.