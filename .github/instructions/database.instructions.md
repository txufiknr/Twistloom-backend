---
applyTo: "src/db/**/*.ts"
---

# Database-Specific Instructions

See `AGENTS.md` for the full architectural invariants. This file adds path-specific context for database schema, queries, and migrations.

## ORM & Database

- Use Drizzle ORM for all schema/query changes.
- Preserve Neon PostgreSQL compatibility (serverless, WebSocket connections).
- Use `dbRead` for read-only replica queries and `dbWrite` for write operations / transactions.
- Denormalized counters (`likesCount`, `readCount`, `favoritesCount`) are maintained via PostgreSQL triggers — do not add application-level COUNT(*) subqueries.

## Schema Changes

- Schema changes are made ONLY in `src/db/schema.ts` and related application types.
- **DO NOT** run `bun db:generate` or `bun db:migrate` automatically.
- The human developer reviews schema changes and runs migrations manually.
- Preserve forward-compatible schema design: typed columns over JSONB for queried/filtered/sorted fields.

## pgvector

- Preserve pgvector dimensions and HNSW index semantics.
- Do not modify embedding dimensions without explicit instruction.
- Semantic memory is supplementary, not authoritative over structured state.

## Performance

- Check query plans and index implications for performance-sensitive queries.
- Avoid N+1 queries — use Drizzle relational queries or batch loading.
- Preserve existing indexes unless necessary.
- Add indexes for new query patterns.
- **Bounded Batching & Keyset Cursor Pagination**: Never execute unbounded bulk inserts or unpaginated fan-out writes. Synchronous bulk writes must be sliced into bounded chunks (e.g. 250–500 rows) to stay well under the 65,535 PostgreSQL parameter wire-protocol ceiling ($rows \times columns \le 65,535$) and prevent serverless heap exhaustion. Bulk relational reads across unbounded sets must use Keyset Cursor Pagination (`WHERE id > $lastId ORDER BY id ASC LIMIT $chunk`) rather than `OFFSET` to avoid $O(N^2)$ table scan degradation and concurrent pagination drift.

## Migrations

- Migrations must be backward-safe.
- Never modify production data implicitly.
- Preserve existing column types and constraints unless explicitly changing them.
