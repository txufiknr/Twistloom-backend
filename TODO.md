[x] ensure get /:pageId booknya include author & firstPageId
[x] enriched book lastPage (from latest userPageProgress)
[x] ensure book slug not same as preserved endpoints: stats, explore
[x] consolidate get page & page visit
[ ] apakah get /user ada `isGuest`?
[ ] config: MAX_BRANCHING_PREGENERATION_DEPTH = 2;
[ ] Consolidate like & save (like bisa save ke collection)
[ ] generate next page / insert page: prevent actions kosong
[ ] Cron: detect pages yg action object kosong, generate
[ ] Retry pending generation kalo udah stable bikin paralel
[ ] Original: kalau "en", Mc name predefine aja, jangan AI
[ ] User settings api: text size

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
