[ ] Page 1 selected actions masih none
[ ] Stripe switch to live
[ ] Implement belief
[ ] Implement corruption curve
[ ] Userbookcomplete tambah context summary
[ ] Schema userActionHints (userId, pageId, actionText)
[ ] GET page juga join userActionHints
[ ] GET /api/books/truth-found-me/019e5e1e-dac1-75ac-9887-f3d3db721e21/candidates/status (401) 

`GET /api/user` error after successfully signed in with Google (Auth.js v5):
[verifyNextAuthToken] ❌ Failed to update user profile: DrizzleQueryError: Failed query: update "users" set "name" = $1, "image" = $2, "last_active" = $3, "updated_at" = $4 where "users"."user_id" = $5
params: Taufik Nur Rahmanda,https://lh3.googleusercontent.com/a/ACg8ocLdHE67YiJ1nP4efZrBmAkuHjrGblF-RpH35xLWT8ijJBwGKQmrIQ=s96-c,2026-05-25T09:12:24.556Z,2026-05-25T09:12:24.556Z,019e5db4-8ff1-767d-8a03-58356c042083
    at NeonPreparedQuery.queryWithCache (file:///var/task/node_modules/drizzle-orm/pg-core/session.js:41:15)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
    at async NeonPreparedQuery.execute (file:///var/task/node_modules/drizzle-orm/neon-serverless/session.js:105:14)
    at async createOrUpdateOAuthUser (/vercel/path0/src/services/user-controller.ts:134:5) {
  query: 'update "users" set "name" = $1, "image" = $2, "last_active" = $3, "updated_at" = $4 where "users"."user_id" = $5',
  params: [
    'Taufik Nur Rahmanda',
    'https://lh3.googleusercontent.com/a/ACg8ocLdHE67YiJ1nP4efZrBmAkuHjrGblF-RpH35xLWT8ijJBwGKQmrIQ=s96-c',
    '2026-05-25T09:12:24.556Z',
    '2026-05-25T09:12:24.556Z',
    '019e5db4-8ff1-767d-8a03-58356c042083'
  ],
  cause: ErrorEvent {
    type: 'error',
    defaultPrevented: false,
    cancelable: false,
    timeStamp: 248105.361196
  }
}

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

[cohere] 💥 Model command-r-08-2024 failed, trying next model: INVALID_SCHEMA
[cohere] ❌ All models failed: INVALID_SCHEMA

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
