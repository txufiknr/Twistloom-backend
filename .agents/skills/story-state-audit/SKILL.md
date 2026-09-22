---
name: story-state-audit
description: >-
  Audit story state management for branch isolation violations, state
  reconstruction errors, BookMode contract breaches, and cache staleness.
  Use when investigating story bugs or verifying state correctness.
metadata:
  author: twistloom
  version: "1.0"
---

# Story State Audit Skill

## Trigger
- Story bug investigation
- Pre-release story state verification
- Branch isolation concern

## Procedure

1. **State Ownership Trace**
   - Identify all sources of story state (structured DB, cache, prose, pgvector).
   - Verify structured state is authoritative over prose-derived state.
   - Check cache entries are optimization, never canonical.

2. **Branch Isolation Check**
   - Verify no state leaks between unrelated branches.
   - Check branch traversal produces deterministic results.
   - Verify snapshot/delta reconstruction is branch-safe.

3. **BookMode Contract Verification**
   - Verify Novel mode: one action, one destination.
   - Verify Interactive mode: multiple actions, one destination each.
   - Verify Multiverse mode: multiple actions, multiple candidate realities.
   - Check no mode semantics are collapsed or normalized.

4. **Reconstruction Correctness**
   - Verify deterministic replay from checkpoints + deltas.
   - Check snapshot compatibility across versions.
   - Verify ordered delta application.
   - Confirm semantic memory is not part of reconstruction.

5. **Report**
   - List findings with file:line references.
   - Categorize as Critical / Warning / Suggestion.
   - Provide fix recommendations.
