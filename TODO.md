[ ] Page 1 selected actions masih none
[ ] Stripe switch to live
[ ] Implement belief
[ ] Implement corruption curve
[ ] Kalau source action belum ada, insert dulu page progress parent page
[ ] create paid book (vip with 500 followers, 30 days-old account, email verified, has published 50 books) -> pay as much as the book price -> book promoted
[ ] POST /user/comments - deprecated
[ ] isGeneratingStartedAt -> lastGenerationHeartbeatAt (no heartbeat for X minutes)
[ ] write CLAUDE.md based on README.md & AGENTS.md
[x] prompt: print injury & plot flag place & pageAcquired
[x] infer next page generation place & pageAcquired
[ ] claude review `getStoryProgress` and `getStoryProgressWithBranch`: services/story.ts & services/story-branch.ts (db/schema.ts)
[ ] claude review `NARRATIVE STYLE: ${createNarrativeStyle(state).instructions}`: utils/player-profile.ts & narrative-style.ts (types/story.ts)

[x] Previous pages >3 tampilin major plot flag aja (all) + indicator "(MAJOR)" (gausah "PLOT FLAGS:")
[ ] buat getPreviousPages return ActionedStoryPage[]
[ ] ensure enriched page has valid values for sourceNav (pake sourceAction?)
[ ] Place Traits pastiin record<string, string>
[ ] can we handle Tokenisation-level corruption (stage 3) with our own typescript helper function without using `jaison`?
[x] buat cron action candidate generation tiap 4 jam aja
[x] Initial viable ending gausah isDone, langsung string[]
[x] Generatedpages output concise max 250 chars



[ ] Consider generate multiverse in parallel instead of 1 big request
[ ] Roadmap docs dari chatgpt, minta claude review prompt.ts & ai-chat.ts
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
[ ] Paid book: VIP 500+ followers, must be > 30 days old account, ✅ Verified email required
[ ] Sale credits: 10% fee, cuma bisa dicairkan integer ke credits


{
  "flagUpdates": [
    { "flag_type": "fear", "level": "High" }
  ]
}


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
