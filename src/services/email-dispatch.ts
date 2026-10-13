/** Best-effort wakeups; the database outbox and minute supervisor remain authoritative. */
import { EMAIL_WORKERS, emailWorkerUrl, emailDeliveryEnabled } from "../config/email-delivery.js";

export async function dispatchEmailWorkers(dispatchId: string, count = 1, runAt = new Date()): Promise<boolean> {
  if (!emailDeliveryEnabled()) return false;
  const token = process.env.QSTASH_TOKEN;
  const secret = process.env.CRON_SECRET;
  const destination = emailWorkerUrl();
  if (!token || !secret || !destination) return false;
  const outcomes = await Promise.all(Array.from({ length: Math.min(count, EMAIL_WORKERS) }, async (_, index) => {
    try {
      const delay = Math.max(0, Math.ceil((runAt.getTime() - Date.now()) / 1000));
      const response = await fetch(`https://qstash.upstash.io/v2/publish/${destination}`, {
        method: "POST", body: "{}", signal: AbortSignal.timeout(4000),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Upstash-Method": "POST",
          "Upstash-Forward-Authorization": `Bearer ${secret}`, "Upstash-Retries": "3",
          "Upstash-Deduplication-Id": `${dispatchId}/${index}`, "Upstash-Flow-Control-Key": "email-workers",
          "Upstash-Flow-Control-Value": `parallelism=${EMAIL_WORKERS}`,
          ...(delay ? { "Upstash-Delay": `${delay}s` } : {}) },
      });
      return response.ok;
    } catch { return false; }
  }));
  if (outcomes.some(ok => !ok)) console.warn("Email wakeup failed; the scheduled supervisor will recover durable work.");
  return outcomes.every(Boolean);
}
