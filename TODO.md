[x] heuristic theme validator bug: surprise4.txt
[x] If no action needed or viable, give only 1 action to continue
[x] Clear orphaned user exclude system user
[x] Benerin format user prompt next page

[ ] character state: Injury detail
[ ] prompt: tampilin inventory, injury
[ ] Implement stripe
[ ] Story state simpen selected actions aja (+page numbers) 
[ ] Pages: Actions kosong
[ ] Cron: generate cover image originals
[ ] Cron: detect pages yg action object kosong, generate
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


[generateCandidatePage] ❌ Failed to generate candidate page: {
  error: 'characterUpdates.newCharacters is not iterable',
  userId: '***',
  pageId: '019dc93a-8603-7458-a77a-7f142cc336df',
  actionText: 'Burn the note. Bury the locket pieces. Pretend this never happened.'
}

[generateCandidatePage] ❌ Failed to generate candidate page: {
  error: 'characterUpdates.updatedCharacters is not iterable',

[generateCandidatePage] ❌ Failed to generate candidate page: {
  error: "Cannot read properties of undefined (reading 'text')",
  userId: '019dbee5-6771-704d-88b0-9cd2f6f1039d',
  pageId: '019dc3db-d0de-76f5-94b6-62f2cefdff28',
  actionText: undefined
}

TODO:
[ ] cron: fix empty actions
[ ] cron: generate cover image original
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
