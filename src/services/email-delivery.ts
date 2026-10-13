/** Shared outbox and recipient state machine. EMAIL_DELIVERY_ARCHITECTURE.md §4. */
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { dbWrite, type DBTransaction } from "../db/client.js";
import { emailMessages as messages, emailCampaigns as campaigns, users, userAuth } from "../db/schema.js";
import { encryptPII, decryptPII } from "../utils/crypto.js";
import { generateId } from "../utils/uuid.js";
import { EMAIL_POLICIES, emailDeliveryEnabled, EMAIL_LEASE_MS, EMAIL_MAX_ATTEMPTS, EMAIL_SAFE_RETRY_MS,
  EMAIL_SEND_BATCH, EMAIL_WORK_BUDGET_MS, emailConcurrency, EMAIL_RETENTION_MS } from "../config/email-delivery.js";
import type { EmailPayload, EmailType, EmailMessageStatus, EmailDeliveryResult } from "../types/email-delivery.js";
import type { EmailLocale } from "../types/email-locale.js";
import { normalizeEmailPreferences } from "./email-preferences.js";
import { sendProviderEmail } from "../utils/email-provider.js";
import { acquireEmailPermit, recordEmailProviderResult, releaseEmailProbe } from "./email-gate.js";
import { dispatchEmailWorkers } from "./email-dispatch.js";

type Message = typeof messages.$inferSelect;
interface Completion { original: Message; final: Message }
interface AttemptOutcome { result: EmailDeliveryResult; retryAt?: Date; completion?: Completion }
export interface QueueEmailInput {
  type: EmailType; payload: EmailPayload; locale: EmailLocale; requestKey: string;
  userId?: string; expiresAt?: Date; credentialHash?: string;
}
export const emailContentHash = (value: string) => createHash("sha256").update(value).digest("hex");
export function requireEmailDelivery(): void {
  if (!emailDeliveryEnabled()) throw new Error("Shared email delivery is not configured");
}
export async function queueEmailMessage(input: QueueEmailInput, tx?: DBTransaction): Promise<string> {
  requireEmailDelivery();
  if (!input.requestKey || input.requestKey.length > 256) throw new Error("Invalid email request key");
  const connection = tx ?? dbWrite;
  const policy = EMAIL_POLICIES[input.type];
  if (policy.preference && !input.userId) throw new Error("Optional email requires a user identity");
  const [created] = await connection.insert(messages).values({ id: generateId(), requestKey: input.requestKey,
    type: input.type, priority: policy.priority, userId: input.userId ?? null, locale: input.locale,
    payloadEncrypted: await encryptPII(JSON.stringify(input.payload)), credentialHash: input.credentialHash ?? null,
    expiresAt: input.expiresAt ?? new Date(Date.now() + policy.lifetimeMs), status: "pending", attempts: 0,
    ambiguous: false, nextAttemptAt: new Date() }).onConflictDoNothing().returning({ id: messages.id });
  if (created) return created.id;
  const [existing] = await connection.select({ id: messages.id, type: messages.type, userId: messages.userId }).from(messages)
    .where(eq(messages.requestKey, input.requestKey)).limit(1);
  if (!existing) throw new Error("Email request conflict without receipt");
  if (existing.type !== input.type || (existing.userId ?? null) !== (input.userId ?? null)) throw new Error("Email request key belongs to another event identity");
  return existing.id;
}
function decodePayload(value: unknown): EmailPayload {
  if (typeof value !== "object" || value === null || !("to" in value) || typeof value.to !== "string"
    || !("from" in value) || typeof value.from !== "string" || !("subject" in value) || typeof value.subject !== "string"
    || !("html" in value) || typeof value.html !== "string") throw new Error("Invalid frozen email payload");
  return { to: value.to, from: value.from, subject: value.subject, html: value.html };
}
export function emailRetryLimit(attempts: number, firstAttemptAt: Date | null, ambiguous: boolean, now = new Date()): "failed" | "needs_review" | null {
  if (ambiguous && firstAttemptAt && now.getTime() - firstAttemptAt.getTime() >= EMAIL_SAFE_RETRY_MS) return "needs_review";
  return attempts >= EMAIL_MAX_ATTEMPTS ? (ambiguous ? "needs_review" : "failed") : null;
}
async function payloadFor(row: Message): Promise<EmailPayload> {
  if (row.payloadEncrypted) { const parsed: unknown = JSON.parse(await decryptPII(row.payloadEncrypted)); return decodePayload(parsed); }
  if (!row.campaignId || !row.recipientEncrypted) throw new Error("Email payload was removed");
  const [campaign] = await dbWrite.select({ templates: campaigns.templates }).from(campaigns).where(eq(campaigns.id, row.campaignId)).limit(1);
  const template = campaign?.templates[row.locale];
  if (!template) throw new Error("Frozen email template is missing");
  return { ...template, to: await decryptPII(row.recipientEncrypted) };
}
async function eligibility(row: Message, payload: EmailPayload): Promise<boolean> {
  const preference = EMAIL_POLICIES[row.type].preference;
  if (!preference && !row.credentialHash) return true;
  if (!row.userId) return false;
  const [user] = await dbWrite.select({ email: users.email, isNewUser: users.isNewUser, preferences: users.emailPreferences })
    .from(users).where(eq(users.userId, row.userId)).limit(1);
  if (!user || user.email !== payload.to) return false;
  if (preference && (user.isNewUser || !normalizeEmailPreferences(user.preferences)[preference])) return false;
  if (row.credentialHash || row.type === "story_published") {
    const [auth] = await dbWrite.select({ verification: userAuth.emailVerificationToken, reset: userAuth.passwordResetToken,
      verificationExpires: userAuth.emailVerificationExpires, resetExpires: userAuth.passwordResetExpires, verified: userAuth.emailVerified })
      .from(userAuth).where(eq(userAuth.userId, row.userId)).limit(1);
    if (row.type === "verification") return auth?.verification === row.credentialHash && Boolean(auth.verificationExpires && auth.verificationExpires > new Date());
    if (row.type === "password_reset") return auth?.reset === row.credentialHash && Boolean(auth.resetExpires && auth.resetExpires > new Date());
    if (row.type === "story_published") return Boolean(auth?.verified);
  }
  return true;
}

