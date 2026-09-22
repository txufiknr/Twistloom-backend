---
name: doc-sync-audit
description: >-
  Detect documentation drift by comparing architecture/roadmap MD files
  against actual codebase implementation. Use after code changes to identify
  docs that need updating.
metadata:
  author: twistloom
  version: "1.0"
---

# Documentation Sync Audit Skill

## Trigger
- After code changes are pushed
- Before merging PRs that modify core architecture
- Periodic documentation health check

## Procedure

1. **Identify Affected Documentation**
   - For each changed source file, find architecture/roadmap MDs that reference it.
   - Cross-reference with git diff to identify docs referencing changed files.

2. **Verify File References**
   - For each file path referenced in a doc, verify the file exists at that path.
   - Check for renamed/moved files.
   - Check for deleted files still referenced.

3. **Verify Code Pattern Claims**
   - If a doc claims "use X pattern for Y", verify X pattern exists in codebase.
   - If a doc lists "these components handle Z", verify those components exist.
   - If a doc references a specific function/hook, verify it exists and is exported.

4. **Verify API Contract Claims**
   - If a doc documents API response shapes, verify against actual service classes.

5. **Report**
   - List stale references with doc file:line and actual file:line.
   - Categorize as Stale / Inaccurate / Incomplete / Outdated.
   - Provide specific update recommendations.
