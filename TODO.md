[ ] generate next page / insert page: prevent actions kosong
[ ] Cron: detect pages yg action object kosong, generate
[ ] prompt: ensure thread update instruction/format exist
[ ] Retry pending generation kalo udah stable bikin paralel
[ ] Original: kalau "en", Mc name predefine aja, jangan AI
[ ] Sse can we make generating event ends when evaluating starts
[ ] Update docs pre generation
[ ] Update docs branch traversal, snapshot, delta

TODO:
[ ] type validation using https://typia.io/
[ ] search jaccard, need change to cursor pagination?
[ ] Enhanced search (jaccard by book keywords & title)
[ ] similar books: jina embedding
[ ] user preferences schema (interests)
[ ] user settings schema (font size)
[ ] summary at the end of story (N% readers ended up here)
[ ] Place knownCharacters: Make page multiple
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