/** One conditional write records ownership and send intent; no campaign lock or open HTTP transaction. */
async function attempt(row: Message): Promise<AttemptOutcome> {
  const current = new Date();
  const recovered = row.status === "sending";
  const ambiguous = row.ambiguous || recovered;
  const terminal = emailRetryLimit(row.attempts, row.firstAttemptAt, ambiguous);
  let status: EmailMessageStatus | undefined = terminal ?? (row.expiresAt <= current ? (ambiguous ? "needs_review" : "skipped") : undefined);
  let patch: Partial<Message> = {};
  let permit: Awaited<ReturnType<typeof acquireEmailPermit>> | undefined;
  if (!status) {
    permit = await acquireEmailPermit(row.priority);
    if (!permit.allowed) return { result: { messageId: row.id, status: row.status }, retryAt: permit.retryAt };
  }
  const leaseToken = generateId();
  const [claimed] = await dbWrite.update(messages).set({ status: "sending", leaseToken, leaseExpiresAt: new Date(current.getTime() + EMAIL_LEASE_MS),
    ambiguous, attempts: row.attempts + (status ? 0 : 1), firstAttemptAt: row.firstAttemptAt ?? (status ? null : current) })
    .where(and(eq(messages.id, row.id), eq(messages.status, row.status),
      row.status === "sending" ? and(eq(messages.leaseToken, row.leaseToken ?? ""), lte(messages.leaseExpiresAt, current)) : lte(messages.nextAttemptAt, current)))
    .returning();
  if (!claimed) { if (permit?.allowed) await releaseEmailProbe(permit.probeToken); return { result: { messageId: row.id, status: row.status } }; }
  if (!status) {
    let payload: EmailPayload | null = null;
    try { payload = await payloadFor(claimed); }
    catch { status = "needs_review"; patch.lastError = "invalid_frozen_payload"; }
    if (!status && payload && !await eligibility(claimed, payload)) { status = ambiguous ? "needs_review" : "skipped"; patch.lastError = "recipient_ineligible_or_superseded"; }
    if (!status && payload && permit?.allowed) {
      const sent = await sendProviderEmail(payload, payload.to, claimed.requestKey);
      await recordEmailProviderResult(sent, permit.probeToken);
      if (sent.kind === "accepted") { status = "sent"; patch = { providerId: sent.providerId, ambiguous: false, lastError: null }; }
      else if (sent.kind === "paused") { status = "pending"; patch = { attempts: row.attempts, ambiguous,
        firstAttemptAt: ambiguous ? claimed.firstAttemptAt : null, nextAttemptAt: sent.retryAt, lastError: sent.code }; }
      else if (sent.kind === "retry") {
        const uncertain = ambiguous || sent.ambiguous;
        status = emailRetryLimit(claimed.attempts, claimed.firstAttemptAt, uncertain) ?? "pending";
        patch = { ambiguous: uncertain, firstAttemptAt: uncertain ? claimed.firstAttemptAt : null,
          nextAttemptAt: new Date(Date.now() + Math.min(3600, 30 * 2 ** (claimed.attempts - 1)) * 1000 + Math.floor(Math.random() * 1000)), lastError: sent.code };
      } else { status = ambiguous ? "needs_review" : sent.kind; patch.lastError = sent.code; }
    } else if (permit?.allowed) await releaseEmailProbe(permit.probeToken);
  }
  status ??= "needs_review";
  return { result: { messageId: row.id, status }, retryAt: status === "pending" ? patch.nextAttemptAt ?? new Date() : undefined,
    completion: { original: claimed, final: { ...claimed, ...patch, status, leaseToken: null, leaseExpiresAt: null } } };
}

