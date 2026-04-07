[ ] similar books: jina embedding
[ ] user preferences schema (interests)
[ ] user settings schema (font size)
[ ] summary at the end of story (N readers ended up here)
[ ] imagePrompt & imageImportance -> only provide "imagePrompt" when "imageImportance" >=2
[ ] limit characters to 6 maximum
[ ] complete character list in prompt

[x] fix duplicate shouldCreateSnapshot function
[x] fix duplicate StateSnapshot and StateDelta type definitions
[x] ensure state-reconstruction.ts error-free & properly typed
[x] ensure deltas.ts error-free & properly typed
[x] dialogue action & verb action
[ ] story meta (characters, setting, place hints)
[ ] story page (scene, image prompt, image importance)

I'd like to see your designs proposal for:

“First Page Quality Scorer” (auto-reject weak generations)
“Action Diversity Validator”
“Narrative Hook Detector”

Branch locking system (prevents illegal jumps)
“Golden path” vs “corrupted path” tracking
Replay system with alternate timeline comparison

paid:
[ ] custom action prompt (max 50 chars)
[ ] re-select other action in previous page
[ ] generate cover image with AI
[ ] see hint for an action

getUserProgress(userId, bookId, branchId)

function createBranch({
  userId,
  bookId,
  fromPageId,
  newActionId
}) {
  const newBranchId = generateBranchId()

  // copy history up to this page
  const history = getProgressUntilPage(userId, bookId, fromPageId)

  for (const row of history) {
    db.userPageProgress.create({
      ...row,
      branchId: newBranchId
    })
  }

  // apply new choice
  chooseAction({
    userId,
    bookId,
    pageId: fromPageId,
    actionId: newActionId,
    branchId: newBranchId
  })
}
