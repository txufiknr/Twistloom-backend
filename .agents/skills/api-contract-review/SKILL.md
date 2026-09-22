---
name: api-contract-review
description: >-
  Verify API route handlers follow Hono conventions, use typed context,
  preserve response contracts, and handle errors correctly.
metadata:
  author: twistloom
  version: "1.0"
---

# API Contract Review Skill

## Trigger
- New endpoint creation
- Existing endpoint modification
- API contract changes

## Procedure

1. **Route Handler Check**
   - Verify `AppEnv` typing on Hono apps and routers.
   - Verify thin route handlers (business logic in services).
   - Check error helpers (`cApiError`, `cValidationError`, etc.) are used.

2. **Import Check**
   - Verify all local imports use `.js` extensions.
   - Check for circular dependencies.
   - Verify no duplicate imports.

3. **Response Contract Check**
   - Verify response shape matches documented contracts.
   - Check no implementation details are leaked.
   - Verify backward compatibility.

4. **Input Validation**
   - Verify request input is validated.
   - Check sanitization via `sanitizeText` / `sanitizeBookTextField`.
   - Verify field length limits from `src/config/story.ts`.

5. **Report**
   - List findings with file:line references.
   - Categorize as Critical / Warning / Suggestion.