/** One result UPDATE per wave, then one counter UPDATE per affected campaign. Ownership fences duplicates. */
async function persistCompletions(completions: Completion[]): Promise<void> {
  if (!completions.length) return;
  const value = (key: "status" | "attempts" | "ambiguous" | "firstAttemptAt" | "nextAttemptAt" | "providerId" | "lastError") =>
    sql`CASE ${messages.id} ${sql.join(completions.map(item => sql`WHEN ${item.original.id}::uuid THEN ${item.final[key]}`), sql` `)} ELSE ${messages[key]} END`;
  await dbWrite.transaction(async tx => {
    const changed = await tx.update(messages).set({ status: value("status"), attempts: value("attempts"), ambiguous: value("ambiguous"),
      firstAttemptAt: value("firstAttemptAt"), nextAttemptAt: value("nextAttemptAt"), providerId: value("providerId"), lastError: value("lastError"),
      leaseToken: null, leaseExpiresAt: null }).where(or(...completions.map(item => and(eq(messages.id, item.original.id),
        eq(messages.status, "sending"), eq(messages.leaseToken, item.original.leaseToken ?? "")))))
      .returning({ campaignId: messages.campaignId, status: messages.status });
    const groups = new Map<string, { sent: number; failed: number; skipped: number; needsReview: number; terminal: number }>();
    for (const row of changed) {
      if (!row.campaignId || row.status === "pending") continue;
      const counts = groups.get(row.campaignId) ?? { sent: 0, failed: 0, skipped: 0, needsReview: 0, terminal: 0 };
      counts.terminal++;
      if (row.status === "sent") counts.sent++;
      if (row.status === "failed") counts.failed++;
      if (row.status === "skipped") counts.skipped++;
      if (row.status === "needs_review") counts.needsReview++;
      groups.set(row.campaignId, counts);
    }
    // Stable order avoids cycles when two drains complete different campaigns in the same transaction.
    for (const [id, counts] of [...groups].sort(([a], [b]) => a.localeCompare(b))) await tx.update(campaigns).set({
      sent: sql`${campaigns.sent} + ${counts.sent}`, failed: sql`${campaigns.failed} + ${counts.failed}`,
      skipped: sql`${campaigns.skipped} + ${counts.skipped}`, needsReview: sql`${campaigns.needsReview} + ${counts.needsReview}`,
      pendingCount: sql`${campaigns.pendingCount} - ${counts.terminal}`, nextRunAt: new Date(),
    }).where(eq(campaigns.id, id));
  });
}

