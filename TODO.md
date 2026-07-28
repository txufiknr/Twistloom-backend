[ ] Page 1 selected actions masih none
[ ] Stripe switch to live
[ ] Xendit switch to live
[ ] Kalau real take action request & source action belum ada, page ga boleh dilihat
[ ] publish book: create paid book (vip with 500 followers, 30 days-old account, email verified, has published 50 books) -> pay as much as the book price -> book promoted
[ ] isGeneratingStartedAt -> lastGenerationHeartbeatAt (no heartbeat for X minutes)
[ ] mistral API key issue: https://www.reddit.com/r/MistralAI/comments/1ttqvbw/api_error_401_was_working/
[ ] pass title idea ke initalize book & github workflow dynamic job title
[ ] Generate originals tambah custom input book title & mc name
[ ] Paid book: VIP 500+ followers, must be > 30 days old account, Verified email required
[ ] Sale credits: 10% fee, cuma bisa dicairkan kelipatan 10 ke credits
[ ] userSettings schema: interests: string[]
[ ] reader vip: addPlannedCharacters (via add custom character button)
[ ] enhance book explore:
- [ ] fuzzy search/Levenshtein (typo tolerant) // does postgresql has this built-in?
- [ ] search jaccard similarity (by book keywords & title)
- [ ] need change to cursor pagination?

[@] sync sampling formula with ai-sampling.ts
[ ] implement trust and safety enforcement system (TODO-trust-safety.md & TRUST_AND_SAFETY_ENFORCEMENT_SYSTEM.md)
[ ] Before insert page, correct futureNote keys
[ ] Place categories list di prompt aja
[ ] formatEndingPlan: if no `changeNote` (initial viable ending), use from `book.ending` instead
[ ] on book.ending edit, evaluate with AI for security and viability score
[ ] always generate AI illustration for page 1
[ ] can you apply requireVerifiedEmail middleware on "Profile & account management routes" routes first, sequentially?
[ ] enrich initialize book with generated mc image
[ ] enrich page 1 with imagePrompt -> generate page image cron
[ ] reset db -> check "1.2 — Engine regression test suite"
[ ] https://dashboard.xendit.co/settings/developers#api-keys
[ ] pastInteractions -> interactions

---

