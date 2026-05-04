[x] book api route :slug/:pageId
[x] visit page: update selectedAction
[x] get page: include selectedAction
[x] implement libretranslate: pageId, lang (bcp)
[x] api: receive Accept-Language
[x] get page: accept lang header > translate if different with book langauge
[x] initialize book: consume 5 credits
[x] get page ensure include selectedAction?: Action;
[ ] config: MAX_BRANCHING_PREGENERATION_DEPTH = 2;
[ ] Consolidate like & save (like bisa save ke collection)
[ ] generate next page / insert page: prevent actions kosong
[ ] Cron: detect pages yg action object kosong, generate
[ ] Retry pending generation kalo udah stable bikin paralel
[ ] Original: kalau "en", Mc name predefine aja, jangan AI
[ ] book stats: already in table (via trigger)
[ ] book stats: completedCount
[ ] book read count: only count unique user
[ ] trigger: ensureBookIncrementTrigger (complete, read, like, favorite)
[ ] books: GET route support filter lastUpdated (apa aja?)
[ ] payment: buy credits pack

story state:
[ ] story state: is it really need `maxPage`?
[ ] Don't output viableEnding if unchanged

TODO:
[ ] Stripe switch to live
[ ] type validation using https://typia.io/
[ ] search jaccard, need change to cursor pagination?
[ ] Enhanced search (jaccard by book keywords & title)
[ ] user: you might like (based on liked books)
[ ] user preferences schema (interests)
[ ] user settings schema (font size)
[ ] display running summary at the end of story (N% readers ended up here)
[ ] Implement belief
[ ] Implement corruption curve
[ ] Sound effect format italic with asterisks

by book creator:
[ ] soundtrack based on mood
[ ] add page image
[ ] add voice or use noiz tts api

paid:
[ ] custom action prompt (max 50 chars, prevent sql inject, etc)
[ ] re-select other action in previous page
[ ] generate cover image with AI
[ ] see hint for an action
[ ] use noiz tts api

Story meta
visualStyle = "dark cinematic, moody lighting, realistic horror, muted tones"
corruptionCurve: number[]
Hints/secret dark facts (don't reveal, it may or never known by MC)


Starting a sentence with a coordinating conjunction (such as or, and, or but) is a stylistic choice rather than a grammatical error. 


implement Heuristic first book/story page validator

Book meta prompt cache LRU aja

Cek userpageprogress.previouspageid udah diset ketika backtoprevouspage & chooseaction

Route Validate:
- bookId is current active session
- universeId is in current bookId
- pageId is in current universeId
- Selected action match with pageId (if not custom)

Conditional prompt
Boost image importance score when new place is discovered.

Output:
Image prompt
Image importance score

At initialize book:
- Fully connected graph (places connection, characters connection, place-character connection)





I'd like to see your designs proposal for:

“Action Diversity Validator”
“Narrative Hook Detector”

Branch locking system (prevents illegal jumps)
“Golden path” vs “corrupted path” tracking
Replay system with alternate timeline comparison
