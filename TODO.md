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

---
I got error for this line:
response_format: buildOpenAIResponseFormat(context, outputAsJson, outputJsonStructure, outputJsonRequired),

Type '{ type: string; json_schema: { name: string; strict: boolean; schema: AIJsonProperty | undefined; }; } | { type: string; json_schema?: undefined; } | undefined' is not assignable to type 'ResponseFormatText | ResponseFormatJSONSchema | ResponseFormatJSONObject | undefined'.
  Type '{ type: string; json_schema: { name: string; strict: boolean; schema: AIJsonProperty | undefined; }; }' is not assignable to type 'ResponseFormatText | ResponseFormatJSONSchema | ResponseFormatJSONObject | undefined'.
    Type '{ type: string; json_schema: { name: string; strict: boolean; schema: AIJsonProperty | undefined; }; }' is not assignable to type 'ResponseFormatText | ResponseFormatJSONSchema | ResponseFormatJSONObject'.
      Type '{ type: string; json_schema: { name: string; strict: boolean; schema: AIJsonProperty | undefined; }; }' is not assignable to type 'ResponseFormatJSONSchema'.
        Types of property 'type' are incompatible.
          Type 'string' is not assignable to type '"json_schema"'.
completions.d.ts(1823, 5): The expected type comes from property 'response_format' which is declared here on type 'OpenRouterCreateParams'

and for these blocks in `groqStreamGenerator`:

const stream = await getGroqClient().chat.completions.create({
  messages: buildChatMessages(systemPromptWithDocuments, prompt),
  model,
  stream: true,
  stream_options: { include_usage: true },
  ...buildSamplingParams('groq', model, config),
  response_format: buildOpenAIResponseFormat(context, outputAsJson, outputJsonStructure, outputJsonRequired),
} satisfies Groq.ChatCompletionCreateParamsStreaming, { signal });

No overload matches this call.
  Overload 1 of 3, '(body: ChatCompletionCreateParamsNonStreaming, options?: RequestOptions | undefined): APIPromise<ChatCompletion>', gave the following error.
    Type 'true' is not assignable to type 'false'.
  Overload 2 of 3, '(body: ChatCompletionCreateParamsStreaming, options?: RequestOptions | undefined): APIPromise<Stream<ChatCompletionChunk>>', gave the following error.
    Object literal may only specify known properties, and 'stream_options' does not exist in type 'ChatCompletionCreateParamsStreaming'.
  Overload 3 of 3, '(body: ChatCompletionCreateParamsBase, options?: RequestOptions | undefined): APIPromise<ChatCompletion | Stream<...>>', gave the following error.
    Object literal may only specify known properties, and 'stream_options' does not exist in type 'ChatCompletionCreateParamsBase'.
completions.d.mts(1970, 5): The expected type comes from property 'stream' which is declared here on type 'ChatCompletionCreateParamsNonStreaming'

Object literal may only specify known properties, and 'stream_options' does not exist in type 'ChatCompletionCreateParamsStreaming'.

