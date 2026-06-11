[ ] Page 1 selected actions masih none
[ ] Stripe switch to live
[ ] Implement belief
[ ] Implement corruption curve
[ ] Kalau real take action request & source action belum ada, page ga boleh dilihat
[ ] create paid book (vip with 500 followers, 30 days-old account, email verified, has published 50 books) -> pay as much as the book price -> book promoted
[ ] POST /user/comments - deprecated
[ ] isGeneratingStartedAt -> lastGenerationHeartbeatAt (no heartbeat for X minutes)
[ ] write CLAUDE.md based on README.md & AGENTS.md

[ ] const validated = ajv.validate(schema, aiResponse);
https://www.npmjs.com/package/ajv

[ ] json schema "minLength": 1
{
  "familiarity": {
    "type": "number",
    "minimum": 0,
    "maximum": 1
  }
}

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

please examine my:
- utils/prompt.ts
- utils/ai-chat.ts
- utils/ai-chat-stream.ts

and learn LLM optimizations roadmap MD docs provided by chatgpt

can you:
- elaborate on optimization docs
- elaborate on current implementation
- provie me what are do-able actions to do to improve my implementation
- tell me if you have any extra optimization plan besides in the docs

finally, provide me:
- gradual patches I can drop-in (easier/minor first)
- updated & unified LLM optimizations roadmap MD docs to best reflect actual implementation in Twitloom (and mark actioned step as completed)

please keep the unifed MD docs be comprehensive, verbose explanations, and easy to understand for beginners

---

[ ] Place Traits pastiin record<string, string>
[ ] book type add: translation?: BookTranslation;
[ ] Consider generate multiverse in parallel instead of 1 big request
[ ] Roadmap AI optimization docs dari chatgpt, minta claude review prompt.ts & ai-chat.ts
[ ] Provider Abstraction Layer:
interface AIProvider {
  generate(request: AIRequest): Promise<AIResponse>;
  stream(request: AIRequest): AsyncIterable<string>;
}

Prompt:
- story thread: active clues, active mysteries
- story summary (contextHistory) format bullet points
- The most stable content should always appear first → task at bottom
- instructions and output specifications at the top is the industry best practice for prompt caching.
- buat system prompt static semua

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
- fuzzy search/Levenshtein (typo) // does postgresql has this built-in?
- search jaccard similarity (by book keywords & title)
- need change to cursor pagination?

[ensureCandidatesForPageWithStrategy] ⚠️ All actions are invalid, replaced with 1 continue action.
https://github.com/txufiknr/Twistloom-backend/actions/runs/26221075235/job/77155911594

future:
[ ] initialize book: auto-generate MC picture (AI-generated image)

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





I'd like to see your designs proposal for:

Branch locking system (prevents illegal jumps)
“Golden path” vs “corrupted path” tracking
Replay system with alternate timeline comparison
