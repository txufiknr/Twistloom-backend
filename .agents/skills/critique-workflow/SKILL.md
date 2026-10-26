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

> **Authoritative Evaluation Rubric**: All code critiques and reviews conducted by this skill are governed by [`REVIEW.md`](file:///d:/Projects/Twistloom/Twistloom-backend/REVIEW.md). Reviewers must adhere to the high-signal mandate, evidence standards, severity taxonomy, and anti-pattern radar defined therein.

## Trigger
- User requests rigorous audit of committed changes
- User requests audit of new roadmap/architecture MD doc
- User provides review result for assessment
- Pre-merge quality gate

## Workflow

### Phase 1: Rigorous Critique (Governed by `REVIEW.md §3` Anti-Pattern Radar)

When auditing committed changes or new docs:

1. **Anti-Pattern Radar Check (`REVIEW.md §3`)**:
   - HTTP/Routing: Consumed stream clone traps (`c.req.raw.clone().json()`), accidental route deletion/shadowing in large routers, and cross-client contract breaks.
   - Financial/Credits: `executeWithCredits` row locks, decoupling non-critical side effects (notifications, emails) from financial transactions, and refund idempotency.
   - Database/Batching: Parameter wire limits ($rows \times columns \le 60,000$), Keyset Cursor pagination over `OFFSET`, and anti-lock chunked deletes (`src/utils/batch.ts`).
   - Concurrency: Phantom notifications after rapid toggle actions, and atomic batch claim race conditions.
2. **Code Quality Scan** — Search for `any` types, unsafe casts, hardcoded strings, duplicated logic, missing cleanup, stale closure risks.
3. **Architecture Compliance** — Verify `executeWithCredits` usage, provider abstraction, `.js` imports, `AppEnv` typing, error helpers, sanitization.
4. **Performance Check** — Search for unnecessary DB/AI calls, missing memoization, N+1 queries, missing cache invalidation.
5. **Security Check** — Search for exposed secrets, missing input validation, unsafe user input handling.
6. **Regression Risk** — Identify changes that could break existing behavior. Check missing error handling. Verify backward compatibility.

### Phase 2: Assessment & Evidence Verification (`REVIEW.md §1 & §2`)

1. **Issue Triage & Concrete Execution Path (`REVIEW.md §1.2`)**:
   - For each finding, verify the claim against the actual codebase.
   - Require proof: `Trigger` → `Execution Trace` → `Concrete Failure` → `Production Impact`.
   - Reject speculative or hypothetical edge cases as False Positives.
2. **Classification & Severity (`REVIEW.md §2`)**:
   - Critical / High (Block Merge: functional regression, stream failure, broken contract).
   - Medium (Proceed with caution; Block Deploy if database migration or operational prerequisite unapplied).
   - Low (Informational / polish).
3. **Prioritization** — By Impact, Risk, Effort.

### Phase 3: Refinement Proposals

For each real issue, propose:
1. **Best Approach** — Optimal fix aligned with existing patterns.
2. **Alternative Approaches** — Other valid ways with pros/cons.
3. **Recommended Action** — Which to take and why.
4. **Documentation Impact** — Which docs need updating.

### Phase 4: Report (`REVIEW.md §4`)

Provide structured report adhering to the standardized schema in `REVIEW.md §4`:
- **Executive Assessment**: Verdict (Block Merge / Block Deploy / Approve with Notes / Approve Clean), Summary, Finding Counts.
- **Positive Highlights (Informational)**: Substantive architectural alignment, scale/performance optimizations, and robust test suites (`REVIEW.md §1.3`).
- **Findings**: Categorized by Severity (Critical/High/Medium/Low), Affected Files, Block Decision, Concrete Execution Path, and Recommended Remediation.
- **Verification & Missing Tests**: Unit/integration tests required to prevent future regressions.
- **Deployment Prerequisites**: Database migrations, environment secrets, and cross-client coordination needed.
