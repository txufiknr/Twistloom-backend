---
name: branch-safety-review
description: >-
  Verify branch isolation in state reconstruction, snapshots, deltas,
  page persistence, candidate generation, and caching.
  Use before merging changes to story state code.
metadata:
  author: twistloom
  version: "1.0"
---

# Branch Safety Review Skill

## Trigger
- Any change touching branch traversal or state reconstruction
- Pre-merge review of story state changes
- Candidate generation changes

## Procedure

1. **Branch Boundary Check**
   - Identify all branch-aware code paths.
   - Verify each path produces branch-isolated results.
   - Check for shared mutable state across branches.

2. **State Leakage Detection**
   - Verify no branch ID leaks into unrelated timelines.
   - Check cache keys include branch identifiers.
   - Verify pgvector queries are branch-scoped where needed.

3. **Concurrent Branch Safety**
   - Verify concurrent reads/writes to different branches don't interfere.
   - Check distributed locking is branch-aware.
   - Verify idempotency of branch operations.

4. **Report**
   - List findings with file:line references.
   - Categorize as Critical / Warning / Suggestion.
