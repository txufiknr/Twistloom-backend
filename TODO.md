[@] /api/payments/create-checkout-session 401 unauthorized
[@] Reader reach kok 0%
[@] Investigate: Kenapa on-demand github workflow nggak ke trigger
[ ] cron: auto translate book & page ke indo ('id') using AI (where `providerType` not 'ai')
[ ] Page 1 selected actions masih none
[ ] Originals: Mc name predefine casts aja, jangan AI
[ ] Candidate pregeneration prioritize yang existing pagesnya dikit
[ ] Important objects perlu disimpen di story state?
[ ] Important objects perlu prop tambahan: trait (custom fields: color, battery-level), rules (custom string array), status (broken, missing)? 
[ ] Stripe switch to live
[ ] search jaccard, need change to cursor pagination?
[ ] Enhanced search (jaccard by book keywords & title)
[ ] GET /user/recommendations: you might like (based on liked books)
[ ] userSettings schema (interests, text size, email notification settings)
[ ] Implement belief
[ ] Implement corruption curve
[x] visitor percentage page 1 should always 100%
[x] docs: stripe VIP subscription
[ ] VIP benefits:
    - VIP badge
    - triple check-in bonus
    - +50 credits every month (on activation & renewal)


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