export async function deliverEmailNow(id: string): Promise<EmailDeliveryResult> {
  requireEmailDelivery();
  const [row] = await dbWrite.select().from(messages).where(eq(messages.id, id)).limit(1);
  if (!row) throw new Error("Email message not found");
  if (row.status !== "pending" && !(row.status === "sending" && row.leaseExpiresAt && row.leaseExpiresAt <= new Date())) return { messageId: id, status: row.status };
  const outcome = await attempt(row);
  await persistCompletions(outcome.completion ? [outcome.completion] : []);
  if (outcome.retryAt) await dispatchEmailWorkers(`message/${id}/${generateId()}`, 1, outcome.retryAt);
  return outcome.result;
}

/** Immediate path for the newest issued credential; intent was committed by its token utility. */
export async function deliverCredentialEmail(userId: string, type: "verification" | "password_reset"): Promise<boolean> {
  if (!emailDeliveryEnabled()) return false;
  const [row] = await dbWrite.select({ id: messages.id }).from(messages)
    .where(and(eq(messages.userId, userId), eq(messages.type, type))).orderBy(desc(messages.createdAt), desc(messages.id)).limit(1);
  return row ? (await deliverEmailNow(row.id)).status === "sent" : false;
}

/** Recovery and continuations share this bounded drain; PostgreSQL remains the only recipient retry authority. */
export async function processEmailMessages(): Promise<{ processed: number; nextRunAt: Date | null }> {
  requireEmailDelivery();
  const start = performance.now();
  const now = new Date();
  // Rotate one campaign per slice. A tiny cursor write per campaign
  // prevents a large, older campaign from owning the entire bulk backlog.
  const bulk = await dbWrite.transaction(async tx => {
    const selected = await tx.select({ id: campaigns.id }).from(campaigns).where(gt(campaigns.pendingCount, 0))
      .orderBy(asc(campaigns.nextDispatchAt), asc(campaigns.id)).for("update", { skipLocked: true }).limit(1);
    if (selected.length) await tx.update(campaigns).set({ nextDispatchAt: new Date(now.getTime() + 1000) })
      .where(inArray(campaigns.id, selected.map(row => row.id)));
    return selected;
  });
  // Independent partial indexes avoid an OR query sorting two status populations.
  const campaign = bulk[0];
  const [standalone, recovery, page] = await Promise.all([
    dbWrite.select().from(messages).where(and(sql`${messages.status} = 'pending'`, isNull(messages.campaignId), lte(messages.nextAttemptAt, now)))
      .orderBy(asc(messages.priority), asc(messages.nextAttemptAt), asc(messages.id)).limit(EMAIL_SEND_BATCH),
    dbWrite.select().from(messages).where(and(sql`${messages.status} = 'sending'`, lte(messages.leaseExpiresAt, now)))
      .orderBy(asc(messages.leaseExpiresAt), asc(messages.id)).limit(EMAIL_SEND_BATCH),
    campaign ? dbWrite.select().from(messages).where(and(eq(messages.campaignId, campaign.id),
      sql`${messages.status} = 'pending'`, lte(messages.nextAttemptAt, now)))
      .orderBy(asc(messages.nextAttemptAt), asc(messages.id)).limit(EMAIL_SEND_BATCH) : Promise.resolve([]),
  ]);
  // Campaigns rotate between slices; urgent standalone work takes precedence within a slice.
  const rows = [...standalone, ...recovery, ...page].sort((a, b) => a.priority - b.priority).slice(0, EMAIL_SEND_BATCH);
  let cursor = 0; let processed = 0; let retryAt: Date | null = null;
  const completions: Completion[] = [];
  const tasks = await Promise.allSettled(Array.from({ length: Math.min(rows.length, emailConcurrency()) }, async () => {
    while (performance.now() - start < EMAIL_WORK_BUDGET_MS - 12_000) {
      const row = rows[cursor++]; if (!row) return;
      const outcome = await attempt(row); processed++;
      if (outcome.completion) completions.push(outcome.completion);
      if (outcome.retryAt && (!retryAt || outcome.retryAt < retryAt)) retryAt = outcome.retryAt;
      if (outcome.retryAt && outcome.result.status === row.status) return;
    }
  }));
  await persistCompletions(completions);
  for (const task of tasks) if (task.status === "rejected") throw task.reason;
  // Match the priority-first pending index and each campaign's time-first index.
  const [nextStandalone, nextCampaign] = await Promise.all([
    dbWrite.select({ nextAttemptAt: messages.nextAttemptAt }).from(messages)
      .where(and(sql`${messages.status} = 'pending'`, isNull(messages.campaignId)))
      .orderBy(asc(messages.priority), asc(messages.nextAttemptAt), asc(messages.id)).limit(1),
    campaign ? dbWrite.select({ nextAttemptAt: messages.nextAttemptAt }).from(messages)
      .where(and(eq(messages.campaignId, campaign.id), sql`${messages.status} = 'pending'`))
      .orderBy(asc(messages.nextAttemptAt), asc(messages.id)).limit(1) : Promise.resolve([]),
  ]);
  const future = [retryAt, nextStandalone[0]?.nextAttemptAt, nextCampaign[0]?.nextAttemptAt]
    .filter((value): value is Date => value instanceof Date).sort((a, b) => a.getTime() - b.getTime());
  const nextRunAt = future[0] ?? null;
  if (nextRunAt) await dispatchEmailWorkers(`drain/${generateId()}`, 1, nextRunAt);
  return { processed, nextRunAt };
}

