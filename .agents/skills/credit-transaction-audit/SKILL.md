---
name: credit-transaction-audit
description: >-
  Audit credit consumption, refunds, and payment operations for
  transactional correctness, idempotency, and row locking compliance.
metadata:
  author: twistloom
  version: "1.0"
---

# Credit Transaction Audit Skill

## Trigger
- Any change to credit/payment code
- Pre-release verification of financial operations
- Payment gateway integration changes

## Procedure

1. **executeWithCredits Compliance**
   - Verify all credit-consuming operations use `executeWithCredits`.
   - Verify `tx` is passed to all internal DB operations.
   - Check no direct `dbWrite` credit updates bypass row locking.

2. **Transaction Boundary Check**
   - Verify external API calls are outside the transaction.
   - Verify activity logging is outside the transaction.
   - Check analytics errors cannot roll back purchases.

3. **Idempotency Check**
   - Verify webhook handlers tolerate retries.
   - Verify refunds use `refundCreditsIdempotent`.
   - Check `updatedAt` is not overwritten on payment updates.

4. **Numeric Safety**
   - Verify no `parseInt` on decimal strings.
   - Verify BigInt ceiling division uses `(a + b - 1n) / b`.
   - Check gateway-agnostic status resolution (both Stripe and Xendit).

5. **Security Check**
   - Verify no PII in production logs.
   - Verify correlation IDs used for tracing.
   - Check secrets not exposed in code or logs.

6. **Report**
   - List findings with file:line references.
   - Categorize as Critical / Warning / Suggestion.
