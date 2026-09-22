---
name: canon-validation-review
description: >-
  Audit canon validation for correctness, fail-open behavior preservation,
  and proper separation between engine validation and AI-assisted evaluation.
metadata:
  author: twistloom
  version: "1.0"
---

# Canon Validation Review Skill

## Trigger
- Changes to canon validation logic
- Pre-release verification of narrative consistency
- Recovery/rewrite behavior changes

## Procedure

1. **Engine vs AI Separation**
   - Verify deterministic engine validation is separate from AI-assisted evaluation.
   - Check canon evaluator does not own structured application state.
   - Verify generation/evaluation separation.

2. **Fail-Open Behavior**
   - Verify canon validation preserves existing fail-open semantics.
   - Check that validation failures don't block narrative progression.
   - Verify recovery/rewrite paths are functional.

3. **State Consistency**
   - Verify canon checks validate against structured state, not prose.
   - Check that canon corrections update structured state correctly.
   - Verify no circular dependencies between canon and state.

4. **Report**
   - List findings with file:line references.
   - Categorize as Critical / Warning / Suggestion.