if (chunk.usage) {
  usage = {
    promptTokens: chunk.usage.prompt_tokens,
    cachedTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

Property 'usage' does not exist on type 'ChatCompletionChunk'.

can you add models from those new providers in my AI provider-model waterfall (AI_CHAT_MODELS_WRITING, AI_CHAT_MODELS_FAST, AI_CHAT_MODELS_IDEA, AI_CHAT_MODELS_EVALUATION, etc)?

---

async function* groqStreamGenerator(
  prompt: string,
  options: Partial<PromptWithFallbackOptions>
): AIStreamGenerator {
  const { signal, context, config = AI_CHAT_CONFIG_DEFAULT, outputAsJson, outputJsonStructure, outputJsonRequired } = options;
  const systemPromptWithDocuments = formatSystemPromptWithDocuments('groq', options);

  const model = resolveStreamDefaultModel('groq', options);
  
  const stream = await getGroqClient().chat.completions.create({
    messages: buildChatMessages(systemPromptWithDocuments, prompt),
    model,
    stream: true,
    stream_options: { include_usage: true },
    ...buildSamplingParams('groq', model, config),
    response_format: buildOpenAIResponseFormat(context, outputAsJson, outputJsonStructure, outputJsonRequired),
  // 1. Cast the payload instead of using `satisfies` to bypass the missing `stream_options` type
  } as Groq.ChatCompletionCreateParamsStreaming & { stream_options?: { include_usage: boolean } }, { signal });

  let usage: StreamUsage | undefined;

  for await (const chunk of stream) {
    if (signal?.aborted) return usage;

    // 2. Cast chunk to `any` to bypass the missing `usage` type on ChatCompletionChunk.
    // 3. Add a fallback to `x_groq?.usage` to catch Groq's custom metadata wrapper.
    const rawChunk = chunk as any;
    const chunkUsage = rawChunk.usage || rawChunk.x_groq?.usage;

    if (chunkUsage) {
      usage = {
        promptTokens: chunkUsage.prompt_tokens,
        cachedTokens: chunkUsage.prompt_tokens_details?.cached_tokens ?? 0,
      };
    }

    const delta = extractDeltaText(chunk);
    if (delta) yield delta;
  }

  return usage;
}

---

TODO-multi-turn-request.md
src\utils\prompt.ts
src\types\story.ts
src\schema\story.ts

please learn this answer and suggestion from ChatGPT in `TODO-multi-turn-request.md`
I want to implement it, but for now only split into 2 multi-turn requests: StoryPage and StateDelta
please learn about both `StoryPageGeneration` and `StateDeltaGeneration` type definitions which used in `STORY_GENERATION_SCHEMA_DEFINITION` and `CANDIDATE_GENERATION_SCHEMA_DEFINITION`
for these functions:
- generateNextPage
- generateNextPages

and I also want to split `generatedPages` ('multiverse' book page generation) in `CANDIDATE_GENERATION_SCHEMA_DEFINITION` into parallel multi-turn request:
example (in parallel):
- StoryPage (alt 1) → StateDelta (alt 1)
- StoryPage (alt 2) → StateDelta (alt 2)
- StoryPage (alt 3) → StateDelta (alt 3)

please thoroughly examine current implementation and write comprehensive roadmap MD plan doc in docs\roadmap , grounded on actual codebase, including:
- json schema splitting in src\schema\story.ts
- user & system prompt separation
- refactor both generateNextPage(s) function into 2-step multi-turn requests
- ensure ai-chat.ts support multi-turn

adjust DEFAULT_MAX_OUTPUT_TOKEN and EVALUATION_SCORING_OUTPUT_TOKEN per turn (since now it halved)

because page and state delta generation now split, I also want state delta generation be retryable anytime in separate AI chat request (idempotent) in case only StoryPage generation was succeeded
so maybe we need a way (new db table and/or column) to track partial page generation and retry later (e.g., via cron)

because this it a big refactor, please divide into smaller targeted tasks, phases, and steps
note: this is roadmap documentation writing only, no code changes

---

[@] sync sampling formula with ai-sampling.ts
[ ] implement trust and safety enforcement system (TODO-trust-safety.md & TRUST_AND_SAFETY_ENFORCEMENT_SYSTEM.md)
[ ] on book.ending edit, evaluate with AI for security and plausibility
[ ] always generate AI illustration for page 1
[ ] can you apply requireVerifiedEmail middleware on "Profile & account management routes" routes first, sequentially?
[ ] enrich initialize book with generated mc image
[ ] enrich page 1 with imagePrompt -> generate page image cron
[ ] xendit api keys: https://dashboard.xendit.co/settings/developers#api-keys
[ ] migrate to QUERY: https://dev.to/hamidrazadev/the-new-http-query-method-why-get-and-post-werent-enough-1lc5
[ ] pastInteractions -> interactions
[ ] learn about Interactions API (https://ai.google.dev/gemini-api/docs/migrate-to-interactions)
[ ] ensure `PUT /api/user/editor-prefs` API route optimal en-to-end based on `AI_CO_WRITING_PEN_ROADMAP.md` and frontend's `src\lib\services\users-api.ts`, shouldn't we only send dirty (only changed) fields instead of all fields?
[ ] lengkapi API keys llm provider baru
[ ] can you also add ai-cost for these gemini models: `gemini-3.6-flash`?
[ ] book-creation.ts still not language-agnostic
[@] please check `validateGeneratedPage`, I don't want to ditch AI generation result merely because it provides multiple actions for 'novel' book mode (should just strip it sliently), is it already safe & handled as intended?
[@] persistPageWithState/insertStoryPage: cleanup [actionType] from page.text before insert
[ ] sanitizeActionsForMode: should pick random instead of always first `[0]`
[@] pen prompt: ensure find matching lore entity from story text via triggerKeywords
[ ] instead of 1 big failing request (schema too complex for gemini or prompt token exceeds) should we using multi-turn request for generating single big page json? ask AI to generate each json key and append sequentially in each turn, will that solve the problem?
[ ] claude: should we using multi-turn request instead of big array json for generating `generatedPages` (alternative fates) in 'multiverse' book mode?
[x] claude: review & refine TODO-gemini-interactions-api.md
[x] claude: review & refine TODO-save-prompt-token.md
[x] claude: review & refine TODO-ai-chat-enhancements.md
[x] claude: review & refine TODO-hybrid-diffusion-llm.md
[x] claude: consolidate `TWISTLOOM_MCP_AGENTIC_WORKFLOW_CHATGPT.md` and `TWISTLOOM_MCP_ROADMAP.md`
[ ] opencode/claude: TODO-multi-turn-request.md gounded on actual codebase

---

---

[ ] claude: migrate "Minimal local shape" to use canonical types from `@google/genai` (D:\Projects\Twistloom\Twistloom-backend\node_modules\@google\genai\dist\genai.d.ts)

[ ] docs\roadmap\TWISTLOOM_AGENT_MCP_ROADMAP.md
[ ] docs\roadmap\TWISTLOOM_AI_DRY_OPPORTUNITIES.md
[ ] promote inception mercury: docs\roadmap\AI_DIFFUSION_TOKEN_SAVING_EXECUTION_ROADMAP.md
[ ] bun tests/test-diffusion-adherence.ts

[ ] register & otp sms: https://www.modelscope.cn/register
[ ] setup ovh cloud api key:
https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-getting-started
https://manager.ca.ovhcloud.com/#/public-cloud/pci/projects/new?cartId=f28fcbf3-81ef-4bc1-a1cf-402d249ae8b7

---

mistral/mistral-medium-latest
SDKError: API error occurred: Status 402. Body: {"detail":"Check your subscription on https://admin.mistral.ai/subscription"}
   statusCode: 402,

gemini/gemini-3.5-flash
ApiError: {"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}
   status: 400,

---

Dependency Audit github workflow error in 0s

Run bun audit --json > audit.json
bun audit v1.3.14 (0d9b296a)
Error: Process completed with exit code 1.

---

TO PURCHASE:
[ ] purchase premium AI chat API keys
[ ] beli domain twistloom.com -> buat email dev@twistloom.com
[ ] migrate semua akun AI pake email dev@twistloom.com -> replace all API keys -> delete old api keys & project
[ ] optional: upstash redis & qstash
[ ] optional: upgrade vercel hobby -> pro
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