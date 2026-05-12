[x] ensure get /:pageId booknya include author & firstPageId
[x] enriched book lastPage (from latest userPageProgress)
[x] ensure book slug not same as preserved endpoints: stats, explore
[x] consolidate get page & page visit
[x] apakah get /user ada `isGuest`?
[x] Retry pending generation kalo udah stable bikin paralel
[x] Ensure Visit count jangan itung system user
[x] Cleanup story states: Early check kalau existing pages dikit skip
[x] Book title jangan selalu diawali "The"
[x] Enriched page: add characters, phase, running summary
[x] enriched page add contextHistory, characters, phase
[x] Get Story state fallback get by parentId+stateDelta -> persists DB
[x] research Pg-boss / bullmq + redis
[x] Ensure candidate: kalau cron gausah ttl timeout & gausah paralel (kalau paralel udah stable) 
[x] code optimization from TODO-pgboss.md
[x] candidate generation SSE UX roadmap (CANDIDATE_GENERATION_ENHANCEMENT_ROADMAP.md)
[x] prompt ensure action text unique
[x] config: MAX_BRANCHING_PREGENERATION_DEPTH = 2;
[x] job priority harusnya berdasarkan depth
[x] ensure twistloom_guest_id always same for 30 days
[ ] Consolidate like & save (like bisa save ke collection)
[ ] generate next page / insert page: prevent actions kosong
[ ] Cron: detect pages yg action object kosong, generate
[ ] Originals: Mc name predefine aja, jangan AI
[ ] User settings api: text size
[ ] Candidate pregeneration prioritize yang existing pagesnya dikit

[x] Migrate vercel cron to Vercel's Background Functions
[x] Enriched page context tambah: injuries, inventory
[x] Habis page 2 kok page 2 lagi (I reach over)? 
Important objects perlu disimpen di story state?
Important objects perlu rules? 

Text too short:
I swung. Hard. The phone met the desk edge—no crack. No scream of glass. Just a dull *thud*.

Page not found:
Grab my headphones. Drown the voice out.

Habis page 2, page 2 lagi:
Press my ear to the phone. Listen for breathing.

Parent page 2:
019e071e-62fa-7019-a2de-e5edb056098b
    "destination": {
      "pageId": "019e07d4-34cd-723e-ae41-9ec6feae6ce1",
      "branchId": "019e07d4-34cd-723e-ae41-98de672ad0b4"
    }





TODO:
[ ] Stripe switch to live
[ ] type validation using https://typia.io/
[ ] search jaccard, need change to cursor pagination?
[ ] Enhanced search (jaccard by book keywords & title)
[ ] user: you might like (based on liked books)
[ ] user preferences schema (interests)
[ ] display running summary at the end of story (N% readers ended up here)
[ ] Implement belief
[ ] Implement corruption curve

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
