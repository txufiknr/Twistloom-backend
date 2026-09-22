---
name: roadmap-doc-audit
description: >-
  Rigorously audit roadmap MD documents for comprehensiveness,
  correctness, feasibility, and alignment with actual codebase.
metadata:
  author: twistloom
  version: "1.0"
---

# Roadmap Document Audit Skill

## Trigger
- New roadmap MD created
- Existing roadmap MD updated
- Pre-merge review of roadmap changes

## Procedure

### Phase 1: Structural Completeness
1. Verify document follows Twistloom canonical roadmap format.
2. Check for: Summary Table, Problem Statement, Design & Rationale, Feasibility, Mermaid Diagram, Implementation Plan, Open Questions, References, Completion Status.
3. Verify status emojis are consistent across sections.

### Phase 2: Codebase Accuracy
4. Verify "Current State" claims match actual codebase.
5. Verify cited files/line numbers exist and contain claimed content.
6. For each step's file references, verify files exist.
7. Verify effort estimates against actual codebase complexity.

### Phase 3: Best Practice Alignment
8. Verify roadmap aligns with AGENTS.md architectural invariants.
9. Verify P0 items are genuinely critical.
10. Verify no critical questions are missing.

### Phase 4: Report
11. List all findings with doc file:line.
12. Categorize as Critical / Major / Minor / Suggestion.
13. Provide overall quality score.
