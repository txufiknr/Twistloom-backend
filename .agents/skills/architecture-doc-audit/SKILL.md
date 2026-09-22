---
name: architecture-doc-audit
description: >-
  Rigorously audit architecture MD documents for comprehensiveness,
  correctness, and alignment with actual codebase implementation.
metadata:
  author: twistloom
  version: "1.0"
---

# Architecture Document Audit Skill

## Trigger
- New architecture MD created
- Existing architecture MD updated
- Pre-merge review of architecture changes

## Procedure

### Phase 1: Structural Completeness
1. Verify document follows canonical architecture MD structure.
2. Check for required sections: Problem Statement, Design, Implementation, File References.
3. Verify Mermaid diagrams are present where claimed.

### Phase 2: Codebase Accuracy
4. For every pattern described, verify the pattern exists in the actual codebase.
5. For every TypeScript type/interface mentioned, verify it exists.
6. For every flow described, trace the actual code path.
7. For every library/utility mentioned, verify it's still in package.json.

### Phase 3: Best Practice Alignment
8. Verify doc aligns with AGENTS.md architectural invariants.
9. Search doc for recommended patterns that are anti-patterns in codebase.
10. Compare doc's scope against actual implementation scope.

### Phase 4: Report
11. List all findings with doc file:line and codebase file:line.
12. Categorize as Critical / Major / Minor / Suggestion.
13. Provide specific fix recommendations and overall accuracy score.
