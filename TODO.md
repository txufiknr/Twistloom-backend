[ ] character state: Injury detail
[ ] prompt: tampilin injury
[ ] Pages: Actions kosong
[ ] Cron: detect pages yg action object kosong, generate
[ ] migrate user auth (orphaned user) to db transaction
[ ] migrate candidate page pregeneration concurency lock to db transaction

[x] Implement stripe
[x] Story state: actionHistory tambah page number 
[x] heuristic theme validator bug: surprise4.txt
[x] If no action needed or viable, give only 1 action to continue
[x] Clear orphaned user exclude system user
[x] Benerin format user prompt next page
[x] Cron: generate cover image originals
[x] Inventory: string[] what MC bring & where
[x] Page generation instructions: page.text: start with "I choose to"
[x] Page generation: running summary (+), page summary bullet points (+), inventory update (+) 
[x] Story state: previous pages (-), running summary (+), inventory (+) 
[x] Sesuaiin lagi delta & snapshot
[x] Cron: update trending score log summary
[x] Buildnextpage sekalian generate summary di json
[x] Hapus summarizeStoryContext
[x] Kayanya page history ngga harus dari state, bisa include di enrich page (track parentid, ngga usah selected action)
[x] Ensure last page ngga ada instruksi branching actions
[x] Prompt system WRITING STYLE: tambah blocklist
[x] Prompt task: must continue from selected action
[x] Prompt "MC" ganti "I": First-person POV ("I")
[x] Replace double philcrow symbol (¶  ¶ ) 
[x] PREVIOUS PAGES: & PREVIOUS PAGE: sama
[x] Cron: predetermine id page yg mau dicomplete (prioritized by most trending books) 
[x] Kayanya di dalem buildnextpage gaperlu pregenerate lagi
[x] Pregenerate pending pake concurrency lock biar gak dobel sama trigger dari visit
[x] Pregenerate ensure 1 level aja
[x] Block di generate summary: The protagonist, The narrator
[x] Pastiin imagen & pregenerate page console log
[x] Github secret include semua AI api keys

TODO:
[ ] search jaccard, need change to cursor pagination?
[ ] Enhanced search (jaccard by book keywords & title)
[ ] similar books: jina embedding
[ ] user preferences schema (interests)
[ ] user settings schema (font size)
[ ] summary at the end of story (N% readers ended up here)

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
