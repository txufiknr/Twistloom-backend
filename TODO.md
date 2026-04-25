[x] group github action prompt logs
[x] Page text format: can multiple line
[x] email templates
[x] GET books twistloom original filter yg ada cover image aja
[x] Visit page: trigger pre-generate yg belum
[x] Github action cron pre-generate candidate yg belum lengkap
[x] Hide genai original error
[x] Fix error pre-generate page candidate
[x] Fix error imagen, harusnya fallback next model/provider
[x] Github action env: redis api key

TODO:
[ ] Enhanced search (jaccard by book keywords & title)
[ ] similar books: jina embedding
[ ] user preferences schema (interests)
[ ] user settings schema (font size)
[ ] summary at the end of story (N readers ended up here)

paid:
[ ] custom action prompt (max 50 chars, prevent sql inject, etc)
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
- Fully connected graph (places connection, characters connection, place-character connection)





I'd like to see your designs proposal for:

“Action Diversity Validator”
“Narrative Hook Detector”

Branch locking system (prevents illegal jumps)
“Golden path” vs “corrupted path” tracking
Replay system with alternate timeline comparison
