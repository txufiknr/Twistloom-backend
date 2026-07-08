[ ] Page 1 selected actions masih none
[ ] Stripe switch to live
[ ] Implement belief
[ ] Implement corruption curve
[ ] Kalau real take action request & source action belum ada, page ga boleh dilihat
[ ] publish book: create paid book (vip with 500 followers, 30 days-old account, email verified, has published 50 books) -> pay as much as the book price -> book promoted
[ ] isGeneratingStartedAt -> lastGenerationHeartbeatAt (no heartbeat for X minutes)
[ ] mistral API key issue: https://www.reddit.com/r/MistralAI/comments/1ttqvbw/api_error_401_was_working/
[ ] pass title idea ke initalize book & github workflow dynamic job title
[ ] Generate originals tambah custom input book title & mc name
[ ] Paid book: VIP 500+ followers, must be > 30 days old account, Verified email required
[ ] Sale credits: 10% fee, cuma bisa dicairkan kelipatan 10 ke credits
[ ] userSettings schema
- interests: string[]
- email notification settings
[ ] reader vip: addPlannedCharacters (via add custom character button)
[ ] enhance book explore:
- [ ] fuzzy search/Levenshtein (typo tolerant) // does postgresql has this built-in?
- [ ] search jaccard similarity (by book keywords & title)
- [ ] need change to cursor pagination?

[ ] userCompletedBooks -> user_discovered_endings 
[ ] implement trust and safety enforcement system (TODO-trust-safety.md & TRUST_AND_SAFETY_ENFORCEMENT_SYSTEM.md)

[ ] sync sampling formula with ai-sampling.ts
[ ] ensure to refund 5 credits when generation failed
[x] prompt first book creation include summary & hook (alongside titleIdea)
[ ] prompt ensure add language check in review checklist

---

src\utils\prompt.ts
src\utils\candidate-generation.ts
src\types\story.ts
src\utils\story.ts
src\utils\text-processing.ts

can you trace and investigate what makes duplicate `futureNoteKeys` in `resolvePageDelta` function, and solve it?

functions to focus:
- resolvePageDelta
- generateNextPages
- generateCandidatePages
- mapFutureNoteWithKey
- ensureUniqueId

log:
[resolvePageDelta] 🔮 futureNoteKeys (10): [
  'mystery_1',
  'mystery_1',
  'world_1',
  'mystery_1',
  'character_1',
  'inventory_1',
  'character_1',
  'location_1',
  'relationship_1',
  'inventory_1'
]

Now I understand mapFutureNoteWithKey and ensureUniqueId. Let me trace the flow:

mapFutureNoteWithKey takes futureNoteKeys (existing keys) and uses ensureUniqueId with alwaysShowSuffix: true to generate unique keys like mystery_1, mystery_2, etc.
ensureUniqueId checks against a registeredKeys Set and increments suffix if needed.
Within a single call to mapFutureNoteWithKey, it properly adds each new key to registeredKeys (line 326), so duplicates within a single call are prevented.
The problem likely stems from either incomplete futureNoteKeys being passed to extractStateDelta, or the merge logic in applyStateDelta and processTagUpdates not properly deduplicating when combining futureNotes into state.
I need to examine how applyStateDelta handles the merging and check the callers of resolvePageDelta at lines 4202 and 4328 to see if advancedState already contains duplicates before processing.

Actually, looking at the log output more carefully—those futureNoteKeys are already duplicated in advancedState.futureNotes when resolvePageDelta gets called, which means the duplicates were introduced in a previous applyStateDelta call. I should trace through processTagUpdates to see how it's adding futureNotes.

---

Now I understand the full flow:

advanceStoryState does a structuredClone(state) and advances it (increments page, updates flags/psychology, etc.) — it does NOT touch futureNotes directly.
So advancedState.futureNotes are exactly the futureNotes from currentState (the state at the previous page).
resolvePageDelta then reads advancedState.futureNotes and maps keys.
So the duplicates in advancedState.futureNotes must have been introduced when the previous page's state was computed.

The previous page's state came from applyStateDelta, which calls processFutureNoteUpdates → processTagUpdates. There's a dedup check that compares items by key and skips duplicates, so duplicates shouldn't be introduced there. But I need to trace back to the initial state creation to see where they're actually coming from.

I'm wondering if the real issue is in the reconstruction path — when replaying deltas from the database, maybe the dedup logic isn't being applied consistently, or there's a race condition if multiple candidates are being generated in parallel and sharing the same state reference.

---

Now let me look at applyStateDelta and processTagUpdates — the duplicates are already in advancedState.futureNotes before resolvePageDelta is called, so they must be introduced when applying a previous delta.

---

@src/components/modals/StoryGenerationModal.tsx @src/lib/hooks/query/useUser.ts @src/stores/generation-store.ts @src/lib/utils/generation-refund.ts @src/lib/services/book-generation-tracker.ts when generation failed in frontend (e.g., timeout), can you ensure backend refunded book creation credits to user (with optimistic UI update)? then clicking "retry" (`POST /api/books/:bookId/retry`) should consumes credits again in backend
please examine current implementation to be sure it's already implemented or not, if not, please create robust plan and complete the implementation

---

can you comprehensively review my payment and subscription implementation using Stripe? let's start from backend project (Express)
package: "stripe": "^22.2.0"

backend files (uploaded):
docs\api\PAYMENTS_API_DOCUMENTATION.md
docs\architecture\STRIPE_PAYMENT_ARCHITECTURE.md (maybe obsolete)
docs\roadmap\SUBSCRIPTION_HYBRID_MODEL_ROADMAP.md (maybe obsolete)
src\config\credits.ts
src\config\subscription.ts
src\cron\vip-expiration.ts
src\db\schema.ts
src\routes\payments.ts
src\services\credits.ts
src\services\subscription.ts
src\types\credits.ts
src\types\subscription.ts
src\utils\stripe.ts

if you find any issues, please refine and correct
after my stripe & VIP subscription implementation truly stable, I thought about implementing "1-month VIP free trial" for users (much like in LinkedIn), can you write comprehensive roadmap plan MD file?


src\app.ts (later check)

---

ensure stripe webhook events:
 * Events:
 * - checkout.session.completed
 * - charge.refunded
 * - customer.subscription.created
 * - customer.subscription.updated
 * - customer.subscription.deleted
 * - invoice.payment_succeeded
 * - invoice.payment_failed

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