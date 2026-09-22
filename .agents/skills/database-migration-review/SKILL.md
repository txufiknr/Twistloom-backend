---
name: database-migration-review
description: >-
  Review Drizzle schema changes for migration safety, backward compatibility,
  index implications, and Neon PostgreSQL compatibility.
metadata:
  author: twistloom
  version: "1.0"
---

# Database Migration Review Skill

## Trigger
- Any change to `src/db/schema.ts`
- Schema-related type changes
- Index modifications

## Procedure

1. **Schema Safety Check**
   - Verify changes are only in `src/db/schema.ts` and related types.
   - Verify `bun db:generate` and `bun db:migrate` are NOT run.
   - Check backward compatibility of column changes.

2. **Index Impact**
   - Check existing indexes are not accidentally dropped.
   - Verify new query patterns have appropriate indexes.
   - Check for N+1 query patterns.

3. **Type Compatibility**
   - Verify Drizzle schema types match application types.
   - Check for breaking changes in generated query types.
   - Verify no `any` types introduced.

4. **pgvector Check**
   - Verify embedding dimensions are unchanged.
   - Verify HNSW index semantics are preserved.
   - Check pgvector query compatibility.

5. **Report**
   - List findings with file:line references.
   - Categorize as Critical / Warning / Suggestion.