[gemini/gemini-3.5-flash] ❗ Bad request (other):
  ApiError: {"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}
      at throwErrorIfNotOK (file:///home/runner/work/Twistloom-backend/Twistloom-backend/node_modules/.pnpm/@google+genai@2.7.0/node_modules/@google/genai/dist/node/index.mjs:13547:30)
      at process.processTicksAndRejections (node:internal/process/task_queues:103:5)
      at async file:///home/runner/work/Twistloom-backend/Twistloom-backend/node_modules/.pnpm/@google+genai@2.7.0/node_modules/@google/genai/dist/node/index.mjs:13247:13
      at async Models.generateContent (file:///home/runner/work/Twistloom-backend/Twistloom-backend/node_modules/.pnpm/@google+genai@2.7.0/node_modules/@google/genai/dist/node/index.mjs:14655:24)
      at async candidates (file:///home/runner/work/Twistloom-backend/Twistloom-backend/dist/utils/ai-chat.js:243:26)
      at async retryWithBackoff (file:///home/runner/work/Twistloom-backend/Twistloom-backend/dist/utils/retry.js:119:20)
      at async promptWithFallback (file:///home/runner/work/Twistloom-backend/Twistloom-backend/dist/utils/ai-chat.js:58:30)
      at async aiPrompt (file:///home/runner/work/Twistloom-backend/Twistloom-backend/dist/utils/ai-chat.js:826:30)
      at async executePromptForJSON (file:///home/runner/work/Twistloom-backend/Twistloom-backend/dist/utils/prompt.js:4497:22)
      at async generateNextPage (file:///home/runner/work/Twistloom-backend/Twistloom-backend/dist/utils/prompt.js:4180:22) {
    status: 400
  }
  
---

ApiError: {"error":{"code":429,"message":"TotalCachedContentStorageTokensPerModelFreeTier limit exceeded for model gemini-2.5-flash: limit=0, requested=7558","status":"RESOURCE_EXHAUSTED"}}

ApiError: {"error":{"code":400,"message":"The specified schema produces a constraint that has too many states for serving. Typical causes of this error are schemas with lots of text (for example, very long property or enum names), schemas with long array length limits (especially when nested), or schemas using complex value matchers (for example, integers or numbers with minimum/maximum bounds or strings with complex formats like date-time)","status":"INVALID_ARGUMENT"}}

---

TO PURCHASE:
[ ] upstash redis & qstash
[ ] upgrade vercel hobby -> pro
[ ] beli domain twistloom.com -> buat email dev@twistloom.com
[ ] migrate semua akun AI pake email dev@twistloom.com -> replace all API keys -> delete old api keys & project
[ ] purchase premium AI chat API keys
[ ] migrate: GitHub models 8K context -> Official OpenAI 128K context
[ ] migrate: LRU & in-memory cache (for static configurations or public API metadata) -> Vercel KV or Upstash Redis for true, shared cross-user in-memory storage.
[ ] migrate: serverless environment -> single, always-on server Vercel VPS alternative (like Render, Railway, or Fly.io) if you want a true, traditional single-instance server.
[ ] unlock 1,000 RPD OpenRouter: requires a one-time $10 credit top-up

---

APIError: 402 This request requires more credits, or fewer max_tokens. You requested up to 4000 tokens, but can only afford 1538. To increase, visit https://openrouter.ai/settings/credits and upgrade to a paid account

---

@src/utils/ai-chat.ts @src/types/ai-chat.ts in my multi-provider fallback, is it good idea to have timeout config param to limit duration per model? if exceeds, then fail and fallback to next model/provider
if yes, please implement
also ensure `maxRetries` be customized too via config param (defaults to: AI_CHAT_MODEL_RETRY_COUNT)

---

2026-07-21T11:26:04.2343652Z [classifyGenAIError] ❓ Bad request (other): ApiError: {"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}
2026-07-21T11:26:04.2353100Z     at async generateNextPage (file:///home/runner/work/Twistloom-backend/Twistloom-backend/dist/utils/prompt.js:4243:22) {

---

[ ] callers of `getEnrichedBookSelect` should left join to:
  - userSessions
  - firstPageSq
  - uploadedImages
  - sessionPages
  - storyStates

// example:

const targetLanguage = "es";

const firstPageSq = dbRead.select({
  bookId: pages.bookId,
  id: pages.id,
  text: pages.text,
})
.from(pages)
.where(eq(pages.page, 1))
.as("fp");

const query = dbRead.select({
  id: books.id,
  title: books.title,
  imageUrl: uploadedImages.imageUrl, // O(1) direct column join mapping
  
  // Flatly map first page attributes from the pre-grouped join
  firstPageId: firstPageSq.id,
  firstPageText: firstPageSq.text,
  
  // Flatly map session tracking from the direct 1:1 join
  lastReadAt: userSessions.updatedAt,
  lastPageId: userSessions.pageId,
  lastPageNumber: sessionPages.page,
  contextHistory: sql`COALESCE(${storyStates.contextHistory}, '')`,
})
.from(books)
.leftJoin(users, eq(books.userId, users.userId))
.leftJoin(uploadedImages, eq(books.imageId, uploadedImages.imageId)) // Replaces imageUrl subquery
.leftJoin(firstPageSq, eq(books.id, firstPageSq.bookId))             // Replaces duplicate page scans
// Direct 1:1 user sessions lookup safely utilizing index keys
.leftJoin(
  userSessions,
  and(eq(userSessions.bookId, books.id), eq(userSessions.userId, currentUserId))
)
.leftJoin(sessionPages, eq(userSessions.pageId, sessionPages.id))
.leftJoin(storyStates, eq(userSessions.pageId, storyStates.pageId));

---

buat theme idea:
[github] ✅ openai/gpt-4o

buat theme validation:
[nvidia] ✅ meta/llama-3.3-70b-instruct
[openrouter] ✅ qwen/qwen3-30b-a3b

buat book/page generation:
[groq] ✅ openai/gpt-oss-120b
[cerebras] ✅ gpt-oss-120b
[openrouter] ✅ google/gemini-2.5-flash

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
mc: sql<StoryMC>`
  books.mc ||
  jsonb_build_object(
    'imageUrl',
    (
      SELECT ui.image_url
      FROM uploaded_images ui
      WHERE ui.image_id = books.mc->>'imageId'
      LIMIT 1
    )
  )
`,

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

---

[ensureCandidatesForPageWithStrategy] ⚠️ All actions are invalid, replaced with 1 continue action.
https://github.com/txufiknr/Twistloom-backend/actions/runs/26221075235/job/77155911594

---

future:
[ ] next-intl multi language tambah bahasa lain
[ ] initialize book: auto-generate MC picture (AI-generated image)
[ ] text to speech audio book/storyteller (noiz)

by book creator:
[ ] soundtrack based on place/mood
[ ] upload/generate character image
[ ] upload/generate page image
[ ] upload/generate narrator voice

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

---

Comment example (use your own wording):
"This is a captivating and ominous concept, hinting at a gripping tale that.... So excited to bring your story to life. Let me plan and write the story—will be ready for you very soon!"