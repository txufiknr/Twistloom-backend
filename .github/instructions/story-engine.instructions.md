---
applyTo: "src/services/story*.ts, src/utils/branch*.ts, src/utils/companion*.ts, src/config/story*.ts, src/cron/**/*.ts, src/routes/books*.ts, src/routes/pages*.ts"
---

# Story Engine Instructions

See `AGENTS.md` for the full architectural invariants. This file adds path-specific context for files in the story engine pipeline.

## Story Pipeline Scope

Story engine rules apply to the entire pipeline: route entry points (`src/routes/books*.ts`, `src/routes/pages*.ts`), services (`src/services/story*.ts`), utilities (`src/utils/branch*.ts`, `src/utils/companion*.ts`), configuration (`src/config/story*.ts`), and async generation (`src/cron/**/*.ts`).

## Common Pitfalls

- Route handlers must not contain story-state reconstruction logic — delegate to services.
- Cron jobs may run concurrently and must be idempotent — do not assume single execution.
- Branch traversal must be deterministic — same input always produces same output.
- Cache entries (LRU, Redis) are optimization, never canonical state.
