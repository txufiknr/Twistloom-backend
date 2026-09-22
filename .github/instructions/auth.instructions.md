---
applyTo: "src/middleware/auth*.ts, src/middleware/nextauth*.ts, src/routes/auth*.ts, src/routes/payments*.ts"
---

# Auth & Session Instructions

See `AGENTS.md` for the full security invariants. This file adds path-specific context for authentication, authorization, and session management files.

## Common Pitfalls

- `verifyNextAuthToken` performs JWE decryption + lookups on every request — cache the resolved `{ userId, sessionId }` in a short-TTL LRU keyed by SHA-256 hash of the raw token.
- Invalidate session cache immediately on logout.
- Authentication proves identity; authorization decides whether that identity may perform an operation. Do not treat possession of an identifier as authorization.
- Guest/authenticated migration semantics must be preserved — not every reader has a logged-in account.
- Payment webhook handlers must tolerate retries and verify idempotency before processing.
- Rate limiting for auth endpoints uses Upstash Redis atomic ops — never in-memory counters.
