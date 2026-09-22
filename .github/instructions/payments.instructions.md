---
applyTo: "src/services/credits.ts, src/config/credits.ts, src/routes/payments.ts, src/services/gateways/**/*.ts"
---

# Payments & Credits Instructions

See `AGENTS.md` for the full financial integrity invariants. This file adds path-specific context for credits, payment gateways, and webhook handling.

## Credits Integrity

- Credits represent user value — any deduction or refund must preserve transactional correctness and idempotency.
- Use `executeWithCredits` for all credit-consuming operations — it acquires a row-level lock (`SELECT ... FOR UPDATE`).
- Pass `tx` to ALL internal database operations inside `executeWithCredits` callbacks.
- Never bypass `executeWithCredits` with direct `dbWrite` credit updates.
- Activity logging goes OUTSIDE the transaction boundary so analytics errors never roll back purchases.

## Payment Gateways

- Twistloom supports Stripe and Xendit as gateway-agnostic payment providers.
- Check both gateways during status resolution to handle webhook delivery lag.
- Webhook handlers must tolerate retries — always verify idempotency.
- Payment-related updates must not overwrite `updatedAt` — it is a user-controlled profile field.

## Numeric Parsing

- Never use `parseInt` on decimal strings from Stripe — use `parseFloat`.
- Use `(a + b - 1n) / b` for BigInt ceiling division — PostgreSQL `ceil()` truncates on BigInt cast.

## Rate Limiting

- Never use in-memory counters for rate limiting in serverless — use Upstash Redis atomic ops.
- Always fail open if Redis is unavailable.

## Refunds

- Use `refundCreditsIdempotent` — it verifies against the `transactions` table before issuing refunds.
- Never issue blind refunds without idempotency verification.

## Logging

- Never log usernames, emails, or IPs in production payment flows.
- Use correlation IDs for tracing; log only non-PII metadata.
