[ ] Page 1 selected actions masih none
[ ] Stripe switch to live
[ ] Implement belief
[ ] Implement corruption curve
[x] GET /api/user/favorites (401)

[ ] GET candidates/status meskipun no userId, tetep trigger generation workflow

export interface CreateBookResponse {
  book: Book;
  firstPage: Page | null;
  initialState: InitialState | null;
  aiComment: string | null;
}

Dobel
[retryPendingGenerations] 📋 Found 3 pages with pending generations
[retryPendingGenerations] 🔄 Processing page 019e5fb6-5d67-7093-b55f-6dc137b130e6 (pending: 3)
[retryPendingGenerations] 🔄 Processing page 019e5fb6-5d67-7093-b55f-6dc137b130e6 (pending: 3)
[retryPendingGenerations] 🔄 Processing page 019e5fb7-7028-724a-92a2-28a03671db8f (pending: 3)
[retryPendingGenerations] 🔄 Processing page 019e5fb7-7028-724a-92a2-28a03671db8f (pending: 3)

Tambah branchId
[generateCandidatePage] 📖 Should generate candidates for "Truth Found Me" page 5
[generateCandidatesInParallel] ⏩ Skipped, let GitHub Workflow do it via the hourly job: {
  bookTitle: 'Truth Found Me',
  depth: '2/2',
  pageId: '019e6642-f413-750f-8a47-875d7c140a66',
  pageNumber: 5
}

Book creation: futureNotes: string[] (important notes that stated in theme input for future AI turns that not included in current turn: initial states, place, or characters)
futureNotes : remove which done or not viable
Prompt name: use diverse, unusual names
Get page: Tambah query param is actually take action
Kalau source action belum ada, insert dulu page progress parent page
Get page: tetep return visitDetails as is tanpa perlu userId

Add name:
Elena
Olivia
Amelia
Luna
Lyra
Aria
Seraphina
Lucien
Katniss
Hermione

Nova
Kael
Orion

[ ] userSettings schema
- interests: string[]
- email notification settings

[ ] enhance book explore:
- fuzzy search/Levenshtein (typo) // does postgresql has this built-in?
- search jaccard similarity (by book keywords & title)
- need change to cursor pagination?

[x] trigger read_count masih ngaco, visit_count udah bener 1
[x] visitor percentage page 1 should always 100%
[x] Github workflow Dynamic job name (book title)
[x] Non retryable error kok dipertanyakan? 
[x] book explore: filter by age range error

[ensureCandidatesForPageWithStrategy] ⚠️ All actions are invalid, replaced with 1 continue action.
https://github.com/txufiknr/Twistloom-backend/actions/runs/26221075235/job/77155911594

by book creator:
[ ] soundtrack based on mood
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
