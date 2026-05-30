[ ] Page 1 selected actions masih none
[ ] Stripe switch to live
[ ] Implement belief
[ ] Implement corruption curve
[ ] Kalau source action belum ada, insert dulu page progress parent page
[ ] create paid book (vip with 500 followers, 30 days-old account, email verified, has published 50 books) -> pay as much as the book price -> book promoted
[ ] POST /user/comments - deprecated
[x] first purchase → +50 credits
[x] make `aiStreamSSE` return provider & model
[ ] isGeneratingStartedAt -> lastGenerationHeartbeatAt (no heartbeat for X minutes)
[ ] review claude: payment route
[ ] review claude: story branch (getStoryStateWithBranch)
[ ] write CLAUDE.md based on README.md & AGENTS.md
[x] prompt: update amount to 0 to remove inventory
[x] applyStateDelta: remove inventory which has amount of 0

{
  "flagUpdates": [
    { "flag_type": "fear", "level": "High" }
  ]
}


db/schema.ts
services/story.ts
services/story-branch.ts
utils/branch-traversal.ts
utils/story.ts
types/story.ts

please thoroughly examine these files, especially `getStoryState` and `getStoryStateWithBranch` function for reconstructing story state for given `pageId` (and `bookId`)

recently, I found this duplicate plot flags issue on reconstructed story state:
regarding this, I think you can also investigate and review on `applyStateDelta` and `advanceStoryState` function

```
PLOT FLAGS:
  • Page 1 [mystery_started]: Riley witnesses the town’s first impossible phenomena: a backward-ticking clock and Liam’s note.
  • Page 2 [threat_identified]: Riley receives a warning message from an unknown source while in the fog, implying external awareness of her actions.
  • Page 2 [threat_identified]: Riley receives a warning message from an unknown source while in the fog, implying external awareness of her actions.
  • Page 3 [threat_identified]: The fog is not just alive—it communicates through stolen voices and physical manipulation, suggesting intelligence and malice.
  • Page 3 [threat_identified]: The fog is not just alive—it communicates through stolen voices and physical manipulation, suggesting intelligence and malice.
  • Page 4 [threat_identified]: The fog is not only sentient but capable of mimicking voices with malicious intent, suggesting it has absorbed or consumed something—or someone—familiar to Riley.
```

can you evaluate about correctness and optimality, and finally provide me comprehensive review and complete corrected code?


story state & delta changes:
[ ] plot flag buat "keyed" (PermanentMemory)
[ ] future notes: addedAtPage N & targetPhase (desired phase to reveal/incorporate) -> sort by targetPhase ASC

[ ] userSettings schema
- interests: string[]
- email notification settings

[ ] enhance book explore:
- fuzzy search/Levenshtein (typo) // does postgresql has this built-in?
- search jaccard similarity (by book keywords & title)
- need change to cursor pagination?

[ensureCandidatesForPageWithStrategy] ⚠️ All actions are invalid, replaced with 1 continue action.
https://github.com/txufiknr/Twistloom-backend/actions/runs/26221075235/job/77155911594

future:
[ ] initialize book: auto-generate MC picture (AI-generated image)

by book creator:
[ ] soundtrack based on mood
[ ] add character image
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
