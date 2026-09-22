---
name: critique-workflow
description: >-
  Rigorous critique and refinement workflow for code changes, architecture
  docs, and roadmap docs. Finds bugs, issues, inefficiencies, regression
  risks, DRY/SSOT violations, and industry standard deviations.
  Assesses each finding as real issue or false positive, then proposes
  best approaches to address all real issues.
metadata:
  author: twistloom
  version: "1.0"
---

# Critique Workflow Skill

## Trigger
- User requests rigorous audit of committed changes
- User requests audit of new roadmap/architecture MD doc
- User provides review result for assessment
- Pre-merge quality gate

## Workflow

### Phase 1: Rigorous Critique

When auditing committed changes or new docs:

1. **Code Quality Scan** — Search for `any` types, unsafe casts, hardcoded strings, duplicated logic, missing cleanup, stale closure risks.
2. **Architecture Compliance** — Verify `executeWithCredits` usage, provider abstraction, `.js` imports, `AppEnv` typing, error helpers, sanitization.
3. **Performance Check** — Search for unnecessary DB/AI calls, missing memoization, N+1 queries, missing cache invalidation.
4. **Security Check** — Search for exposed secrets, missing input validation, unsafe user input handling.
5. **Regression Risk** — Identify changes that could break existing behavior. Check missing error handling. Verify backward compatibility.

### Phase 2: Assessment (When Review Result Provided)

1. **Issue Triage** — For each finding: verify the claim against actual codebase. Assess if it's a real issue or false positive.
2. **Classification** — Real Issue / False Positive / Debatable.
3. **Prioritization** — By Impact, Risk, Effort.

### Phase 3: Refinement Proposals

For each real issue, propose:
1. **Best Approach** — Optimal fix aligned with existing patterns.
2. **Alternative Approaches** — Other valid ways with pros/cons.
3. **Recommended Action** — Which to take and why.
4. **Documentation Impact** — Which docs need updating.

### Phase 4: Report

Provide structured report:
- Summary (total findings, real issues, false positives, debatable)
- Real Issues (prioritized with fix recommendations)
- False Positives (with reasoning)
- Debatable Items (with recommendation)
- Documentation Updates Needed
