---
applyTo: "src/middleware/auth*.ts, src/middleware/nextauth*.ts, src/routes/auth*.ts, src/routes/payments*.ts"
---

# Auth & Session Instructions

See `AGENTS.md` for the full security invariants. This file adds path-specific context for authentication, authorization, and session management files.

## Common Pitfalls

- `verifyNextAuthToken` may cache immutable JWE decoding in a short-TTL LRU keyed by the actual token-cookie names/chunks. Never cache authorization: every request freshly checks session existence, ownership and account standing against the primary store.
- Logout deletes authoritative session rows; no positive cache or read replica may bypass revocation. Clear actual plain/secure cookie chunks on rejection. Public password/Google exchanges must allow reauthentication with a stale cookie while independently verifying credentials.
- Authentication proves identity; authorization decides whether that identity may perform an operation. Do not treat possession of an identifier as authorization.
- Guest/authenticated migration semantics must be preserved — not every reader has a logged-in account.
- Payment webhook handlers must tolerate retries and verify idempotency before processing.
- Rate limiting for auth endpoints uses Upstash Redis atomic ops — never in-memory counters.
