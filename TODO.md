[ ] similar books: jina embedding
[ ] user preferences schema (interests)
[ ] user settings schema (font size)
[ ] summary at the end of story (N readers ended up here)

paid:
[ ] custom action prompt (max 50 chars)
[ ] re-select other action in previous page
[ ] generate cover image with AI
[ ] see hint for an action


Place knownCharacters: Make page multiple
Implement belief & thread

Starting a sentence with a coordinating conjunction (such as or, and, or but) is a stylistic choice rather than a grammatical error. 

Sound effect format italic with asterisks

implement Heuristic first book/story page validator

Book meta prompt cache LRU aja

check & implement corruption curve

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
- Generate initial 2 places & 2 characters (beside MC) (bikin const initial total) 
- Fully connected graph (places connection, characters connection, place-character connection)





I'd like to see your designs proposal for:

“First Page Quality Scorer” (auto-reject weak generations)
“Action Diversity Validator”
“Narrative Hook Detector”

Branch locking system (prevents illegal jumps)
“Golden path” vs “corrupted path” tracking
Replay system with alternate timeline comparison
