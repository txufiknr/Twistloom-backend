[ ] Page 1 selected actions masih none
[ ] Stripe switch to live
[ ] Implement belief
[ ] Implement corruption curve
[ ] tampilin AI comment di route books: /async & /status

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
