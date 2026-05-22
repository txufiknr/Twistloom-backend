[ ] Page 1 selected actions masih none
[ ] Originals: Mc name predefine casts aja, jangan AI
[ ] Candidate pregeneration prioritize yang existing pagesnya dikit
[ ] Important objects perlu disimpen di story state?
[ ] Important objects perlu prop tambahan: trait (custom fields: color, battery-level), rules (custom string array), status (broken, missing)? 
[ ] Stripe switch to live
[ ] search jaccard, need change to cursor pagination?
[ ] Enhanced search (jaccard by book keywords & title)
[ ] GET /user/recommendations: you might like (based on liked books)
[ ] userSettings schema (interests, text size, email notification settings)
[ ] userLogins schema (userId, userAgent) -> database sessions (Drizzle adapter)
[ ] Implement belief
[ ] Implement corruption curve
[ ] AI_MAX_PROMPT_LENGTH belum dipake

[x] cron trasnlate langsung 5 book per request
[x] generate theme ake openai aja
[x] cron: auto translate book & page ke indo ('id') using AI (where `providerType` not 'ai')
[x] trigger read_count masih ngaco, visit_count udah bener 1
[x] inventory buat kayak injury, jangan string array
[x] add inventory, injuries di type StoryStateInitialGeneration (tambah juga di evaluator prompt: instruction & format)
[x] visitor percentage page 1 should always 100%
[x] docs: stripe VIP subscription
[x] Originals prevent duplicate title
[x] Github workflow Dynamic job name (book title)
[x] Non retryable error kok dipertanyakan? 

[x] book explore: filter by age range error
[x] Workflow add input max depth buat prevent infinite loop
[x] Depth level 2 kalau page number < 10 aja
[x] enriched book perlu `isCompleted` (ga cuma `isRead`)?

[ensureCandidatesForPageWithStrategy] ⚠️ All actions are invalid, replaced with 1 continue action.
https://github.com/txufiknr/Twistloom-backend/actions/runs/26221075235/job/77155911594

[cohere] 💥 Model command-r-08-2024 failed, trying next model: INVALID_SCHEMA
[cohere] ❌ All models failed: INVALID_SCHEMA

by book creator:
[ ] soundtrack based on mood
[ ] add page image
[ ] add voice or use noiz tts api

paid:
[ ] custom action prompt (max 50 chars, prevent sql inject, etc)
[ ] re-select other action in previous page
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
