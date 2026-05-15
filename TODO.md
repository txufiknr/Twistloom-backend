[ ] check triggerBackgroundGeneration immediate atau engga, check level 2 depth di pre generation docs
[ ] recheck ${vercelUrl}/api/generate-candidates API implementation
[ ] consider tambah method generate candidate via on-demand github workflow (input page id), lock pake isGeneratingStartedAt
[ ] EnrichedBookData add `firstPageText`
[ ] choice made ensure nggak return enriched page data

// Status 400 (dns:0.10000000055879354ms,tcp:70.70000000018626ms,req:31.90000000037253ms,res:997.6999999992549ms)
{
  "error": "Choice made, can't make another choice",
  "message": "You already chose a different action on this page"
}

[ ] Consolidate like & save (like bisa save ke collection)
[ ] generate next page / insert page: prevent actions kosong
[ ] Cron: detect pages yg action object kosong, generate
[ ] Originals: Mc name predefine aja, jangan AI
[ ] User settings api: text size
[ ] Candidate pregeneration prioritize yang existing pagesnya dikit
[ ] Important objects perlu disimpen di story state?
[ ] Important objects perlu prop tambahan (trait, rules, color, battery)? 

[GET /candidates/status] 🚀 Fired background generation for page 019e169c-0533-7748-a11a-2c6651b8067c (user: 019e1b4d-09f8-70ff-aae0-40d2f76f776f, book: 019e1655-bd46-7440-950d-5f483e741fc3)

TODO:
[ ] Stripe switch to live
[ ] type validation using https://typia.io/
[ ] search jaccard, need change to cursor pagination?
[ ] Enhanced search (jaccard by book keywords & title)
[ ] user: you might like (based on liked books)
[ ] user preferences schema (interests)
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