/** Bounded receipt retention. Credential payloads are scrubbed separately without dropping deduplication keys. */
export async function cleanupEmailMessages(): Promise<void> {
  const now = new Date();
  const scrub = dbWrite.select({ id: messages.id }).from(messages).where(and(lte(messages.expiresAt, now),
    or(sql`${messages.payloadEncrypted} IS NOT NULL`, sql`${messages.recipientEncrypted} IS NOT NULL`),
    or(sql`${messages.status} IN ('sent', 'failed', 'skipped')`, and(isNull(messages.campaignId), eq(messages.status, "needs_review")))))
    .orderBy(asc(messages.expiresAt), asc(messages.id)).limit(250);
  await dbWrite.update(messages).set({ payloadEncrypted: null, recipientEncrypted: null, credentialHash: null })
    .where(and(inArray(messages.id, scrub), or(sql`${messages.payloadEncrypted} IS NOT NULL`, sql`${messages.recipientEncrypted} IS NOT NULL`)));
  const old = dbWrite.select({ id: messages.id }).from(messages).where(and(lte(messages.createdAt, new Date(now.getTime() - EMAIL_RETENTION_MS)),
    sql`${messages.status} IN ('sent', 'failed', 'skipped', 'needs_review')`))
    .orderBy(asc(messages.createdAt), asc(messages.id)).limit(250);
  await dbWrite.delete(messages).where(inArray(messages.id, old));
  // Keep compact campaign receipts and event keys. Clear bulky shared content
  // only after every recipient receipt has aged out, including needs_review.
  const finished = await dbWrite.select({ id: campaigns.id }).from(campaigns)
    .where(and(lte(campaigns.completedAt, new Date(now.getTime() - EMAIL_RETENTION_MS)),
      sql`${campaigns.templates} <> '{}'::jsonb`)).orderBy(asc(campaigns.completedAt), asc(campaigns.id)).limit(25);
  for (const campaign of finished) {
    const [remaining] = await dbWrite.select({ id: messages.id }).from(messages).where(eq(messages.campaignId, campaign.id)).limit(1);
    if (!remaining) await dbWrite.update(campaigns).set({ templates: {} }).where(eq(campaigns.id, campaign.id));
  }
}
