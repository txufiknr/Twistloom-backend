[@] /api/payments/create-checkout-session 401 unauthorized
[@] Reader reach kok 0%
[@] Investigate: Kenapa on-demand github workflow nggak ke trigger
[ ] Infer desired ending if provided in theme input: if user mention anything about desired ending in theme input, use it for viableEnding
[ ] cron: auto translate page ke indo
[ ] Lru cache trending books page 1 for 2 minute
[ ] Page 1 selected actions masih none
[ ] Originals: Mc name predefine casts aja, jangan AI
[ ] Candidate pregeneration prioritize yang existing pagesnya dikit
[ ] Important objects perlu disimpen di story state?
[ ] Important objects perlu prop tambahan: trait (custom fields: color, battery-level), rules (custom string array), status (broken, missing)? 
[ ] Stripe switch to live
[ ] search jaccard, need change to cursor pagination?
[ ] Enhanced search (jaccard by book keywords & title)
[ ] user: you might like (based on liked books)
[ ] userSettings schema (interests, text size, email notification settings)
[ ] Implement belief
[ ] Implement corruption curve
[x] GET /books query param ageRange (n-m), gender (male/female), language (en, etc)
[x] user add 'tier'
[ ] docs: stripe VIP subscription
[ ] VIP benefits:
    - VIP badge
    - triple check-in bonus
    - +50 credits every month (on activation & renewal)

[ReaderPageClient] 🔄 Generating candidates... {originalActionsCount: 3, currentActionsCount: 0, pageId: '019e1bec-3210-749a-95fe-9efe2f510ece'}
debug.ts:23 [generateCandidatesWithPolling] 🚪 Existing in-flight request found for red-glitch-019e1bec-3210-749a-95fe-9efe2f510ece-polling, returning existing promise
debug.ts:23 [api] 🌐 No response received from server: XMLHttpRequest {onreadystatechange: null, readyState: 0, timeout: 0, withCredentials: true, upload: XMLHttpRequestUpload, …}
2debug.ts:23 [ReaderPageClient] 🛑 Polling aborted
ReaderPageClient.tsx:586 [ReaderPageClient] 📖 Rendering page: {page: {…}, book: {…}}
ReaderPageClient.tsx:589 [ReaderPageClient] 👉 isBackwardNavigation: false
ReaderPageClient.tsx:590 [ReaderPageClient] 👉 isPageVisited: false
ReaderPageClient.tsx:586 [ReaderPageClient] 📖 Rendering page: {page: {…}, book: {…}}
ReaderPageClient.tsx:589 [ReaderPageClient] 👉 isBackwardNavigation: false
ReaderPageClient.tsx:590 [ReaderPageClient] 👉 isPageVisited: false
debug.ts:23 [StoryText] isTypewriterPlaying: false
debug.ts:23 [StoryText] selectedActions: []
debug.ts:23 [StoryText] shouldDisplayTranslation: false
debug.ts:23 [StoryText] isShowingOriginal: false
debug.ts:23 [StoryText] isTypewriterPlaying: false
debug.ts:23 [StoryText] selectedActions: []
debug.ts:23 [StoryText] shouldDisplayTranslation: false
debug.ts:23 [StoryText] isShowingOriginal: false
debug.ts:23 [ReaderPageClient] 🔄 Generating candidates... {originalActionsCount: 3, currentActionsCount: 0, pageId: '019e1bec-3210-749a-95fe-9efe2f510ece'}

at the end of story:
[ ] display contextHistory at the end of story (N% readers ended up here)
[ ] you might like (similar books)

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
