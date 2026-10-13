# Announcement Email Compatibility

> Living compatibility document · Twistloom Backend · 2026-10-13
> Status: **Implemented** · shared-schema deployment remains gated.
> Delivery authority: [Shared Email Delivery Architecture](./EMAIL_DELIVERY_ARCHITECTURE.md).

Announcement email now uses `email_campaigns` and `email_messages`, the same
tables, provider adapter, Redis admission and worker as other platform email.
The former announcement-specific campaign/delivery/provider-state schema and
SQL provider gate are superseded. New email features do not repeat those tables.

`src/services/announcement-email.ts` remains a domain producer: admin validation,
sanitization, preview, explicit resends and safe job projection. Campaign
insertion goes through `queueEmailCampaign`, shared with digests and publication.
Its admin status type uses the shared campaign union. Announcement-only provider,
configuration and dispatch forwarding files have been removed; other email
categories need no matching file bundle.

## Admin contract

Both admin compose and per-record email endpoints validate/sanitize content,
commit a frozen campaign snapshot, and return HTTP 202 with job ID, status and
aggregate counters. Dry-run returns HTTP 200 with an explicit audience count.
The preview count can scan the eligible audience; it is an admin action, not
a per-recipient worker query. No inline API fan-out occurs.

`GET /api/admin/announcements/email-jobs/:jobId` remains super-admin only.
`sent` means provider accepted; `emailSentAt` marks campaign terminal completion
including partial failures. Neither proves inbox delivery. Recipient addresses
and templates are absent from the aggregate response.

Normal retries reuse the original request identity. Deliberate record resends
require `force: true` and a fresh UUID `requestId`, reused on network retries.
Manual compose callers should supply a UUID; an omitted ID deduplicates by
author/content hash. Changing content under the same manual key is rejected.
Only one campaign may be open for a linked announcement.

## Execution and recovery

`POST /api/cron/announcement-emails` is retained as an authenticated shared-worker
alias. New scheduling uses `/api/cron/emails`, `email-worker`, and the shared
`EMAIL_DELIVERY_ENABLED`, `EMAIL_REQUESTS_PER_SECOND`, `EMAIL_CONCURRENCY` settings.
The old announcement-only environment variables no longer enable delivery.

Both URIs register the same handler and return the shared worker result:
`{ success: true, data: { processed, nextRunAt } }`, or
`{ success: true, pausedUntil }` during a provider pause. The legacy cron response
no longer includes an announcement `job`; use the admin progress endpoint for
that projection. Cron processing adds no announcement-specific status read.

Campaign pages contain at most 250 accounts. Delivery slices select at most 50
messages, with eight local send tasks by default and four QStash workers.
Provider requests have an eight-second timeout. The shared provider buckets govern
all platform email; Redis outages defer sends. Quota pauses preserve recipient
attempt budgets. Ambiguous sends retry their original key/payload only within
the six-attempt / 23-hour safety boundary. See architecture sections 4–6 for
exact claims, indexes, fairness and recovery-probe behavior.

Finalization locks announcement before campaign, matching draft deletion.
`ON DELETE SET NULL` retains a detached committed campaign. Provider requests
and QStash publication happen outside SQL transactions.

## Activation and validation

Provision the **shared** schema and schedules, configure Redis/encryption/provider
credentials, validate staging, then enable delivery. Inspect any already deployed
announcement jobs before migration and retain their keys, frozen payloads and
ambiguity clocks. Database generation/migration, live schedule registration,
live sends and commits were excluded from this task and were not performed.

The [architecture rollout procedure](./EMAIL_DELIVERY_ARCHITECTURE.md#7-privacy-retention-and-operational-rollout)
owns the complete activation order, retention policy and production evidence limits.
Local regressions use fake database rows and mocked provider/admission/dispatch;
real PostgreSQL contention, EXPLAIN and throughput are **Not claimed**.

## Adjacent broadcast and credit safeguards

Broadcast publication/edit/end uses a shared transaction advisory lock and the
existing paid-display/FIFO planner. Public broadcast/announcement caches use
validated versioned envelopes and invalidation revisions, with database fallback
on cache failure. These remain separate from email delivery; see
[Broadcast Architecture](./BROADCAST_ARCHITECTURE.md).

Time Travel still authorizes and conditionally updates the reader session inside
the credit transaction. Email consolidation does not change that credit authority.

## Related documents

- [Shared email roadmap](../roadmap/EMAIL_DELIVERY_ROADMAP.md)
- [Shared email architecture](./EMAIL_DELIVERY_ARCHITECTURE.md)
- [Admin API](../api/ADMIN_API_DOCUMENTATION.md)
